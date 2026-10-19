"""Home screen: everything the dashboard shows, in one API call.

GET /v1/books/{book_id}/dashboard -> dashboard(db, book_id)
Runs inside user_session(), so every query is already limited to the
signed-in user by row-level security. Amounts are int minor units of the
book's base currency.
"""
from datetime import date
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


def _month_start(d: date, months_back: int = 0) -> date:
    m = d.year * 12 + d.month - 1 - months_back
    return date(m // 12, m % 12 + 1, 1)


def dashboard(db: Session, book_id: UUID, today: date | None = None) -> dict:
    # The book's own date, as budgets use, not the server's.
    today = today or db.execute(text("select (now() at time zone timezone)::date from books where id = :b"),
                                {"b": book_id}).scalar() or date.today()
    this_month, last_month, six_back = _month_start(today), _month_start(today, 1), _month_start(today, 5)
    p = {"b": book_id, "this": this_month, "last": last_month, "six": six_back}

    def rows(sql: str):
        return [dict(r) for r in db.execute(text(sql), p).mappings()]

    nw = db.execute(text("select base_currency, net_worth, missing_rates from book_net_worth where book_id = :b"), p).mappings().first()
    cashflow = rows("select month, spent, income, not_converted from book_monthly_cashflow"
                    " where book_id = :b and month >= :six order by month")
    by_month = {r["month"]: r for r in cashflow}
    return {
        "currency": nw["base_currency"] if nw else None,
        "net_worth": nw["net_worth"] if nw else 0,
        "net_worth_missing_rates": nw["missing_rates"] if nw else 0,
        "spent_this_month": by_month.get(this_month, {}).get("spent", 0),
        "spent_last_month": by_month.get(last_month, {}).get("spent", 0),
        "income_this_month": by_month.get(this_month, {}).get("income", 0),
        "cashflow_6_months": cashflow,                                   # bar chart: spent vs income
        "top_categories_this_month": rows(                              # every category with spending; the app
            "select category_id, category, category_parent_id, spent, not_converted from book_monthly_category_spend"
            " where book_id = :b and month = :this and spent > 0 order by spent desc"),   # rolls them up, shows the top 6
        "budgets": rows(                                                # progress bars, most used first
            "select budget_id, category_id, category, period, period_start, period_end, budget, spent, remaining, percent_used, not_converted"
            "  from budget_progress where book_id = :b order by percent_used desc"),
        "accounts": rows(                                               # in_net_worth false: show greyed out
            "select bc.account_id, bc.name, bc.kind, bc.currency, bc.balance, bc.converted_balance, bc.in_net_worth"
            "  from book_balances_converted bc join accounts a on a.id = bc.account_id"
            " where bc.book_id = :b and a.archived_at is null order by bc.kind, bc.name"),
        "people": rows(                                                 # who owes whom
            "select contact_id, name, currency, owed_to_you, you_owe from contact_balances"
            " where book_id = :b and (owed_to_you <> 0 or you_owe <> 0) order by name"),
        "recent_transactions": rows(
            "select t.id, t.type::text as type, t.occurred_on, t.payee, c.name as category,"
            "       (select sum(e.amount) from entries e where e.transaction_id = t.id"
            "          and (t.type <> 'transfer' or e.amount < 0))::bigint as amount,"
            "       (select min(a.currency) from entries e join accounts a on a.id = e.account_id"
            "          where e.transaction_id = t.id and (t.type <> 'transfer' or e.amount < 0)) as currency"
            "  from transactions t left join categories c on c.id = t.category_id"
            " where t.book_id = :b order by t.occurred_on desc, t.created_at desc limit 10"),
    }
