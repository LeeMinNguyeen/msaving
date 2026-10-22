"""Accounts in a book, with balances (the SUM of their entries, never stored).

An opening balance is an opening_balance transaction whose id is derived from the account's, so a retried create
can't add it twice. Liabilities are negative: a card with 450.00 owed opens at -45000.
"""
import uuid
from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.models import CurrencyCode, Name
from app.api.routes.v1.books import get_book, require_role
from app.domain.bills import Bill, bill_for
from app.domain.transactions import Entry, TxnIn, create_transaction

router = APIRouter(prefix="/books/{book_id}/accounts")

Kind = Literal["cash", "checking", "savings", "investment", "credit_card", "loan", "lent", "other_asset", "other_liability"]
Last4 = Annotated[str, StringConstraints(pattern=r"^[0-9]{4}$")]   # never a full card or account number
OPENING = uuid.UUID("4f1c2b8e-6a53-4c1e-9d0b-0b9a51f0c7a2")
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Money = Annotated[int, Field(ge=0, le=10**15)]
Day = Annotated[int, Field(ge=1, le=31)]
Rate = Annotated[int, Field(ge=0, le=100_000)]                      # hundredths of a percent a year: 5.5 % = 550

CARD_DETAILS = ("credit_limit", "annual_fee", "statement_day")
LOAN_DETAILS = ("installment", "installment_fee")
DETAILS = ("note", *CARD_DETAILS, "payment_due_day", *LOAN_DETAILS, "interest_rate_bp")
INTEREST_KINDS = {"savings", "credit_card", "loan", "lent"}


def detail_fits(field: str, kind: str) -> bool:
    if field in CARD_DETAILS:
        return kind == "credit_card"
    if field in LOAN_DETAILS:
        return kind == "loan"
    if field == "payment_due_day":
        return kind in ("credit_card", "loan")
    if field == "interest_rate_bp":
        return kind in INTEREST_KINDS
    return True


class Details(BaseModel):
    note: Note | None = None
    credit_limit: Money | None = None
    annual_fee: Money | None = None
    statement_day: Day | None = None
    payment_due_day: Day | None = None         # a card's repayment day, a loan's payment day
    installment: Annotated[int, Field(gt=0, le=10**15)] | None = None
    installment_fee: Money | None = None       # one-off, charged with the first payment
    interest_rate_bp: Rate | None = None

    def values(self, kind: str, only_sent: bool) -> dict:
        """The details to write for this kind: 422 for one sent that doesn't fit it, None for the others that don't."""
        out = {}
        for f in DETAILS:
            v = getattr(self, f)
            if f == "note" and v == "":
                v = None
            if not detail_fits(f, kind):
                if v is not None:
                    raise HTTPException(422, "invalid")
                out[f] = None
            elif not only_sent or f in self.model_fields_set:
                out[f] = v
        return out


def opening_balance_id(account_id: UUID) -> UUID:
    return uuid.uuid5(OPENING, str(account_id))


class Account(BaseModel):
    id: UUID
    name: str
    kind: Kind
    currency: str
    last4: str | None
    in_net_worth: bool
    contact_id: UUID | None
    note: str | None
    credit_limit: int | None
    annual_fee: int | None
    statement_day: int | None
    payment_due_day: int | None
    installment: int | None
    installment_fee: int | None
    interest_rate_bp: int | None
    archived_at: datetime | None
    version: int
    balance: int
    converted_balance: int | None    # in the book's currency at today's rate; None without a rate
    pinned: bool                     # on this user's Overview


ACCOUNT = ("select a.id, a.name, a.kind::text as kind, a.currency, a.last4, a.in_net_worth, a.contact_id, a.archived_at, a.version,"
           "       a.note, a.credit_limit, a.annual_fee, a.statement_day, a.payment_due_day, a.installment, a.installment_fee,"
           "       a.interest_rate_bp,"
           "       b.balance, bc.converted_balance, exists (select 1 from account_pins p where p.account_id = a.id) as pinned"
           "  from accounts a join account_balances b on b.account_id = a.id"
           "  left join book_balances_converted bc on bc.account_id = a.id"
           " where a.book_id = :book")


def get_account(db: Session, book_id: UUID, account_id: UUID) -> Account:
    row = db.execute(text(ACCOUNT + " and a.id = :a"), {"book": book_id, "a": account_id}).mappings().first()
    if row is None:
        raise HTTPException(404, "not_found")
    return Account(**row)


@router.get("")
def list_accounts(book_id: UUID, include_archived: bool = False, db: Session = Depends(get_db)) -> list[Account]:
    get_book(db, book_id)
    sql = ACCOUNT + ("" if include_archived else " and a.archived_at is null") + " order by a.created_at"
    return [Account(**r) for r in db.execute(text(sql), {"book": book_id}).mappings()]


class CreateAccount(Details):
    id: UUID                                   # generated by the client
    name: Name
    kind: Kind
    currency: CurrencyCode | None = None       # default: the book's currency
    last4: Last4 | None = None
    in_net_worth: bool = True
    contact_id: UUID | None = None             # lent and loan accounts only
    opening_balance: int = 0                   # signed
    opened_on: date | None = None              # the opening balance's date


@router.post("", status_code=201)
def create_account(book_id: UUID, body: CreateAccount, db: Session = Depends(get_db)) -> Account:
    require_role(get_book(db, book_id), "owner", "editor")
    details = body.values(body.kind, only_sent=False)
    n = db.execute(text("insert into accounts (id, book_id, name, kind, currency, last4, in_net_worth, contact_id, "
                        + ", ".join(details) + ") values (:i, :b, :n, cast(:k as account_kind), :c, :l4, :nw, :ct, "
                        + ", ".join(f":{f}" for f in details) + ") on conflict (id) do nothing"),
                   {"i": body.id, "b": book_id, "n": body.name, "k": body.kind, "c": body.currency,
                    "l4": body.last4, "nw": body.in_net_worth, "ct": body.contact_id, **details}).rowcount
    if n and body.opening_balance:
        create_transaction(db, TxnIn(id=opening_balance_id(body.id), book_id=book_id, type="opening_balance",
                                     occurred_on=body.opened_on or date.today(),
                                     entries=[Entry(body.id, body.opening_balance)]))
    db.commit()
    return get_account(db, book_id, body.id)


class UpdateAccount(Details):
    """Details: one left out stays as it is; one sent as null is cleared."""
    version: int
    name: Name | None = None
    kind: Kind | None = None
    currency: CurrencyCode | None = None       # only while the account has no transactions (currency_locked)
    last4: Last4 | Literal[""] | None = None   # "" clears it
    in_net_worth: bool | None = None
    contact_id: UUID | None = None
    no_contact: bool = False                   # true = unlink the person
    archived: bool | None = None


@router.patch("/{account_id}")
def update_account(book_id: UUID, account_id: UUID, body: UpdateAccount, db: Session = Depends(get_db)) -> Account:
    require_role(get_book(db, book_id), "owner", "editor")
    current = get_account(db, book_id, account_id)
    details = body.values(body.kind or current.kind, only_sent=True)
    n = db.execute(text("update accounts set name = coalesce(:n, name), kind = coalesce(cast(:k as account_kind), kind),"
                        + "".join(f" {f} = :{f}," for f in details) +
                        " currency = coalesce(:c, currency),"
                        " last4 = case when cast(:l4 as text) is null then last4 when cast(:l4 as text) = '' then null else cast(:l4 as text) end,"
                        " in_net_worth = coalesce(:nw, in_net_worth),"
                        " contact_id = case when cast(:noc as boolean) then null else coalesce(cast(:ct as uuid), contact_id) end,"
                        " archived_at = case when cast(:a as boolean) is null then archived_at when cast(:a as boolean) then coalesce(archived_at, now()) end"
                        " where id = :i and book_id = :b and version = :v"),
                   {"i": account_id, "b": book_id, "v": body.version, "n": body.name, "k": body.kind, "c": body.currency,
                    "l4": body.last4, "nw": body.in_net_worth, "ct": body.contact_id, "noc": body.no_contact,
                    "a": body.archived, **details}).rowcount
    if n == 0:
        raise HTTPException(409, "conflict")
    db.commit()
    return get_account(db, book_id, account_id)


@router.put("/{account_id}/pin", status_code=204)
def pin_account(book_id: UUID, account_id: UUID, db: Session = Depends(get_db)) -> Response:
    get_account(db, book_id, account_id)
    db.execute(text("insert into account_pins (account_id, book_id) values (:a, :b) on conflict do nothing"),
               {"a": account_id, "b": book_id})
    db.commit()
    return Response(status_code=204)


@router.delete("/{account_id}/pin", status_code=204)
def unpin_account(book_id: UUID, account_id: UUID, db: Session = Depends(get_db)) -> Response:
    get_account(db, book_id, account_id)
    db.execute(text("delete from account_pins where account_id = :a"), {"a": account_id})
    db.commit()
    return Response(status_code=204)


@router.get("/{account_id}/bill")
def account_bill(book_id: UUID, account_id: UUID, db: Session = Depends(get_db)) -> Bill | None:
    """Null for an account with no bill: not a card or a loan, or missing what a bill needs."""
    book = get_book(db, book_id)
    return bill_for(db, get_account(db, book_id, account_id), datetime.now(ZoneInfo(book.timezone)).date())
