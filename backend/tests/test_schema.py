"""Tests for the database migrations and the backend helpers, against a real Postgres.

Run:  TEST_ADMIN_URL=postgresql+psycopg://postgres@localhost/postgres pytest -q tests/
Needs a superuser connection; it creates a throwaway database, applies every
file in supabase/migrations in order (exactly what reaches dev and prod), runs
everything as the restricted app/AI/FX/purge/billing logins, then drops it.
"""
import os
import threading
import time
import uuid
from datetime import UTC, date, datetime, timedelta

from decimal import Decimal

import pytest
from cryptography.exceptions import InvalidTag
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from conftest import POLICY, _url

pytestmark = pytest.mark.usefixtures("database")


# ---------------------------------------------------------------- helpers

def session(user_id):
    from app.core import db
    return db.user_session(user_id)


def q(user_id, sql, **params):
    with session(user_id) as s:
        return s.execute(text(sql), params).all()


def run(user_id, sql, **params):
    with session(user_id) as s:
        s.execute(text(sql), params)


def refused(user_id, sql, **params) -> str:
    with pytest.raises(DBAPIError) as e:
        run(user_id, sql, **params)
    return type(e.value.orig).__name__


def new_user(name):
    uid = uuid.uuid4()
    # Sign-up: the users row and the privacy policy consent in one transaction.
    run(uid, "with u as (insert into users (id, username, email) values (:i, :n, :e) returning id)"
             " insert into consents (user_id, purpose, policy_version) select id, 'use_app', :v from u",
        i=uid, n=name, e=f"{name}@example.com", v=POLICY)
    return uid


def new_book(owner, currency="USD", **kw):
    bid = uuid.uuid4()
    run(owner, "insert into books (id, created_by, name, base_currency, timezone) values (:i, :o, :n, :c, :tz)",
        i=bid, o=owner, n=kw.get("name", f"book-{bid.hex[:6]}"), c=currency, tz=kw.get("tz", "UTC"))
    return bid


def new_account(user, book, name, kind="checking", currency=None, contact=None):
    aid = uuid.uuid4()
    run(user, "insert into accounts (id, book_id, name, kind, currency, contact_id)"
              " values (:i, :b, :n, :k, coalesce(:c, (select base_currency from books where id = :b)), :ct)",
        i=aid, b=book, n=name, k=kind, c=currency, ct=contact)
    return aid


def new_category(user, book, name, kind="expense", parent=None):
    cid = uuid.uuid4()
    run(user, "insert into categories (id, book_id, name, kind, parent_id) values (:i, :b, :n, :k, :p)",
        i=cid, b=book, n=name, k=kind, p=parent)
    return cid


def add(user, book, type, day, entries, category=None, payee=None):
    from app.domain.transactions import Entry, TxnIn, create_transaction
    tid = uuid.uuid4()
    with session(user) as s:
        create_transaction(s, TxnIn(tid, book, type, day, [Entry(a, n) for a, n in entries], category, payee))
    return tid


def share(owner, book, member, role):
    run(owner, "insert into book_members (book_id, user_id, role, invited_by)"
               " values (:b, find_user_by_username(:u), :r, :o)",
        b=book, u=q(member, "select username from users where id = :i", i=member)[0][0], r=role, o=owner)
    run(member, "select accept_invite(:b)", b=book)


def balance(user, account):
    rows = q(user, "select balance from account_balances where account_id = :a", a=account)
    return rows[0][0] if rows else None


# ---------------------------------------------------------------- ledger

def test_balances_and_ledger_rules():
    u = new_user("ledger_user")
    b = new_book(u)
    chk, visa = new_account(u, b, "Checking"), new_account(u, b, "Visa", "credit_card")
    add(u, b, "opening_balance", date(2026, 10, 1), [(chk, 100000)])
    add(u, b, "expense", date(2026, 10, 2), [(visa, -4500)])
    add(u, b, "transfer", date(2026, 10, 3), [(chk, -4500), (visa, 4500)])
    assert (balance(u, chk), balance(u, visa)) == (95500, 0)
    fix = add(u, b, "adjustment", date(2026, 10, 4), [(chk, -500)])          # reconcile to the bank statement
    run(u, "update transactions set note = 'bank fee' where id = :t", t=fix)
    assert balance(u, chk) == 95000
    assert q(u, "select note from transactions where id = :t", t=fix) == [("bank fee",)]

    with pytest.raises(DBAPIError, match="must sum to 0"):
        add(u, b, "transfer", date(2026, 10, 4), [(chk, -100), (visa, 90)])
    with pytest.raises(DBAPIError, match="must be negative"):
        add(u, b, "expense", date(2026, 10, 4), [(chk, 100)])
    with pytest.raises(DBAPIError, match="needs exactly 1 entry"):
        run(u, "insert into transactions (book_id, type, occurred_on) values (:b, 'income', '2026-10-04')", b=b)


def test_books_are_isolated():
    u = new_user("iso_user")
    b1, b2 = new_book(u), new_book(u)
    a1, a2 = new_account(u, b1, "A"), new_account(u, b2, "B")
    with pytest.raises(DBAPIError, match="foreign key"):
        add(u, b1, "transfer", date(2026, 10, 4), [(a1, -100), (a2, 100)])


def test_account_currency_defaults_and_locks():
    u = new_user("ccy_user")
    b = new_book(u, "VND")
    cash = uuid.uuid4()
    run(u, "insert into accounts (id, book_id, name, kind) values (:i, :b, 'Cash', 'cash')", i=cash, b=b)
    card = new_account(u, b, "US card", "credit_card", "USD")
    assert q(u, "select currency from accounts where id = :i", i=cash)[0][0] == "VND"
    run(u, "update accounts set currency = 'EUR' where id = :i", i=card)        # unused: allowed
    add(u, b, "opening_balance", date(2026, 10, 1), [(cash, 500000)])
    with pytest.raises(DBAPIError, match="currency can't change"):
        run(u, "update accounts set currency = 'USD' where id = :i", i=cash)
    assert refused(u, "insert into books (created_by, name) values (:u, 'no currency')", u=u) == "NotNullViolation"


def test_full_currency_list():
    u = new_user("ccy_list_user")
    ccy = dict((c, (m, n)) for c, m, n in q(u, "select code, minor_unit, name from currencies"))
    assert len(ccy) == 155
    assert {c: ccy[c][0] for c in ("VND", "USD", "JPY", "KWD", "BHD", "ISK", "CLP", "THB")} == \
        {"VND": 0, "USD": 2, "JPY": 0, "KWD": 3, "BHD": 3, "ISK": 0, "CLP": 0, "THB": 2}
    assert ccy["VND"] == (0, "Dong")                                              # baseline row kept as it was
    assert not {"XAU", "XDR", "XXX", "USN", "CLF"} & ccy.keys()                     # metals, funds, test codes left out
    b = new_book(u, "THB")
    assert q(u, "select currency from accounts where id = :i", i=new_account(u, b, "Baht cash", "cash"))[0][0] == "THB"
    assert refused(u, "insert into currencies values ('ZZZ', 2, 'Made up')") == "InsufficientPrivilege"
    assert refused(u, "update currencies set minor_unit = 2 where code = 'VND'") == "InsufficientPrivilege"
    from app.jobs import fx_update
    fx = create_engine(_url("t_fx"))
    assert fx_update.store_rates(fx, date(2026, 10, 7), {"THB": Decimal("36.1"), "BTC": Decimal("0.00001")}, "t") == 1
    fx.dispose()


# ---------------------------------------------------------------- users and sharing

def test_usernames_are_unique_and_lowercase():
    new_user("minh")
    with pytest.raises(DBAPIError, match="unique"):
        new_user("minh")
    with pytest.raises(DBAPIError, match="check"):
        new_user("Minh")                     # app lowercases before saving
    with pytest.raises(DBAPIError, match="check"):
        new_user("a")                        # too short


def test_sharing_roles():
    owner, editor, viewer, stranger = (new_user(n) for n in ("own_1", "edit_1", "view_1", "strange_1"))
    b = new_book(owner)
    chk = new_account(owner, b, "Joint checking")
    add(owner, b, "opening_balance", date(2026, 10, 1), [(chk, 100000)])

    # Invite is pending until accepted: nothing visible yet, but the invite is.
    run(owner, "insert into book_members (book_id, user_id, role, invited_by) values (:b, find_user_by_username('edit_1'), 'editor', :o)", b=b, o=owner)
    assert q(editor, "select count(*) from accounts")[0][0] == 0
    assert q(editor, "select book_name, invited_by_username from my_pending_invites()")[0][1] == "own_1"
    run(editor, "select accept_invite(:b)", b=b)
    assert balance(editor, chk) == 100000

    share(owner, b, viewer, "viewer")

    # Editor writes; viewer reads only; stranger sees nothing.
    add(editor, b, "expense", date(2026, 10, 2), [(chk, -2500)], payee="Groceries")
    assert balance(viewer, chk) == 97500
    with pytest.raises(DBAPIError, match="row-level security"):
        add(viewer, b, "expense", date(2026, 10, 2), [(chk, -100)])
    assert q(stranger, "select count(*) from transactions")[0][0] == 0
    with pytest.raises(DBAPIError, match="row-level security"):
        add(stranger, b, "expense", date(2026, 10, 2), [(chk, -100)])

    # Only owners manage members and the book.
    assert refused(editor, "insert into book_members (book_id, user_id, role) values (:b, :s, 'viewer')", b=b, s=stranger) == "InsufficientPrivilege"
    run(viewer, "update book_members set role = 'owner' where book_id = :b and user_id = :v", b=b, v=viewer)
    assert q(owner, "select role from book_members where book_id = :b and user_id = :v", b=b, v=viewer)[0][0] == "viewer"
    run(editor, "delete from books where id = :b", b=b)                       # matches 0 rows
    # An owner can only invite; nobody becomes a member without accepting.
    run(owner, "insert into book_members (book_id, user_id, role, invited_by) values (:b, :s, 'viewer', :o)",
        b=b, s=stranger, o=owner)
    assert refused(owner, "update book_members set accepted_at = now() where book_id = :b and user_id = :s",
                   b=b, s=stranger) == "InsufficientPrivilege"
    assert refused(owner, "update book_members set user_id = :s where book_id = :b and user_id = :v",
                   b=b, s=stranger, v=viewer) == "InsufficientPrivilege"
    run(owner, "delete from book_members where book_id = :b and user_id = :s", b=b, s=stranger)
    assert refused(owner, "insert into book_members (book_id, user_id, role, invited_by) values (:b, :s, 'viewer', :e)",
                   b=b, s=stranger, e=editor) == "InsufficientPrivilege"                # can't name someone else as inviter
    assert refused(owner, "update books set created_by = :s where id = :b", b=b, s=stranger) == "InsufficientPrivilege"
    assert refused(editor, "update transactions set created_by = :o where book_id = :b", b=b, o=owner) == "InsufficientPrivilege"
    assert refused(editor, "insert into transactions (book_id, type, occurred_on, created_by) values (:b, 'income', '2026-10-04', :o)",
                   b=b, o=owner) == "InsufficientPrivilege"
    assert q(owner, "select count(*) from books where id = :b", b=b)[0][0] == 1

    # Who added what, by username; emails stay private.
    assert q(viewer, "select u.username from transactions t join users u on u.id = t.created_by"
                     " where t.payee = 'Groceries'")[0][0] == "edit_1"
    assert refused(viewer, "select email from users") == "InsufficientPrivilege"
    assert {r[0] for r in q(viewer, "select username from book_member_list where book_id = :b", b=b)} == {"own_1", "edit_1", "view_1"}

    # Removing a member cuts access immediately.
    run(owner, "delete from book_members where book_id = :b and user_id = :v", b=b, v=viewer)
    assert balance(viewer, chk) is None

    # The last owner can't leave; after handing over, they can.
    with pytest.raises(DBAPIError, match="at least one owner"):
        run(owner, "delete from book_members where book_id = :b and user_id = :o", b=b, o=owner)
    run(owner, "update book_members set role = 'owner' where book_id = :b and user_id = :e", b=b, e=editor)
    run(owner, "delete from book_members where book_id = :b and user_id = :o", b=b, o=owner)
    assert balance(owner, chk) is None and balance(editor, chk) == 97500
    # The book now counts against the owner who stayed, and the creator sees nothing of it.
    assert q(editor, "select created_by from books where id = :b", b=b)[0][0] == editor
    assert q(owner, "select count(*) from books where id = :b", b=b)[0][0] == 0
    rows, named = q(owner, "select count(*), count(book_name) from my_activity()")[0]
    assert rows > 0 and named == 0                                             # their activity stays, the book's name doesn't


def test_audit_log_is_owner_only(database):
    owner, editor = new_user("own_2"), new_user("edit_2")
    b = new_book(owner)
    share(owner, b, editor, "editor")
    new_account(editor, b, "Cash", "cash")
    assert q(owner, "select count(*) from audit_log where book_id = :b and table_name = 'accounts'", b=b)[0][0] == 1
    assert q(editor, "select count(*) from audit_log")[0][0] == 0
    assert refused(owner, "delete from audit_log") == "InsufficientPrivilege"
    # Deleting the book deletes its audit rows too.
    run(owner, "delete from books where id = :b", b=b)
    with database.connect() as c:
        assert c.execute(text("select count(*) from audit_log where book_id = :b"), {"b": b}).scalar() == 0


# ---------------------------------------------------------------- edits, history, concurrency

def test_edit_history_and_conflicts():
    from app.domain.transactions import Conflict, Entry, TxnIn, create_transaction, delete_transaction, update_transaction
    owner, editor = new_user("own_3"), new_user("edit_3")
    b = new_book(owner)
    share(owner, b, editor, "editor")
    chk, visa = new_account(owner, b, "Checking"), new_account(owner, b, "Visa", "credit_card")
    tid = uuid.uuid4()
    t = TxnIn(tid, b, "expense", date(2026, 10, 7), [Entry(chk, -1000)], payee="Cafe")
    with session(owner) as s:
        assert create_transaction(s, t) == 1
    with session(owner) as s:                       # retry with the same id: no duplicate
        assert create_transaction(s, t) == 1
    assert q(owner, "select count(*) from entries where transaction_id = :t", t=tid)[0][0] == 1

    # Two members edit version 1 at the same moment: one wins, one gets 409.
    results, gate = {}, threading.Event()

    def first():
        with session(owner) as s:
            results["owner"] = update_transaction(s, TxnIn(tid, b, "expense", date(2026, 10, 7), [Entry(chk, -1250)], payee="Cafe Luna"), 1)
            gate.set()
            time.sleep(0.5)

    def second():
        gate.wait()
        try:
            with session(editor) as s:
                results["editor"] = update_transaction(s, TxnIn(tid, b, "transfer", date(2026, 10, 7), [Entry(chk, -1), Entry(visa, 1)]), 1)
        except Conflict:
            results["editor"] = "409"

    threads = [threading.Thread(target=first), threading.Thread(target=second)]
    [x.start() for x in threads]
    [x.join() for x in threads]
    assert results == {"owner": 2, "editor": "409"}

    with session(editor) as s:
        assert update_transaction(s, TxnIn(tid, b, "transfer", date(2026, 10, 7), [Entry(chk, -1250), Entry(visa, 1250)]), 2) == 3
    assert q(owner, "select modified_at > created_at, modified_by from transactions where id = :t", t=tid)[0] == \
        (True, editor)
    with session(editor) as s, pytest.raises(Conflict):
        delete_transaction(s, tid, 1)
    with session(owner) as s:
        delete_transaction(s, tid, 3)

    hist = q(editor, "select h.version, h.action, u.username, h.snapshot->'entries' from transaction_history h"
                     " left join users u on u.id = h.changed_by where transaction_id = :t order by h.id", t=tid)
    assert [(v, a, who) for v, a, who, _ in hist] == [
        (1, "created", "own_3"), (2, "edited", "own_3"), (3, "edited", "edit_3"), (3, "deleted", "own_3")]
    assert [e["amount"] for e in hist[2][3]] == [-1250, 1250]
    assert refused(owner, "delete from transaction_history") == "InsufficientPrivilege"


def test_pooled_connection_does_not_leak_user():
    from app.core import db
    u = new_user("pool_user")
    new_book(u)
    q(u, "select 1")
    with db.engine.connect() as c:
        assert c.execute(text("select count(*) from books")).scalar() == 0


def test_parallel_adds_all_count():
    u = new_user("par_user")
    b = new_book(u)
    chk = new_account(u, b, "Checking")
    threads = [threading.Thread(target=add, args=(u, b, "expense", date(2026, 10, 7), [(chk, -100)])) for _ in range(10)]
    [x.start() for x in threads]
    [x.join() for x in threads]
    assert balance(u, chk) == -1000


# ---------------------------------------------------------------- money features

def test_exchange_rates():
    u = new_user("fx_user")
    auto, custom = new_book(u), new_book(u)
    run(u, "update books set auto_fx = false where id = :b", b=custom)
    eur, jpy = new_account(u, auto, "EUR acct", currency="EUR"), new_account(u, auto, "JPY cash", "cash", "JPY")
    add(u, auto, "opening_balance", date(2026, 10, 1), [(eur, 9000)])
    add(u, auto, "opening_balance", date(2026, 10, 1), [(jpy, 15000)])
    conv = dict(q(u, "select name, converted_balance from book_balances_converted where book_id = :b", b=auto))
    assert conv == {"EUR acct": 10000, "JPY cash": 10000}
    assert q(u, "select book_rate(:b, 'USD', 'EUR', '2026-09-15')", b=auto)[0][0] == Decimal("0.8")   # September's rate

    vnd = new_account(u, custom, "VND cash", "cash", "VND")
    add(u, custom, "opening_balance", date(2026, 10, 1), [(vnd, 2400000)])
    assert q(u, "select net_worth, missing_rates from book_net_worth where book_id = :b", b=custom)[0] == (0, 1)
    run(u, "insert into book_fx_rates (book_id, from_currency, to_currency, rate, effective_from)"
           " values (:b, 'USD', 'VND', 24000, '2026-10-01')", b=custom)
    assert q(u, "select net_worth, missing_rates from book_net_worth where book_id = :b", b=custom)[0] == (10000, 0)

    assert refused(u, "insert into fx_rates (quote, as_of, rate, source) values ('EUR', '2026-10-07', 2, 'x')") == "InsufficientPrivilege"

    # Changing a book's currency converts its budgets at today's rate; refused without a rate.
    travel = new_category(u, auto, "Travel")
    run(u, "insert into budgets (book_id, category_id, period, amount) values (:b, :c, 'monthly', 15000)", b=auto, c=travel)
    expected = q(u, "select convert_minor(:b, 15000, 'USD', 'EUR', current_date)", b=auto)[0][0]
    run(u, "update books set base_currency = 'EUR' where id = :b", b=auto)
    assert q(u, "select amount from budgets where book_id = :b", b=auto)[0][0] == expected != 15000
    trip = new_category(u, custom, "Travel")
    run(u, "insert into budgets (book_id, category_id, period, amount) values (:b, :c, 'monthly', 1000)", b=custom, c=trip)
    with pytest.raises(DBAPIError, match="no_rate"):
        run(u, "update books set base_currency = 'JPY' where id = :b", b=custom)


def test_fx_updater_job():
    from app.jobs import fx_update
    fx = create_engine(_url("t_fx"))
    assert fx_update.store_rates(fx, date(2026, 10, 6), {"EUR": Decimal("0.91"), "XYZ": Decimal("1")}, "ecb") == 1
    assert fx_update.store_rates(fx, date(2026, 10, 6), {"EUR": Decimal("0.92")}, "ecb") == 1
    with fx.connect() as c:
        assert c.execute(text("select rate from fx_rates where quote = 'EUR' and as_of = '2026-10-06'")).scalar() == Decimal("0.92")
        with pytest.raises(DBAPIError):
            c.execute(text("select * from accounts"))
    fx.dispose()


def test_lending_and_borrowing():
    u, other = new_user("lend_user"), new_user("lend_other")
    b = new_book(u)
    tom, mom = uuid.uuid4(), uuid.uuid4()
    run(u, "insert into contacts (id, book_id, name) values (:t, :b, 'Tom'), (:m, :b, 'Mom')", t=tom, m=mom, b=b)
    chk = new_account(u, b, "Checking")
    lent, loan = new_account(u, b, "Lent to Tom", "lent", contact=tom), new_account(u, b, "Borrowed from Mom", "loan", contact=mom)
    add(u, b, "opening_balance", date(2026, 10, 1), [(chk, 100000)])
    add(u, b, "transfer", date(2026, 10, 2), [(chk, -20000), (lent, 20000)])
    add(u, b, "transfer", date(2026, 10, 3), [(lent, -5000), (chk, 5000)])
    add(u, b, "transfer", date(2026, 10, 4), [(loan, -50000), (chk, 50000)])
    add(u, b, "transfer", date(2026, 10, 5), [(chk, -10000), (loan, 10000)])
    people = {n: (o, y) for n, o, y in q(u, "select name, owed_to_you, you_owe from contact_balances where book_id = :b", b=b)}
    assert people == {"Tom": (15000, 0), "Mom": (0, 40000)}
    assert q(u, "select net_worth from book_net_worth where book_id = :b", b=b)[0][0] == 100000
    with pytest.raises(DBAPIError, match="check"):
        run(u, "update accounts set contact_id = :t where id = :c", t=tom, c=chk)
    assert q(other, "select count(*) from contacts")[0][0] == 0


def test_dashboard_and_budgets():
    from app.domain.dashboard import dashboard
    u, stranger = new_user("dash_user"), new_user("dash_stranger")
    b = new_book(u)
    chk, eur = new_account(u, b, "Checking"), new_account(u, b, "Euro card", "credit_card", "EUR")
    tom = uuid.uuid4()
    run(u, "insert into contacts (id, book_id, name) values (:t, :b, 'Tom')", t=tom, b=b)
    lent = new_account(u, b, "Lent to Tom", "lent", contact=tom)
    food, rent = new_category(u, b, "Food"), new_category(u, b, "Rent")
    groc = new_category(u, b, "Groceries", parent=food)
    salary = new_category(u, b, "Salary", "income")
    add(u, b, "opening_balance", date(2026, 8, 1), [(chk, 500000)])
    add(u, b, "income", date(2026, 10, 1), [(chk, 300000)], salary)
    add(u, b, "expense", date(2026, 10, 2), [(chk, -100000)], rent)
    add(u, b, "expense", date(2026, 10, 3), [(eur, -9000)], groc)          # €90 at 0.9 -> $100
    add(u, b, "refund", date(2026, 10, 4), [(eur, 900)], groc)             # €9 -> $10 back
    add(u, b, "expense", date(2026, 10, 5), [(chk, -2500)], food)
    add(u, b, "transfer", date(2026, 10, 6), [(chk, -20000), (lent, 20000)])

    with session(u) as s:
        d = dashboard(s, b, today=date(2026, 10, 7))
    assert d["spent_this_month"] == 111500 and d["income_this_month"] == 300000
    assert [(c["category"], c["spent"]) for c in d["top_categories_this_month"]] == [("Rent", 100000), ("Groceries", 9000), ("Food", 2500)]
    card = next(a for a in d["accounts"] if a["name"] == "Euro card")
    assert card["balance"] == -8100                                   # €81 still owed
    assert d["net_worth"] == 677500 + card["converted_balance"] + 20000   # checking + card at today's rate + lent to Tom
    assert [{k: v for k, v in p.items() if k != "contact_id"} for p in d["people"]] == \
        [{"name": "Tom", "currency": "USD", "owed_to_you": 20000, "you_owe": 0}]
    with session(stranger) as s:
        assert not any(v for k, v in dashboard(s, b, today=date(2026, 10, 7)).items())

    # Budgets: parent includes children; periods follow the book's timezone.
    run(u, "insert into budgets (book_id, category_id, period, amount, starts_on) values"
           " (:b, :f, 'monthly', 15000, '2026-01-01'), (:b, :r, 'monthly', 100000, '2026-01-01')", b=b, f=food, r=rent)
    with pytest.raises(DBAPIError, match="expense categories"):
        run(u, "insert into budgets (book_id, category_id, period, amount) values (:b, :s, 'monthly', 1)", b=b, s=salary)
    run(u, "update books set timezone = 'Pacific/Kiritimati' where id = :b", b=b)   # UTC+14
    start = q(u, "select period_start from budget_progress where book_id = :b and category = 'Food'", b=b)[0][0]
    assert start == q(u, "select date_trunc('month', (now() at time zone 'Pacific/Kiritimati'))::date")[0][0]


def test_budget_periods():
    """R-BUD-1: a budget per category and period; a parent's budget covers its sub-categories."""
    u = new_user("bud_user")
    b = new_book(u)
    chk = new_account(u, b, "Checking")
    food = new_category(u, b, "Food")
    groc = new_category(u, b, "Groceries", parent=food)
    today = q(u, "select (now() at time zone timezone)::date from books where id = :b", b=b)[0][0]   # the book's today
    add(u, b, "expense", today, [(chk, -1000)], groc)
    add(u, b, "expense", date(today.year - 1, 12, 1), [(chk, -7000)], food)            # in no current period
    periods = ["daily", "weekly", "monthly", "quarterly", "yearly"]
    for p in periods:
        run(u, "insert into budgets (book_id, category_id, period, amount, starts_on)"
               " values (:b, :c, cast(:p as budget_period), 5000, '2020-01-01')", b=b, c=food, p=p)
    rows = {p: (start, spent) for p, start, spent in
            q(u, "select period::text, period_start, spent from budget_progress where book_id = :b", b=b)}
    assert {p: spent for p, (_, spent) in rows.items()} == dict.fromkeys(periods, 1000)
    week = rows["weekly"][0]
    assert week.weekday() == 0 and week <= today < week + timedelta(days=7)            # weeks start on Monday
    assert (rows["daily"][0], rows["monthly"][0], rows["quarterly"][0], rows["yearly"][0]) == \
        (today, today.replace(day=1), date(today.year, (today.month - 1) // 3 * 3 + 1, 1), date(today.year, 1, 1))


def subscribe(user, plan="premium", days=30, status="active"):
    """What the payment webhook does (as billing_webhook)."""
    bill = create_engine(_url("t_bill"))
    with bill.begin() as c:
        c.execute(text("insert into subscriptions (user_id, plan, status, store, store_subscription_id, current_period_end)"
                       " values (:u, :p, :s, 'stripe', :sid, now() + make_interval(days => :d))"
                       " on conflict (user_id) do update set plan = excluded.plan, status = excluded.status,"
                       " current_period_end = excluded.current_period_end, updated_at = now()"),
                  {"u": user, "p": plan, "s": status, "sid": f"sub_{user.hex}", "d": days})
    bill.dispose()


def test_ai_views_are_gated():
    """R-AI-1..3: AI only on opted-in books, only summaries, only owners turn it on; it stops when the payer leaves."""
    owner, editor, stranger = new_user("ai_owner"), new_user("ai_editor"), new_user("ai_stranger")
    subscribe(owner)
    b = new_book(owner)
    share(owner, b, editor, "editor")
    chk, food = new_account(owner, b, "Checking"), new_category(owner, b, "Food")
    add(owner, b, "expense", date(2026, 9, 3), [(chk, -5000)], food, "Costco")

    ai = create_engine(_url("t_ai"))

    def ai_q(user, sql):
        with ai.begin() as c:
            c.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(user)})
            return c.execute(text(sql)).all()

    assert ai_q(owner, "select count(*) from ai_monthly_category_spend") == [(0,)]       # not opted in
    assert refused(editor, "insert into ai_settings (book_id, enabled) values (:b, true)", b=b) == "InsufficientPrivilege"
    run(owner, "insert into ai_settings (book_id, enabled) values (:b, true)", b=b)
    assert ai_q(editor, "select category, spent from ai_monthly_category_spend") == [("Food", 5000)]
    assert ai_q(owner, "select count(*) from ai_monthly_payee_spend") == [(0,)]          # payees need their own opt-in
    assert ai_q(stranger, "select count(*) from ai_monthly_category_spend") == [(0,)]
    with pytest.raises(DBAPIError):
        ai_q(owner, "select * from transactions")

    # The job can save advice only where AI is on.
    def ai_save(user, book):
        with ai.begin() as c:
            c.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(user)})
            c.execute(text("insert into ai_insights (book_id, period_start, period_end, model, input, advice)"
                           " values (:b, '2026-09-01', '2026-09-30', 'test', '{}', 'ok')"), {"b": book})
    ai_save(editor, b)
    assert refused(editor, "update ai_insights set advice = 'changed' where book_id = :b", b=b) == "InsufficientPrivilege"
    run(editor, "update ai_insights set dismissed_at = now() where book_id = :b", b=b)
    off = new_book(owner)
    with pytest.raises(DBAPIError, match="row-level security"):
        ai_save(owner, off)

    # AI stops when the owner who pays for it leaves the book.
    run(owner, "update book_members set role = 'owner' where book_id = :b and user_id = :e", b=b, e=editor)
    assert q(editor, "select ai_entitlement(:b)", b=b)[0][0] == "plan"
    run(owner, "delete from book_members where book_id = :b and user_id = :o", b=b, o=owner)
    assert q(editor, "select ai_entitlement(:b)", b=b)[0][0] is None
    assert ai_q(editor, "select count(*) from ai_monthly_category_spend") == [(0,)]
    ai.dispose()


# ---------------------------------------------------------------- account deletion

def test_account_deletion_restore_and_purge(database, tmp_path):
    from app.jobs import account_deletion as ad
    leaver, editor, viewer = new_user("leaver"), new_user("stayer_ed"), new_user("stayer_vw")
    solo = new_book(leaver, name="Leaver personal")
    shared = new_book(leaver, name="Household")
    share(leaver, shared, editor, "editor")
    share(leaver, shared, viewer, "viewer")
    mine = new_account(leaver, solo, "Private")
    joint = new_account(leaver, shared, "Joint")
    add(leaver, solo, "opening_balance", date(2026, 10, 1), [(mine, 5000)])
    t_shared = add(leaver, shared, "expense", date(2026, 10, 2), [(joint, -700)], payee="Market")

    # Close: the account sees nothing at once; the household keeps working.
    with session(leaver) as s:
        deletes_on = ad.request_deletion(s)
    assert 29 <= (deletes_on - datetime.now(UTC)).days <= 30                    # the 30-day restore window
    assert balance(leaver, mine) is None and balance(leaver, joint) is None
    assert q(leaver, "select count(*) from books")[0][0] == 0                     # not even the ones they created
    assert balance(editor, joint) == -700
    add(editor, shared, "expense", date(2026, 10, 3), [(joint, -300)])

    # Restore within 30 days: everything is back.
    with session(leaver) as s:
        assert ad.restore(s) is True
    assert balance(leaver, mine) == 5000
    with session(leaver) as s:
        ad.request_deletion(s)

    # The daily job won't run without somewhere outside the database to log ids,
    # and leaves accounts closed for less than 30 days alone.
    purger = create_engine(_url("t_purge"))
    deleted_logins = []
    log = tmp_path / "purged.jsonl"
    with pytest.raises(RuntimeError, match="PURGE_LOG"):
        ad.run_purge(purger, deleted_logins.append)
    assert ad.run_purge(purger, deleted_logins.append, str(log)) == []

    # 31 days later. Supabase is down: the account is purged and the login is
    # retried on the next run until it's confirmed deleted.
    with database.connect() as c:
        c.execute(text("update users set deletion_requested_at = now() - interval '31 days' where id = :u"), {"u": leaver})

    def auth_down(user_id):
        raise OSError("Supabase Auth unavailable")
    with pytest.raises(RuntimeError, match="not deleted yet"):
        ad.run_purge(purger, auth_down, str(log))
    assert ad.run_purge(purger, deleted_logins.append, str(log)) == [] and deleted_logins == [leaver]
    assert ad.run_purge(purger, deleted_logins.append, str(log)) == [] and deleted_logins == [leaver]   # confirmed: not again

    with database.connect() as c:
        one = lambda sql, **p: c.execute(text(sql), p).scalar()
        assert one("select count(*) from books where id = :b", b=solo) == 0               # private book gone
        assert one("select count(*) from audit_log where book_id = :b", b=solo) == 0
        assert one("select count(*) from transaction_history where book_id = :b", b=solo) == 0
        assert one("select created_by from books where id = :b", b=shared) == editor     # household kept
        assert one("select role from book_members where book_id = :b and user_id = :e", b=shared, e=editor) == "owner"
        # Only a bare id is left, still linked to what they did in the household.
        assert c.execute(text("select username, email, display_name, deleted_at is not null from users where id = :u"),
                         {"u": leaver}).one() == (None, None, None, True)
        assert one("select created_by from transactions where id = :t", t=t_shared) == leaver
        assert one("select count(*) from book_members where user_id = :u", u=leaver) == 0
        # Nothing personal is left anywhere.
        for table in ("users", "transaction_history", "audit_log", "books", "transactions", "ai_settings"):
            assert one(f"select count(*) from {table} t where t::text like '%leaver@example.com%'") == 0, table
    assert balance(editor, joint) == -1000
    with pytest.raises(DBAPIError, match="account_deleted"):
        subscribe(leaver)                                                          # a renewal after the purge

    # The household sees each deleted account as its own "Deleted user".
    def people():
        return dict(q(editor, "select user_id, name from book_people where book_id = :b and deleted", b=shared))
    assert people() == {leaver: "Deleted user"}
    assert q(editor, "select count(*) from users where id = :u", u=leaver)[0][0] == 0   # not a row they can read

    # Someone new can take the username; they get a new id and aren't the deleted user.
    newcomer = new_user("leaver")
    assert newcomer != leaver
    share(editor, shared, newcomer, "editor")
    assert q(editor, "select name from book_people where book_id = :b and user_id = :u", b=shared, u=newcomer)[0][0] == "leaver"
    assert people() == {leaver: "Deleted user"}

    # A second deleted account in the same book stays distinct from the first.
    add(newcomer, shared, "expense", date(2026, 10, 4), [(joint, -50)])
    with session(newcomer) as s:
        ad.request_deletion(s)
    with database.connect() as c:
        c.execute(text("update users set deletion_requested_at = now() - interval '31 days' where id = :u"), {"u": newcomer})
    assert ad.run_purge(purger, deleted_logins.append, str(log)) == [newcomer] and deleted_logins == [leaver, newcomer]
    assert people() == {leaver: "Deleted user 1", newcomer: "Deleted user 2"}

    # A backup from before the purge gets restored: the job deletes them again,
    # and their Supabase logins, which the restore brought back too.
    with database.connect() as c:
        c.execute(text("update users set username = 'leaver_old', email = 'old@example.com', deleted_at = null"
                       " where id = :u"), {"u": leaver})
    restored_logins = []
    assert ad.repurge(purger, str(log), restored_logins.append) == 1
    assert set(restored_logins) == {leaver, newcomer}
    assert ad.repurge(purger, str(log), restored_logins.append) == 0                    # already gone: nothing to do
    with database.connect() as c:
        assert c.execute(text("select username from users where id = :u"), {"u": leaver}).scalar() is None

    # The purge job can't do anything else.
    with purger.connect() as c, pytest.raises(DBAPIError):
        c.execute(text("select * from users"))
    purger.dispose()


def test_signup_needs_consent(database):
    """R-CON-1..3: no account without consent to the privacy policy; recorded with version and time; withdrawable."""
    from app.jobs import account_deletion as ad
    # No consent, no account.
    lone = uuid.uuid4()
    assert refused(lone, "insert into users (id, username, email) values (:i, 'no_consent', 'nc@example.com')",
                   i=lone) == "RaiseException"
    u, other = new_user("con_user"), new_user("con_other")
    row = q(u, "select purpose, policy_version, agreed_at > now() - interval '1 minute', withdrawn_at from consents")
    assert row == [("use_app", POLICY, True, None)]
    assert q(other, "select count(*) from consents where user_id = :u", u=u)[0][0] == 0      # private
    # The record can't be backdated, edited, deleted, or made for someone else.
    assert refused(u, "insert into consents (user_id, purpose, policy_version, agreed_at)"
                      " values (:u, 'use_app', :v, '2020-01-01')", u=u, v=POLICY) == "InsufficientPrivilege"
    assert refused(u, "update consents set agreed_at = '2020-01-01'") == "InsufficientPrivilege"
    assert refused(u, "delete from consents") == "InsufficientPrivilege"
    assert refused(u, "insert into consents (user_id, purpose, policy_version) values (:o, 'use_app', :v)",
                   o=other, v=POLICY) == "InsufficientPrivilege"
    assert q(u, "select needs_consent from my_consent_status()")[0][0] is False

    # A new policy is published: the app is told to ask again; agreeing adds a row.
    with database.connect() as c:
        c.execute(text("insert into policy_versions (version, published_at, path, text_sha256)"
                       " values ('2027-01-01', now(), '/privacy/2027-01-01', repeat('a', 64))"))
    try:
        assert q(u, "select current_version, current_path, agreed_version, needs_consent from my_consent_status()")[0] == \
            ("2027-01-01", "/privacy/2027-01-01", POLICY, True)
        # A screen still showing the old policy can't record agreement to it, at sign-up or later.
        late = uuid.uuid4()
        assert refused(late, "with n as (insert into users (id, username, email) values (:i, 'con_late', 'l@example.com')"
                             " returning id) insert into consents (user_id, purpose, policy_version)"
                             " select id, 'use_app', :v from n", i=late, v=POLICY) == "RaiseException"
        run(u, "insert into consents (user_id, purpose, policy_version) values (:u, 'use_app', '2027-01-01')", u=u)
        assert q(u, "select needs_consent from my_consent_status()")[0][0] is False

        # Withdrawing the sign-up consent closes the account, like deleting it.
        with session(u) as s:
            assert s.execute(text("select withdraw_consent('use_app')")).scalar() == 2
            assert ad.status(s)["deletion_requested_at"] is not None
        assert q(u, "select count(*) from consents where withdrawn_at is not null")[0][0] == 2
        # Restoring needs a new consent to the policy in force first.
        with session(u) as s:
            assert ad.restore(s) is not True
            assert s.execute(text("select needs_consent from my_consent_status()")).scalar() is True
        run(u, "insert into consents (user_id, purpose, policy_version) values (:u, 'use_app', '2027-01-01')", u=u)
        with session(u) as s:
            assert ad.restore(s) is True
        assert q(u, "select needs_consent from my_consent_status()")[0][0] is False
    finally:
        with database.connect() as c:
            c.execute(text("delete from consents where policy_version = '2027-01-01'"))
            c.execute(text("delete from policy_versions where version = '2027-01-01'"))


def test_temp_tables_cannot_shadow_real_ones(database):
    """R-SEC-4: a session's own temp table can't stand in for a real table inside the database's checks."""
    api = create_engine(_url("t_api"))
    sneaky, victim_owner = uuid.uuid4(), new_user("shadow_owner")
    victim_book = new_book(victim_owner)
    try:
        with api.connect() as c:
            c.execute(text("create temp table consents (user_id uuid, purpose text, policy_version text, withdrawn_at timestamptz)"))
            c.execute(text("insert into pg_temp.consents values (:u, 'use_app', :v, null)"), {"u": sneaky, "v": POLICY})
            c.execute(text("create temp table book_members (book_id uuid, user_id uuid, role text, accepted_at timestamptz)"))
            c.execute(text("insert into pg_temp.book_members values (:b, :u, 'owner', now())"), {"b": victim_book, "u": sneaky})
            c.commit()
            # Account without a real consent: still refused.
            with pytest.raises(DBAPIError, match="consent_required"):
                with c.begin():
                    c.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(sneaky)})
                    c.execute(text("insert into users (id, username, email) values (:u, 'shadow_x', 'sx@example.com')"),
                              {"u": sneaky})
            c.rollback()
            # A fake membership doesn't open someone else's book.
            with c.begin():
                c.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(sneaky)})
                assert c.execute(text("select my_book_role(:b)"), {"b": victim_book}).scalar() is None

            # Nor can a member fool the currency lock or the expense-only budget rule.
            cash = new_account(victim_owner, victim_book, "Cash", "cash")
            add(victim_owner, victim_book, "opening_balance", date(2026, 10, 1), [(cash, 100)])
            salary = new_category(victim_owner, victim_book, "Salary", "income")
            c.execute(text("create temp table entries (account_id uuid)"))
            c.execute(text("create temp table categories (id uuid, kind text)"))
            c.execute(text("insert into pg_temp.categories values (:c, 'expense')"), {"c": salary})
            c.commit()
            with pytest.raises(DBAPIError, match="currency can't change"):
                with c.begin():
                    c.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(victim_owner)})
                    c.execute(text("update public.accounts set currency = 'EUR' where id = :a"), {"a": cash})
            with pytest.raises(DBAPIError, match="expense categories"):
                with c.begin():
                    c.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(victim_owner)})
                    c.execute(text("insert into public.budgets (book_id, category_id, period, amount)"
                                   " values (:b, :c, 'monthly', 100)"), {"b": victim_book, "c": salary})
    finally:
        api.dispose()


def test_archived_categories(database):
    """R-CAT-1: archived categories are hidden but keep their history; their budgets stop showing."""
    u = new_user("arch_user")
    b = new_book(u)
    chk = new_account(u, b, "Checking")
    old = new_category(u, b, "Old hobby")
    today = q(u, "select (now() at time zone timezone)::date from books where id = :b", b=b)[0][0]   # the book's today
    add(u, b, "expense", today, [(chk, -1500)], old)
    run(u, "insert into budgets (book_id, category_id, period, amount, starts_on)"
           " values (:b, :c, 'monthly', 10000, '2026-01-01')", b=b, c=old)
    assert q(u, "select count(*) from budget_progress where book_id = :b", b=b)[0][0] == 1
    run(u, "update categories set archived_at = now() where id = :c", c=old)
    assert q(u, "select count(*) from budget_progress where book_id = :b", b=b)[0][0] == 0
    # History keeps the category, and its spending still counts in reports.
    assert q(u, "select c.name from transactions t join categories c on c.id = t.category_id where t.book_id = :b",
             b=b) == [("Old hobby",)]
    assert q(u, "select category, spent from book_monthly_category_spend where book_id = :b", b=b) == [("Old hobby", 1500)]
    # Unarchive to use it again.
    run(u, "update categories set archived_at = null where id = :c", c=old)
    assert q(u, "select count(*) from budget_progress where book_id = :b", b=b)[0][0] == 1


def test_features_from_the_old_app(database):
    """R-ACC-4, R-CAT-2, R-CAT-3, R-CAT-4: kept from the old BudgetTracking app."""
    import csv
    import io
    import zipfile
    from app.domain.book_setup import add_starter_categories
    from app.domain.dashboard import dashboard
    from app.domain.export import build_export
    u, stranger = new_user("old_app_user"), new_user("old_app_stranger")
    b = new_book(u)
    chk, held = new_account(u, b, "Checking"), new_account(u, b, "Mum's savings", "savings")
    add(u, b, "opening_balance", date(2026, 10, 1), [(chk, 10000)])
    add(u, b, "opening_balance", date(2026, 10, 1), [(held, 50000)])

    # R-ACC-4: an account can be left out of net worth; it still shows, flagged, and keeps its balance.
    run(u, "update accounts set in_net_worth = false where id = :a", a=held)
    with session(u) as s:
        d = dashboard(s, b, today=date(2026, 10, 7))
    assert d["net_worth"] == 10000 and d["net_worth_missing_rates"] == 0
    assert {(a["name"], a["balance"], a["in_net_worth"]) for a in d["accounts"]} == \
        {("Checking", 10000, True), ("Mum's savings", 50000, False)}
    run(u, "update accounts set in_net_worth = false where id = :a", a=chk)        # none counted: 0, not missing
    assert q(u, "select net_worth, missing_rates from book_net_worth where book_id = :b", b=b) == [(0, 0)]
    run(u, "update accounts set in_net_worth = true where id = :a", a=chk)

    # R-CAT-3: starter categories in the user's language (Vietnamese by default), with sub-categories.
    with session(u) as s:
        assert add_starter_categories(s, b) == 18       # 4 parents, 14 sub-categories
    tree = dict(q(u, "select c.name, p.name from categories c left join categories p on p.id = c.parent_id"
                     " where c.book_id = :b", b=b))
    assert tree["Ăn uống/Đi chợ"] == "Thiết yếu" and tree["Lương"] == "Thu nhập" and tree["Thiết yếu"] is None
    assert q(u, "select count(*) from categories where book_id = :b and kind = 'income'", b=b)[0][0] == 5
    b_en = new_book(u)
    with session(u) as s:
        add_starter_categories(s, b_en, "en")
    assert q(u, "select kind from categories where book_id = :b and name = 'Groceries'", b=b_en) == [("expense",)]
    assert q(u, "select kind from categories where book_id = :b and name = 'Savings'", b=b_en) == [("transfer",)]
    # Nobody can add them to a book they can't edit.
    with pytest.raises(DBAPIError):
        with session(stranger) as s:
            add_starter_categories(s, b)

    # R-CAT-2: a category colour is a lowercase #rrggbb or nothing.
    food = new_category(u, b, "Food")
    run(u, "update categories set color = '#ef4444' where id = :c", c=food)
    assert refused(u, "update categories set color = 'red' where id = :c", c=food) == "CheckViolation"

    # R-CAT-4: transfer categories label transfers only, and never count as spending or take a budget.
    saving = q(u, "select id from categories where book_id = :b and name = 'Tiết kiệm'", b=b)[0][0]
    groceries = q(u, "select id from categories where book_id = :b and name = 'Ăn uống/Đi chợ'", b=b)[0][0]
    t = add(u, b, "transfer", date(2026, 10, 2), [(chk, -3000), (held, 3000)], saving)
    with pytest.raises(DBAPIError, match="category_kind"):
        add(u, b, "transfer", date(2026, 10, 2), [(chk, -1), (held, 1)], groceries)
    with pytest.raises(DBAPIError, match="category_kind"):
        add(u, b, "expense", date(2026, 10, 2), [(chk, -1)], saving)
    assert refused(u, "update transactions set category_id = :c where id = :t", c=groceries, t=t) == "RaiseException"
    with session(u) as s:
        d = dashboard(s, b, today=date(2026, 10, 7))
    assert d["spent_this_month"] == 0 and d["top_categories_this_month"] == []
    with pytest.raises(DBAPIError, match="expense categories"):
        run(u, "insert into budgets (book_id, category_id, period, amount) values (:b, :c, 'monthly', 1)", b=b, c=saving)
    assert refused(u, "update categories set kind = 'expense' where id = :c", c=saving) == "RaiseException"
    with pytest.raises(DBAPIError, match="opening"):
        add(u, b, "opening_balance", date(2026, 10, 2), [(chk, 1)], saving)

    # All of it reaches the export.
    with session(u) as s:
        z = zipfile.ZipFile(io.BytesIO(build_export(s)))
    acc = {r["Tài khoản"]: r["Tính vào tài sản ròng"]
           for r in csv.DictReader(io.StringIO(z.read("accounts.csv").decode("utf-8-sig")))}
    assert acc == {"Checking": "Có", "Mum's savings": "Không"}
    cats = {r["Danh mục"]: r["Màu"] for r in csv.DictReader(io.StringIO(z.read("categories.csv").decode("utf-8-sig")))}
    assert cats["Food"] == "#ef4444"
    txns = list(csv.DictReader(io.StringIO(z.read("transactions.csv").decode("utf-8-sig"))))
    assert [r["Danh mục"] for r in txns if r["Loại"] == "chuyển khoản"] == ["Tiết kiệm"]


# ---------------------------------------------------------------- plans, AI keys, export

def test_plans_and_subscriptions(database):
    """R-PLAN-1..2, R-AI-3, R-SEC-5: AI is paid by whoever turns it on; subscriptions only via webhook; limits in the database."""
    free, paid, friend = new_user("plan_free"), new_user("plan_paid"), new_user("plan_friend")
    fb, pb = new_book(free), new_book(paid)

    # Free plan: no AI without an own key.
    with pytest.raises(DBAPIError, match="AI needs Premium or your own AI key"):
        run(free, "insert into ai_settings (book_id, enabled) values (:b, true)", b=fb)

    # Nobody can give themselves a plan from the app.
    assert refused(free, "insert into subscriptions (user_id, plan, status, store, store_subscription_id, current_period_end)"
                         " values (:u, 'premium', 'active', 'stripe', 'x', now() + interval '1 year')", u=free) == "InsufficientPrivilege"

    # Paid via webhook: AI works; when the period ends it stops on its own.
    subscribe(paid)
    assert q(paid, "select plan from my_profile()")[0][0] == "premium"
    assert refused(free, "select user_plan(:u)", u=paid) == "InsufficientPrivilege"         # others' plans are private
    run(paid, "insert into ai_settings (book_id, enabled) values (:b, true)", b=pb)
    assert q(paid, "select ai_entitlement(:b)", b=pb)[0][0] == "plan"
    subscribe(paid, days=-1)
    assert q(paid, "select (select plan from my_profile()), ai_entitlement(:b)", b=pb)[0] == ("free", None)
    assert q(friend, "select count(*) from subscriptions")[0][0] == 0           # can't see others' billing

    # The webhook updates a subscription by the store's id, and can read nothing else.
    subscribe(paid)
    bill = create_engine(_url("t_bill"))
    with bill.begin() as c:
        assert c.execute(text("update subscriptions set status = 'canceled', updated_at = now()"
                              " where store_subscription_id = :s"), {"s": f"sub_{paid.hex}"}).rowcount == 1
    for sql in ("select * from accounts", "select id from users"):
        with bill.connect() as c, pytest.raises(DBAPIError):
            c.execute(text(sql))
    bill.dispose()
    assert q(paid, "select plan from my_profile()")[0][0] == "free"

    # In a shared book, the owner who turns AI on pays: a Premium co-owner can
    # turn it on in a book a free user created.
    subscribe(paid)
    share(free, fb, paid, "owner")
    run(paid, "insert into ai_settings (book_id, enabled) values (:b, true)", b=fb)
    assert q(free, "select ai_entitlement(:b)", b=fb)[0][0] == "plan"
    # Another owner can't make someone else the payer: only turning AI on does that.
    run(free, "update ai_settings set consented_by = :f, include_payees = true where book_id = :b", f=free, b=fb)
    assert q(free, "select consented_by, include_payees from ai_settings where book_id = :b", b=fb)[0] == (paid, True)

    # Sharing can be made paid by changing one row; the creator's plan decides.
    with database.connect() as c:
        c.execute(text("update plans set max_members_per_book = 1, max_books = 2 where code = 'free'"))
    try:
        with pytest.raises(DBAPIError, match="plan_limit"):
            share(free, fb, friend, "editor")
        new_book(free)
        with pytest.raises(DBAPIError, match="plan_limit"):
            new_book(free)                                                     # third book
        subscribe(paid)
        share(paid, pb, friend, "editor")                                      # premium creator: allowed
    finally:
        with database.connect() as c:
            c.execute(text("update plans set max_members_per_book = null, max_books = null where code = 'free'"))


def test_bring_your_own_ai_key(monkeypatch):
    """R-AI-4: free users can use their own AI key; it's stored encrypted and never readable by the app."""
    import base64
    monkeypatch.setenv("AI_KEY_ENCRYPTION_KEY", base64.b64encode(os.urandom(32)).decode())
    from app.domain import ai_keys
    u, member = new_user("byok_user"), new_user("byok_member")
    b = new_book(u)
    share(u, b, member, "viewer")
    secret = "sk-test-0123456789abcd"
    with session(u) as s:
        assert ai_keys.save_key(s, u, "anthropic", secret) == "abcd"
    run(u, "insert into ai_settings (book_id, enabled, key_provider) values (:b, true, 'anthropic')", b=b)
    assert q(u, "select ai_entitlement(:b)", b=b)[0][0] == "own_key"

    assert q(u, "select provider, key_hint from user_ai_keys")[0] == ("anthropic", "abcd")
    assert refused(u, "select key_ciphertext from user_ai_keys") == "InsufficientPrivilege"
    assert q(member, "select count(*) from user_ai_keys")[0][0] == 0
    with session(u) as s:                                                       # app can't call the job's function
        with pytest.raises(DBAPIError):
            s.execute(text("select * from ai_key_for_book(:b)"), {"b": b})

    ai = create_engine(_url("t_ai"))
    with ai.begin() as c:
        c.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(member)})
        assert ai_keys.key_for_book(c, b) == ("anthropic", secret)
        blob = bytes(c.execute(text("select key_ciphertext from ai_key_for_book(:b)"), {"b": b}).scalar())
    assert secret.encode() not in blob
    with pytest.raises(InvalidTag):
        ai_keys.decrypt(blob, member, "anthropic")                              # bound to its owner
    ai.dispose()

    run(u, "delete from user_ai_keys")                                          # key removed: AI stops
    assert q(u, "select ai_entitlement(:b)", b=b)[0][0] is None


def test_csv_export():
    """R-EXP-1..2, R-CON-3, R-LANG-1: users download all their data as readable CSV, in their language."""
    import csv
    import io
    import re
    import zipfile
    from app.domain.export import build_export
    u, partner = new_user("exp_user"), new_user("exp_partner")
    assert q(partner, "select language from my_profile()")[0][0] == "vi"                # Vietnamese by default
    run(u, "update users set language = 'en' where id = :u", u=u)
    b = new_book(u, "VND", name="Gia dinh")
    share(u, b, partner, "editor")
    cash, card = new_account(u, b, "Tien mat", "cash"), new_account(u, b, "Visa", "credit_card", "USD")
    food = new_category(u, b, "An uong")
    add(u, b, "opening_balance", date(2026, 10, 1), [(cash, 5000000)])
    add(partner, b, "expense", date(2026, 10, 2), [(cash, -125000)], food, "Pho 24")
    add(u, b, "transfer", date(2026, 10, 3), [(cash, -2500000), (card, 10000)])

    with session(u) as s:
        z = zipfile.ZipFile(io.BytesIO(build_export(s, site_url="https://msaving.example/")))
    names = set(z.namelist())
    assert "consents.csv" in names
    assert {"README.txt", "profile.csv", "books.csv", "accounts.csv", "transactions.csv", "edit_history.csv",
            "ai_advice.csv", "subscription.csv", "my_activity.csv"} <= names

    def read(name):
        return list(csv.DictReader(io.StringIO(z.read(name).decode("utf-8-sig"))))

    assert read("profile.csv")[0]["Email"] == "exp_user@example.com"
    consent = read("consents.csv")
    assert [(r["Agreed to"], r["Policy version"], r["Policy text"], r["Withdrawn at"]) for r in consent] == \
        [("Privacy policy (to use the app)", POLICY, "https://msaving.example/privacy/dev-2026-10-01", "")] \
        and consent[0]["Agreed at"]
    txns = read("transactions.csv")
    pho = next(t for t in txns if t["Payee"] == "Pho 24")
    assert (pho["Amount"], pho["Currency"], pho["Category"], pho["Added by"]) == ("-125000", "VND", "An uong", "exp_partner")
    transfer = next(t for t in txns if t["Type"] == "transfer")
    assert (transfer["Account"], transfer["To account"], transfer["Amount received"], transfer["Received currency"]) == \
        ("Tien mat", "Visa", "100.00", "USD")
    assert "exp_partner (editor)" in read("books.csv")[0]["Members"]
    history = {r["Payee"] or r["Type"]: r["Amounts"] for r in read("edit_history.csv")}
    assert history["Pho 24"] == "Tien mat: -125000 VND"
    assert history["transfer"] == "Tien mat: -2500000 VND / Visa: 100.00 USD"

    # The partner's export is in Vietnamese: labels and fixed values, not what people typed.
    with session(partner) as s:
        zv = zipfile.ZipFile(io.BytesIO(build_export(s)))
    assert zv.read("README.txt").decode().startswith("Dữ liệu của bạn")
    vt = list(csv.DictReader(io.StringIO(zv.read("transactions.csv").decode("utf-8-sig"))))
    vtransfer = next(t for t in vt if t["Loại"] == "chuyển khoản")
    assert (vtransfer["Tài khoản"], vtransfer["Số tiền nhận"]) == ("Tien mat", "100.00")
    assert "exp_partner (người chỉnh sửa)" in next(csv.DictReader(io.StringIO(zv.read("books.csv").decode("utf-8-sig"))))["Thành viên"]

    everything = "".join(z.read(n).decode("utf-8-sig") for n in names)
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", everything)   # no internal ids
    assert "exp_partner@example.com" not in everything                                                   # others' emails


def test_one_shared_book_free():
    """R-PLAN-3: one shared book is free, more need a paid plan; joining others' books is always free."""
    free, paid, a, b2 = new_user("sh_free"), new_user("sh_paid"), new_user("sh_a"), new_user("sh_b")
    first, second = new_book(free), new_book(free)
    share(free, first, a, "editor")
    share(free, first, b2, "viewer")                      # more people in the same shared book: fine
    with pytest.raises(DBAPIError, match="1 shared book"):
        share(free, second, a, "editor")
    run(free, "delete from book_members where book_id = :b and user_id <> :u", b=first, u=free)
    share(free, second, a, "editor")                       # unsharing the first frees the slot

    # Joining other people's books never counts.
    for owner in (new_user("sh_o1"), new_user("sh_o2")):
        share(owner, new_book(owner), free, "editor")

    subscribe(free)
    share(free, first, b2, "viewer")                       # premium: unlimited
    subscribe(paid)
    for _ in range(3):
        share(paid, new_book(paid), a, "viewer")


def test_supabase_api_roles_have_no_access(database):
    """R-SEC-3: Supabase's anon/authenticated roles can't reach any table or function, now or added later."""
    with database.connect() as c:
        for role in ("anon", "authenticated"):
            for table in ("fx_rates", "plans", "currencies", "users", "transactions", "subscriptions"):
                assert not c.execute(text("select has_table_privilege(:r, :t, 'select') or has_table_privilege(:r, :t, 'insert')"),
                                     {"r": role, "t": f"public.{table}"}).scalar(), (role, table)
            for fn in ("find_user_by_username(text)", "user_plan(uuid)", "purge_deleted_accounts()"):
                assert not c.execute(text("select has_function_privilege(:r, :f, 'execute')"),
                                     {"r": role, "f": f"public.{fn}"}).scalar(), (role, fn)
        # Nor what later migrations add (created by the same role that ran these).
        c.exec_driver_sql("create function public.t_later() returns int language sql as 'select 1';"
                          " create table public.t_later_table (x int)")
        try:
            for role in ("anon", "authenticated", "public"):
                assert not c.execute(text("select has_function_privilege(:r, 'public.t_later()', 'execute')"),
                                     {"r": role}).scalar(), role
            for role in ("anon", "authenticated"):
                assert not c.execute(text("select has_table_privilege(:r, 'public.t_later_table', 'select')"),
                                     {"r": role}).scalar(), role
        finally:
            c.exec_driver_sql("drop function public.t_later(); drop table public.t_later_table")
