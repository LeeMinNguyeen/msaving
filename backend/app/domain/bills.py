"""Monthly bills, worked out from the transactions whenever they're asked for.

A credit card's bill is its statement balance, as a bank counts it: what the card owed at the end of its last
statement date (that day's transactions included; a month without that day uses its last day), earlier unpaid
amounts included, minus all the money in since. It's due on the first repayment day after the statement date.

A purchase on a card paid in installments stays one expense for its full amount; the bill leaves out the part of
it no statement has billed yet. Each statement bills one installment per plan (the last takes what's left, and a plan
ended early bills everything left on the next statement), with the plan's fee all on the first installment's bill or
split into each. A fee no Pay has recorded yet stays on the bill.

A loan's bill is its monthly installment, due on its next payment day (today included); payments since the previous
payment day count. An installment fee is added once, to the first payment. With an interest rate, the month's
interest (what was owed before this period's payments, times the rate, over 12) is the part of the installment
recorded as an expense on the loan, so the loan goes down by the principal only. A missed installment isn't carried
over.
"""
import calendar
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

FEE = uuid.UUID("9a1f4c2e-5b7d-4e8a-b3c6-2d0e8f1a7c45")
INTEREST = uuid.UUID("3c7e9d1a-8f2b-4a6c-9e5d-1b4f7a2c8e60")
INSTALLMENT_FEE = uuid.UUID("6e2b8f4a-1c9d-4b7e-a5f3-8d0c2e6a9b14")


def fee_transaction_id(account_id: UUID) -> UUID:
    """The id of a loan's installment fee: charged once, so paying again can't add it twice."""
    return uuid.uuid5(FEE, str(account_id))


def interest_transaction_id(account_id: UUID, due_on: date) -> UUID:
    """The id of a loan's interest for the installment due that day: one per month, even when it's paid in parts."""
    return uuid.uuid5(INTEREST, f"{account_id}:{due_on.isoformat()}")


def installment_fee_transaction_id(plan_id: UUID, number: int) -> UUID:
    """The id of a plan's fee (number 1 when charged at once) or of the part billed with that installment."""
    return uuid.uuid5(INSTALLMENT_FEE, f"{plan_id}:{number}")


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


def parts(total: int, n: int) -> list[int]:
    """total in n equal parts of whole minor units; the last takes the remainder."""
    each = total // n
    return [each] * (n - 1) + [total - each * (n - 1)]


def _statement(first_statement: date, number: int, statement_day: int) -> date:
    m = first_statement.month - 1 + number - 1
    return _on(first_statement.year + m // 12, m % 12 + 1, statement_day)


def billed(plan, statement_day: int, closed: date) -> int:
    """How many installments the statements up to `closed` have billed."""
    if plan.ended_on and plan.ended_on <= closed:
        return plan.months
    return sum(_statement(plan.first_statement, k, statement_day) <= closed for k in range(1, plan.months + 1))


PLANS = """
select p.id, p.account_id, p.transaction_id, t.payee, t.occurred_on, -e.amount as amount, p.months, p.converted_on,
       p.first_statement, p.fee, p.fee_split, p.counts_toward_limit, p.ended_on, p.version, a.statement_day
  from installment_plans p join transactions t on t.id = p.transaction_id
  join entries e on e.transaction_id = t.id join accounts a on a.id = p.account_id"""


def installment_plans(db: Session, book_id: UUID, today: date) -> list[dict]:
    """A book's plans with what's billed so far, as of the last statement before `today`."""
    out = []
    for p in db.execute(text(PLANS + " where p.book_id = :b order by t.occurred_on, t.created_at"), {"b": book_id}).mappings():
        shares = parts(p["amount"], p["months"])
        done = billed(SimpleNamespace(**p), p["statement_day"], last_statement(today, p["statement_day"]))
        out.append({k: v for k, v in p.items() if k != "statement_day"} | {
            "installment": shares[0], "billed": done, "left_to_bill": p["amount"] - sum(shares[:done])})
    return out


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
    installments: list[dict] = field(default_factory=list)   # card: this statement's, {plan_id, transaction_id, payee, number, months, amount}
    fees: list[dict] = field(default_factory=list)           # card: installment fees to record, {plan_id, transaction_id, payee, amount}
    limit_used: int | None = None                            # card: owed now, less what plans that don't count haven't billed


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
        " order by t.occurred_on desc, t.occurred_time desc, t.created_at desc limit 1"), {"a": account_id}).scalar()


def bill_for(db: Session, account, today: date) -> Bill | None:
    """`today` is the book's date. None when the account has no bill: not a card or a loan, or missing a card's
    statement and repayment days or a loan's installment and payment day."""
    a = account.id
    owed_now = max(0, -account.balance)
    if account.kind == "credit_card" and account.statement_day and account.payment_due_day:
        day = account.statement_day
        closed = last_statement(today, day)
        before = last_statement(closed, day)
        owed = max(0, -_sum(db, "t.occurred_on <= :d", a=a, d=closed))
        paid = _sum(db, "e.amount > 0 and t.occurred_on > :d", a=a, d=closed)
        unbilled = not_counted = 0
        lines, fees = [], []
        for p in db.execute(text(PLANS + " where p.account_id = :a"), {"a": a}).mappings():
            plan = SimpleNamespace(**p)
            if plan.occurred_on > closed:
                if not plan.counts_toward_limit and plan.occurred_on <= today:
                    not_counted += plan.amount
                continue
            shares = parts(plan.amount, plan.months)
            done, done_before = billed(plan, day, closed), billed(plan, day, before)
            left = plan.amount - sum(shares[:done])
            unbilled += left
            if not plan.counts_toward_limit:
                not_counted += left
            if done > done_before:
                lines.append({"plan_id": plan.id, "transaction_id": plan.transaction_id, "payee": plan.payee,
                              "number": done, "months": plan.months, "amount": sum(shares[done_before:done])})
            if plan.fee:
                fee_parts = parts(plan.fee, plan.months) if plan.fee_split else [plan.fee]
                for number in range(1, min(done, len(fee_parts)) + 1):
                    fee_id = installment_fee_transaction_id(plan.id, number)
                    if not _exists(db, fee_id):
                        fees.append({"plan_id": plan.id, "transaction_id": fee_id, "payee": plan.payee, "amount": fee_parts[number - 1]})
        fee = sum(f["amount"] for f in fees)
        amount = max(0, owed - unbilled) + fee
        return Bill(kind="card", period_start=before + timedelta(days=1), period_end=closed,
                    due_on=first_after(closed, account.payment_due_day), amount=amount, paid=paid,
                    remaining=max(0, amount - paid), owed_now=owed_now, interest=0, interest_transaction_id=None, fee=fee,
                    fee_transaction_id=None, pay_from=_last_payer(db, a), installments=lines, fees=fees,
                    limit_used=max(0, owed_now - not_counted))
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
