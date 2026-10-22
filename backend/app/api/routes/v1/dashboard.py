"""Amounts are in the book's currency unless a row says otherwise; *not_converted and missing_rates count what had no
exchange rate and was left out of a total."""
from datetime import date, time
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.routes.v1.books import get_book
from app.domain.dashboard import dashboard

router = APIRouter()


class Month(BaseModel):
    month: date
    spent: int
    income: int
    not_converted: int


class CategorySpend(BaseModel):
    category_id: UUID | None             # None = no category ("Uncategorized", translated by the app)
    category: str
    category_parent_id: UUID | None
    spent: int
    not_converted: int


class Budget(BaseModel):
    budget_id: UUID
    category_id: UUID
    category: str
    period: str
    period_start: date
    period_end: date
    budget: int
    spent: int
    remaining: int
    percent_used: float | None
    not_converted: int


class AccountRow(BaseModel):
    account_id: UUID
    name: str
    kind: str
    currency: str
    balance: int                         # in the account's own currency
    converted_balance: int | None        # in the book's currency at today's rate; None = no rate
    in_net_worth: bool
    pinned: bool


class PersonRow(BaseModel):
    contact_id: UUID
    name: str
    currency: str
    owed_to_you: int
    you_owe: int


class RecentTxn(BaseModel):
    id: UUID
    type: str
    occurred_on: date
    occurred_time: time
    payee: str | None
    category: str | None
    amount: int | None                   # in its own currency; a transfer shows the amount moved out
    currency: str | None


class Dashboard(BaseModel):
    currency: str | None
    rates_source: str | None             # e.g. open.er-api.com, whose terms ask for a visible credit
    net_worth: int
    net_worth_missing_rates: int
    spent_this_month: int
    spent_last_month: int
    income_this_month: int
    cashflow_6_months: list[Month]
    top_categories_this_month: list[CategorySpend]
    budgets: list[Budget]
    accounts: list[AccountRow]
    people: list[PersonRow]
    recent_transactions: list[RecentTxn]


@router.get("/books/{book_id}/dashboard")
def read_dashboard(book_id: UUID, db: Session = Depends(get_db)) -> Dashboard:
    get_book(db, book_id)
    return Dashboard(**dashboard(db, book_id))
