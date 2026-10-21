"""Monthly bills, worked out from the transactions whenever they're asked for.

A credit card's bill is its statement balance, as a bank counts it: what the card owed at the end of its last
statement date (that day's transactions included; a month without that day uses its last day), earlier unpaid
amounts included, minus all the money in since. It's due on the first repayment day after the statement date.

A loan's bill is its monthly installment, due on its next payment day (today included); payments since the previous
payment day count. An installment fee is added once, to the first payment. With an interest rate, the month's
interest (what was owed before this period's payments, times the rate, over 12) is the part of the installment
recorded as an expense on the loan, so the loan goes down by the principal only. A missed installment isn't carried
over.
"""
import calendar
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

FEE = uuid.UUID("9a1f4c2e-5b7d-4e8a-b3c6-2d0e8f1a7c45")
INTEREST = uuid.UUID("3c7e9d1a-8f2b-4a6c-9e5d-1b4f7a2c8e60")


def fee_transaction_id(account_id: UUID) -> UUID:
    """The id of a loan's installment fee: charged once, so paying again can't add it twice."""
    return uuid.uuid5(FEE, str(account_id))


def interest_transaction_id(account_id: UUID, due_on: date) -> UUID:
    """The id of a loan's interest for the installment due that day: one per month, even when it's paid in parts."""
    return uuid.uuid5(INTEREST, f"{account_id}:{due_on.isoformat()}")


def _on(year: int, month: int, day: int) -> date:
    """That day of the month, or the month's last day when it has fewer."""
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _month_before(d: date, day: int) -> date:
    return _on(d.year - (d.month == 1), 12 if d.month == 1 else d.month - 1, day)


def _month_after(d: date, day: int) -> date:
    return _on(d.year + (d.month == 12), 1 if d.month == 12 else d.month + 1, day)


def last_statement(today: date, statement_day: int) -> date:
    """The last statement date that has closed: strictly before today (the statement day itself is still open)."""
    at = _on(today.year, today.month, statement_day)
    return at if at < today else _month_before(today, statement_day)


def first_after(d: date, day: int) -> date:
    """The first date after d that falls on that day of the month."""
    at = _on(d.year, d.month, day)
    return at if at > d else _month_after(d, day)


def next_on_or_after(d: date, day: int) -> date:
    at = _on(d.year, d.month, day)
    return at if at >= d else _month_after(d, day)


@dataclass
class Bill:
    kind: str                  # card or loan
    period_start: date         # card: the statement's first day; loan: the day after the previous payment day
    period_end: date           # card: the statement date; loan: the payment day
    due_on: date
    amount: int                # what the bill asks for, positive
    paid: int                  # money in since the period started (card: since the statement date)
    remaining: int
    owed_now: int
    interest: int              # loan: the part of the installment that's interest, to record as an expense (0 once recorded)
    interest_transaction_id: UUID | None
    fee: int                   # loan: the installment fee added to this payment (0 once charged)
    fee_transaction_id: UUID | None
    pay_from: UUID | None      # the account the last payment came from


def _sum(db: Session, sql: str, **params) -> int:
    return int(db.execute(text(
        "select coalesce(sum(e.amount), 0) from entries e join transactions t on t.id = e.transaction_id"
        " where e.account_id = :a and " + sql), params).scalar())


def _exists(db: Session, transaction_id: UUID) -> bool:
    return bool(db.execute(text("select exists (select 1 from transactions where id = :i)"), {"i": transaction_id}).scalar())


def _last_payer(db: Session, account_id: UUID) -> UUID | None:
    return db.execute(text(
        "select o.account_id from entries e join transactions t on t.id = e.transaction_id"
        "  join entries o on o.transaction_id = t.id and o.account_id <> e.account_id"
        " where e.account_id = :a and e.amount > 0 and t.type = 'transfer'"
        " order by t.occurred_on desc, t.created_at desc limit 1"), {"a": account_id}).scalar()


def bill_for(db: Session, account, today: date) -> Bill | None:
    """`today` is the book's date. None when the account has no bill: not a card or a loan, or missing a card's
    statement and repayment days or a loan's installment and payment day."""
    a = account.id
    owed_now = max(0, -account.balance)
    if account.kind == "credit_card" and account.statement_day and account.payment_due_day:
        closed = last_statement(today, account.statement_day)
        owed = max(0, -_sum(db, "t.occurred_on <= :d", a=a, d=closed))
        paid = _sum(db, "e.amount > 0 and t.occurred_on > :d", a=a, d=closed)
        return Bill(kind="card", period_start=last_statement(closed, account.statement_day) + timedelta(days=1),
                    period_end=closed, due_on=first_after(closed, account.payment_due_day), amount=owed, paid=paid,
                    remaining=max(0, owed - paid), owed_now=owed_now, interest=0, interest_transaction_id=None, fee=0,
                    fee_transaction_id=None, pay_from=_last_payer(db, a))
    if account.kind == "loan" and account.installment and account.payment_due_day:
        due = next_on_or_after(today, account.payment_due_day)
        before = _month_before(due, account.payment_due_day)
        paid = _sum(db, "e.amount > 0 and t.occurred_on > :d", a=a, d=before)
        charged = -_sum(db, "e.amount < 0 and t.type = 'expense' and t.occurred_on > :d", a=a, d=before)
        owed_before = max(0, owed_now + paid - charged)        # before this period's payments and charges
        interest = round(owed_before * (account.interest_rate_bp or 0) / 120_000)
        installment = min(account.installment, owed_before + interest)
        fee_id, interest_id = fee_transaction_id(a), interest_transaction_id(a, due)
        fee = (account.installment_fee or 0) if owed_before and not _exists(db, fee_id) else 0
        to_record = 0 if _exists(db, interest_id) else min(interest, installment)
        amount = installment + fee
        return Bill(kind="loan", period_start=before + timedelta(days=1), period_end=due, due_on=due, amount=amount,
                    paid=paid, remaining=max(0, amount - paid), owed_now=owed_now, interest=to_record,
                    interest_transaction_id=interest_id if to_record else None, fee=fee,
                    fee_transaction_id=fee_id if fee else None, pay_from=_last_payer(db, a))
    return None
