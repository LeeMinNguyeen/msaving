"""The shape rules (a transfer has two entries, an expense is negative) are checked by the database when the route
commits."""
import base64
import json
from datetime import date, datetime, time
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.routes.v1.books import get_book, require_role
from app.domain.transactions import Entry as EntryIn
from app.domain.transactions import TxnIn, create_transaction, delete_transaction, update_transaction

router = APIRouter(prefix="/books/{book_id}/transactions")

Type = Literal["expense", "income", "refund", "transfer", "opening_balance", "adjustment"]
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class Entry(BaseModel):
    account_id: UUID
    amount: int                                # signed, in the account's currency
    currency: str | None = None                # filled in on the way out


class Transaction(BaseModel):
    id: UUID
    type: Type
    occurred_on: date
    occurred_time: time
    category_id: UUID | None
    payee: str | None
    note: str | None
    entries: list[Entry]
    version: int
    created_at: datetime
    modified_at: datetime
    created_by: str | None                     # username, or "Deleted user" (the app translates it)
    modified_by: str | None
    running_balance: int | None = None         # only when the list is filtered to one account


SELECT = """
select t.id, t.type::text as type, t.occurred_on, t.occurred_time, t.category_id, t.payee, t.note, t.version, t.created_at, t.modified_at,
       (select p.name from book_people p where p.book_id = t.book_id and p.user_id = t.created_by) as created_by,
       (select p.name from book_people p where p.book_id = t.book_id and p.user_id = t.modified_by) as modified_by,
       coalesce((select jsonb_agg(jsonb_build_object('account_id', e.account_id, 'amount', e.amount, 'currency', a.currency)
                                  order by e.amount)
                   from entries e join accounts a on a.id = e.account_id where e.transaction_id = t.id), '[]') as entries
"""


def get_transaction(db: Session, book_id: UUID, txn_id: UUID) -> Transaction:
    row = db.execute(text(SELECT + " from transactions t where t.book_id = :b and t.id = :t"),
                     {"b": book_id, "t": txn_id}).mappings().first()
    if row is None:
        raise HTTPException(404, "not_found")
    return Transaction(**row)


class Page(BaseModel):
    items: list[Transaction]
    next: str | None                           # pass as `after` for the next page


def _cursor(t: Transaction) -> str:
    raw = json.dumps([t.occurred_on.isoformat(), t.occurred_time.isoformat(), t.created_at.isoformat(), str(t.id)])
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _uncursor(c: str) -> tuple[date, time, datetime, UUID]:
    try:
        on, tm, at, i = json.loads(base64.urlsafe_b64decode(c.encode()))
        return date.fromisoformat(on), time.fromisoformat(tm), datetime.fromisoformat(at), UUID(i)
    except (ValueError, TypeError):
        raise HTTPException(422, "invalid") from None


@router.get("")
def list_transactions(
    book_id: UUID,
    account_id: UUID | None = None,
    category_id: UUID | None = None,           # includes its sub-categories
    type: Type | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    q: Annotated[str | None, Query(max_length=100)] = None,     # in payee or note
    after: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    db: Session = Depends(get_db),
) -> Page:
    get_book(db, book_id)
    c_on, c_tm, c_at, c_id = _uncursor(after) if after else (None, None, None, None)
    rows = db.execute(text(SELECT + """,
       r.running_balance
  from transactions t
  left join (select e.transaction_id,
                    sum(e.amount) over (order by t2.occurred_on, t2.occurred_time, t2.created_at, t2.id rows unbounded preceding) as running_balance
               from entries e join transactions t2 on t2.id = e.transaction_id
              where e.account_id = cast(:acc as uuid)) r on r.transaction_id = t.id
 where t.book_id = :b
   and (cast(:acc as uuid) is null or exists (select 1 from entries e where e.transaction_id = t.id and e.account_id = cast(:acc as uuid)))
   and (cast(:cat as uuid) is null or t.category_id in (select category_id from category_ancestors where ancestor_id = cast(:cat as uuid)))
   and (cast(:type as text) is null or t.type = cast(:type as txn_type))
   and (cast(:from as date) is null or t.occurred_on >= cast(:from as date))
   and (cast(:to as date) is null or t.occurred_on <= cast(:to as date))
   and (cast(:q as text) is null
        or position(lower(cast(:q as text)) in lower(coalesce(t.payee, '') || ' ' || coalesce(t.note, ''))) > 0)
   and (cast(:c_on as date) is null
        or (t.occurred_on, t.occurred_time, t.created_at, t.id)
           < (cast(:c_on as date), cast(:c_tm as time), cast(:c_at as timestamptz), cast(:c_id as uuid)))
 order by t.occurred_on desc, t.occurred_time desc, t.created_at desc, t.id desc
 limit :n"""), {"b": book_id, "acc": account_id, "cat": category_id, "type": type, "from": date_from, "to": date_to,
                "q": q.strip() if q and q.strip() else None, "c_on": c_on, "c_tm": c_tm, "c_at": c_at, "c_id": c_id,
                "n": limit + 1}).mappings().all()
    items = [Transaction(**r) for r in rows[:limit]]
    return Page(items=items, next=_cursor(items[-1]) if len(rows) > limit else None)


class TxnBody(BaseModel):
    type: Type
    occurred_on: date
    occurred_time: time | None = None          # none: 00:00 on a new one, unchanged on an edit
    entries: list[Entry] = Field(min_length=1, max_length=2)
    category_id: UUID | None = None
    payee: Text | None = None
    note: Text | None = None

    def to_domain(self, txn_id: UUID, book_id: UUID) -> TxnIn:
        return TxnIn(id=txn_id, book_id=book_id, type=self.type, occurred_on=self.occurred_on, occurred_time=self.occurred_time,
                     entries=[EntryIn(e.account_id, e.amount) for e in self.entries],
                     category_id=self.category_id, payee=self.payee or None, note=self.note or None)


class CreateTxn(TxnBody):
    id: UUID                                   # generated by the client when the user taps Save


@router.post("", status_code=201)
def create(book_id: UUID, body: CreateTxn, db: Session = Depends(get_db)) -> Transaction:
    require_role(get_book(db, book_id), "owner", "editor")
    create_transaction(db, body.to_domain(body.id, book_id))
    db.commit()
    return get_transaction(db, book_id, body.id)


class Suggestion(BaseModel):
    account_id: UUID
    category_id: UUID | None
    payee: str | None


SUGGEST = """
select e.account_id, t.category_id, t.payee
  from transactions t join entries e on e.transaction_id = t.id join books b on b.id = t.book_id
 where t.book_id = :b and t.type = cast(:ty as txn_type) and t.created_by = current_app_user()
   and t.occurred_on >= (now() at time zone b.timezone)::date - 90
   and abs(e.amount) between :lo and :hi
   and (select count(*) from entries x where x.transaction_id = t.id) = 1
 order by t.occurred_on desc, t.occurred_time desc, t.created_at desc
 limit 3"""


@router.get("/suggest")
def suggest(book_id: UUID, type: Literal["expense", "income"], amount: Annotated[int, Query(gt=0)],
            db: Session = Depends(get_db)) -> Suggestion | None:
    """From this user's own transactions of the type, within 10 % of the amount, in the last 90 days: what makes up at
    least 2 of the last 3, or null."""
    get_book(db, book_id)
    rows = [tuple(r) for r in db.execute(text(SUGGEST), {"b": book_id, "ty": type, "lo": amount * 9 // 10,
                                                          "hi": amount * 11 // 10}).all()]
    best = max(set(rows), key=rows.count, default=None)
    if best is None or rows.count(best) < 2:
        return None
    return Suggestion(account_id=best[0], category_id=best[1], payee=best[2])


@router.get("/{txn_id}")
def read(book_id: UUID, txn_id: UUID, db: Session = Depends(get_db)) -> Transaction:
    get_book(db, book_id)
    return get_transaction(db, book_id, txn_id)


class UpdateTxn(TxnBody):
    version: int


@router.put("/{txn_id}")
def update(book_id: UUID, txn_id: UUID, body: UpdateTxn, db: Session = Depends(get_db)) -> Transaction:
    """Replaces the whole transaction (header and entries)."""
    require_role(get_book(db, book_id), "owner", "editor")
    update_transaction(db, body.to_domain(txn_id, book_id), body.version)
    db.commit()
    return get_transaction(db, book_id, txn_id)


@router.delete("/{txn_id}", status_code=204)
def delete(book_id: UUID, txn_id: UUID, version: int, db: Session = Depends(get_db)) -> Response:
    require_role(get_book(db, book_id), "owner", "editor")
    delete_transaction(db, txn_id, version)
    db.commit()
    return Response(status_code=204)


class HistoryEntry(BaseModel):
    version: int
    action: Literal["created", "edited", "deleted"]
    changed_at: datetime
    changed_by: str | None                     # username, or "Deleted user"
    type: Type
    occurred_on: date
    occurred_time: time | None                 # none: saved before times were kept
    category_id: UUID | None
    payee: str | None
    note: str | None
    entries: list[Entry] | None                # not recorded on a delete


@router.get("/{txn_id}/history")
def history(book_id: UUID, txn_id: UUID, db: Session = Depends(get_db)) -> list[HistoryEntry]:
    """Every saved version, oldest first; kept after the transaction is deleted."""
    get_book(db, book_id)
    rows = db.execute(text(
        "select h.version, h.action, h.changed_at, h.snapshot,"
        "       (select p.name from book_people p where p.book_id = h.book_id and p.user_id = h.changed_by) as changed_by"
        "  from transaction_history h where h.book_id = :b and h.transaction_id = :t order by h.id"),
        {"b": book_id, "t": txn_id}).mappings().all()
    if not rows:
        raise HTTPException(404, "not_found")
    return [HistoryEntry(version=r["version"], action=r["action"], changed_at=r["changed_at"], changed_by=r["changed_by"],
                         type=r["snapshot"]["type"], occurred_on=r["snapshot"]["occurred_on"],
                         occurred_time=r["snapshot"].get("occurred_time"),
                         category_id=r["snapshot"].get("category_id"), payee=r["snapshot"].get("payee"),
                         note=r["snapshot"].get("note"), entries=r["snapshot"].get("entries")) for r in rows]
