"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import csv
import re
import uuid

import pytest
from sqlalchemy import text

TOKENS: dict[uuid.UUID, str] = {}
PASSWORD = "correct horse battery"


@pytest.fixture(scope="module")
def client(database):
    from fastapi.testclient import TestClient

    from app.api.main import app
    from app.core import sign_in
    saved = sign_in.sign_ups_per_ip, sign_in.per_ip
    sign_in.sign_ups_per_ip = sign_in.per_ip = sign_in.RateLimit(100_000, 60)    # every test signs up from one address
    yield TestClient(app)
    sign_in.sign_ups_per_ip, sign_in.per_ip = saved


def auth(uid):
    return {"Authorization": f"Bearer {TOKENS[uid]}"}


def signed_up(client, name=None, language=None):
    name = name or f"u{uuid.uuid4().hex[:10]}"
    body = {"username": name, "password": PASSWORD, "timezone": "Asia/Ho_Chi_Minh"}
    r = client.post("/v1/auth/sign-up", json=body | ({"language": language} if language else {}))
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    uid = uuid.UUID(client.get("/v1/me", headers={"Authorization": f"Bearer {token}"}).json()["id"])
    TOKENS[uid] = token
    return uid


def test_health_needs_no_token(client):
    r = client.get("/v1/health")
    assert r.json() == {"ok": True}
    assert r.headers["cache-control"] == "no-store"


def test_instance_needs_no_token(client):
    r = client.get("/v1/instance").json()
    assert r["api_version"] == 1 and r["signup"] == "open" and r["name"] == "MSaving"
    assert set(r) == {"name", "server_version", "api_version", "signup", "setup_needed"}


def test_me_returns_only_my_profile(client):
    mine, other = signed_up(client, f"me_{uuid.uuid4().hex[:8]}"), signed_up(client)
    r = client.get("/v1/me", headers=auth(mine))
    assert r.status_code == 200 and r.json()["id"] == str(mine)
    profile = r.json()["profile"]
    assert profile["username"].startswith("me_") and profile["language"] == "en" and profile["is_admin"] is False
    assert set(profile) == {"username", "display_name", "timezone", "language", "created_at", "deletion_requested_at",
                            "is_admin", "idle_sign_out_minutes"}
    assert client.get("/v1/me", headers=auth(other)).json()["id"] == str(other)


@pytest.mark.parametrize("bad", ["no-token", "", "not-a-token", "Basic abc", "a-jwt"])
def test_bad_tokens_are_refused(client, bad):
    headers = {
        "no-token": {},
        "Basic abc": {"Authorization": "Basic abc"},
        "a-jwt": {"Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"},
    }.get(bad, {"Authorization": f"Bearer {bad}"})
    r = client.get("/v1/me", headers=headers)
    assert (r.status_code, r.json()) == (401, {"detail": "not_signed_in"})


def test_only_this_servers_web_app_and_any_phone(client):
    u = signed_up(client)
    other = client.get("/v1/me", headers={**auth(u), "Origin": "https://copy-of-msaving.example"})
    assert (other.status_code, other.json()) == (403, {"detail": "origin_not_allowed"})
    assert client.post("/v1/auth/sign-in", headers={"Origin": "null"}, json={"username": "x", "password": "y"}).status_code == 403
    assert client.get("/v1/me", headers={**auth(u), "Origin": "http://testserver"}).status_code == 200        # its own web app
    behind_proxy = {**auth(u), "Origin": "https://money.example.com", "X-Forwarded-Host": "money.example.com"}
    assert client.get("/v1/me", headers=behind_proxy).status_code == 200
    assert client.get("/v1/me", headers=auth(u)).status_code == 200                                         # a phone
    assert client.get("/", headers={"Origin": "https://elsewhere.example"}).status_code in (200, 404)       # pages aren't API calls


def test_no_cors_by_default(client):
    preflight = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    r = client.options("/v1/me", headers={"Origin": "http://evil.test", **preflight})
    assert "access-control-allow-origin" not in r.headers       # the web app is served from the API's own origin


def test_unknown_api_paths_are_404_not_the_web_app(client):
    r = client.get("/v1/nothing-here")
    assert (r.status_code, r.json()) == (404, {"detail": "not_found"})


def test_web_app_files_and_routes(client, tmp_path, monkeypatch):
    from app.core import settings
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "assets" / "a.js").write_text("js")
    monkeypatch.setattr(settings, "settings", settings.Settings(web_dir=tmp_path))
    import app.api.main as main
    monkeypatch.setattr(main, "settings", settings.settings)
    page = client.get("/join?code=X")
    assert page.text == "<html>app</html>" and "default-src 'self'" in page.headers["content-security-policy"]
    assert page.headers["referrer-policy"] == "no-referrer"
    asset = client.get("/assets/a.js")
    assert asset.text == "js" and "immutable" in asset.headers["cache-control"]
    assert client.get("/../../etc/passwd").text == "<html>app</html>"        # never outside the web app's folder


def test_currencies(client):
    ccy = {c["code"]: c for c in client.get("/v1/currencies", headers=auth(signed_up(client))).json()}
    assert ccy["VND"]["minor_unit"] == 0 and ccy["KWD"]["minor_unit"] == 3 and len(ccy) == 155


def test_books(client):
    owner, stranger = signed_up(client, language="vi"), signed_up(client)
    bid = str(uuid.uuid4())
    new = {"id": bid, "name": "Gia đình", "base_currency": "VND", "timezone": "Asia/Ho_Chi_Minh"}
    r = client.post("/v1/books", headers=auth(owner), json=new)
    assert r.status_code == 201
    assert r.json() | {"version": 1} == {**new, "role": "owner", "archived_at": None, "version": 1}
    assert client.post("/v1/books", headers=auth(owner), json={**new, "name": "retry"}).json()["name"] == "Gia đình"
    assert [b["id"] for b in client.get("/v1/books", headers=auth(owner)).json()] == [bid]
    from app.core import db
    with db.user_session(owner) as s:                  # starter categories, in the owner's language
        assert s.execute(text("select count(*) from categories where book_id = :b and name = 'Thiết yếu'"), {"b": bid}).scalar() == 1

    for method, path in (("get", f"/v1/books/{bid}"), ("get", f"/v1/books/{bid}/accounts"),
                         ("patch", f"/v1/books/{bid}"), ("delete", f"/v1/books/{bid}?version=1")):
        r = client.request(method, path, headers=auth(stranger), json={"version": 1, "name": "x"} if method == "patch" else None)
        assert (r.status_code, r.json()) == (404, {"detail": "not_found"})
    assert client.post("/v1/books", headers=auth(stranger), json=new).json() == {"detail": "conflict"}    # someone else's id

    v = client.get(f"/v1/books/{bid}", headers=auth(owner)).json()["version"]
    ok = client.patch(f"/v1/books/{bid}", headers=auth(owner), json={"version": v, "name": "Nhà", "timezone": "UTC"})
    assert (ok.json()["name"], ok.json()["timezone"], ok.json()["version"]) == ("Nhà", "UTC", v + 1)
    stale = client.patch(f"/v1/books/{bid}", headers=auth(owner), json={"version": v, "name": "old tab"})
    assert (stale.status_code, stale.json()) == (409, {"detail": "conflict"})
    plain = client.post("/v1/books", headers=auth(owner), json={**new, "id": str(uuid.uuid4()), "starter_categories": False})
    with db.user_session(owner) as s:
        assert s.execute(text("select count(*) from categories where book_id = :b"), {"b": plain.json()["id"]}).scalar() == 0
    assert client.delete(f"/v1/books/{bid}?version={v}", headers=auth(owner)).status_code == 409
    assert client.delete(f"/v1/books/{bid}?version={v + 1}", headers=auth(owner)).status_code == 204
    assert client.get(f"/v1/books/{bid}", headers=auth(owner)).status_code == 404


def test_accounts_with_opening_balances(client):
    u = signed_up(client)
    bid = str(uuid.uuid4())
    client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": "VND", "timezone": "UTC"})
    base = f"/v1/books/{bid}/accounts"
    cash = {"id": str(uuid.uuid4()), "name": "Tiền mặt", "kind": "cash", "opening_balance": 5_000_000, "opened_on": "2026-10-01"}
    r = client.post(base, headers=auth(u), json=cash)
    assert r.status_code == 201
    assert (r.json()["currency"], r.json()["balance"]) == ("VND", 5_000_000)
    assert client.post(base, headers=auth(u), json=cash).json()["balance"] == 5_000_000      # retry: not twice
    card = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Visa", "kind": "credit_card",
                                                     "currency": "USD", "last4": "4242", "opening_balance": -45000}).json()
    assert (card["currency"], card["balance"], card["last4"]) == ("USD", -45000, "4242")
    dup = client.post(base, headers=auth(u), json={**cash, "id": str(uuid.uuid4())})
    assert (dup.status_code, dup.json()) == (409, {"detail": "name_taken"})
    assert client.post(base, headers=auth(u), json={**cash, "id": str(uuid.uuid4()), "name": "x", "last4": "123456"}).status_code == 422

    locked = client.patch(f"{base}/{cash['id']}", headers=auth(u), json={"version": 1, "currency": "USD"})
    assert (locked.status_code, locked.json()) == (409, {"detail": "currency_locked"})
    out = client.patch(f"{base}/{card['id']}", headers=auth(u), json={"version": 1, "in_net_worth": False, "last4": ""}).json()
    assert (out["in_net_worth"], out["last4"], out["version"]) == (False, None, 2)
    archived = client.patch(f"{base}/{card['id']}", headers=auth(u), json={"version": 2, "archived": True}).json()
    assert archived["archived_at"] is not None
    assert [a["name"] for a in client.get(base, headers=auth(u)).json()] == ["Tiền mặt"]
    assert len(client.get(f"{base}?include_archived=true", headers=auth(u)).json()) == 2
    back = client.patch(f"{base}/{card['id']}", headers=auth(u), json={"version": 3, "archived": False}).json()
    assert back["archived_at"] is None


def new_book_with_accounts(client, u, currency="VND"):
    bid = str(uuid.uuid4())
    client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": currency, "timezone": "UTC",
                                                    "starter_categories": False})
    accts = {}
    for name, kind, opening in (("Cash", "cash", 1_000_000), ("Bank", "checking", 5_000_000)):
        aid = str(uuid.uuid4())
        client.post(f"/v1/books/{bid}/accounts", headers=auth(u),
                    json={"id": aid, "name": name, "kind": kind, "opening_balance": opening, "opened_on": "2026-10-01"})
        accts[name] = aid
    return bid, accts


def add_category(client, u, bid, name, kind="expense", parent=None):
    cid = str(uuid.uuid4())
    r = client.post(f"/v1/books/{bid}/categories", headers=auth(u),
                    json={"id": cid, "name": name, "kind": kind, "parent_id": parent, "color": "#2563EB"})
    assert r.status_code == 201, r.text
    return r.json()


def test_account_details_by_kind(client):
    """A detail for the wrong kind is refused; changing the kind clears the ones that stop applying."""
    u = signed_up(client)
    bid, _ = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/accounts"

    def create(kind, **details):
        return client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": f"{kind} {uuid.uuid4().hex[:6]}",
                                                        "kind": kind, **details})

    card = create("credit_card", last4="3317", note="  Thẻ chính  ", credit_limit=50_000_000, annual_fee=499_000,
                  statement_day=25, payment_due_day=10, interest_rate_bp=2_800)
    assert card.status_code == 201
    assert {k: card.json()[k] for k in ("note", "credit_limit", "annual_fee", "statement_day", "payment_due_day",
                                        "interest_rate_bp")} == {"note": "Thẻ chính", "credit_limit": 50_000_000,
        "annual_fee": 499_000, "statement_day": 25, "payment_due_day": 10, "interest_rate_bp": 2_800}
    assert create("savings", interest_rate_bp=475).json()["interest_rate_bp"] == 475
    assert create("cash", note="Ví").json()["note"] == "Ví"
    for kind, details in (("cash", {"credit_limit": 1}), ("checking", {"interest_rate_bp": 100}), ("lent", {"statement_day": 3}),
                          ("credit_card", {"statement_day": 32}), ("credit_card", {"credit_limit": -1}),
                          ("savings", {"interest_rate_bp": 100_001}), ("cash", {"note": "x" * 501})):
        assert create(kind, **details).status_code == 422, (kind, details)

    acc = card.json()
    url = f"{base}/{acc['id']}"
    same = client.patch(url, headers=auth(u), json={"version": acc["version"], "name": "Visa"}).json()       # left out: kept
    assert (same["credit_limit"], same["note"]) == (50_000_000, "Thẻ chính")
    cleared = client.patch(url, headers=auth(u), json={"version": same["version"], "note": None, "annual_fee": None}).json()
    assert (cleared["note"], cleared["annual_fee"], cleared["credit_limit"]) == (None, None, 50_000_000)
    assert client.patch(url, headers=auth(u), json={"version": cleared["version"], "kind": "loan", "credit_limit": 1}).status_code == 422
    loan = client.patch(url, headers=auth(u), json={"version": cleared["version"], "kind": "loan"}).json()
    assert {k: loan[k] for k in ("kind", "credit_limit", "statement_day", "payment_due_day", "interest_rate_bp")} == {
        "kind": "loan", "credit_limit": None, "statement_day": None, "payment_due_day": 10, "interest_rate_bp": 2_800}
    assert loan["installment"] is None                                  # a loan's payment day stays
    cash = client.patch(url, headers=auth(u), json={"version": loan["version"], "kind": "cash"}).json()
    assert (cash["kind"], cash["interest_rate_bp"], cash["payment_due_day"]) == ("cash", None, None)

    # The export has them, readable: amounts in the currency, the rate as a percentage.
    import csv
    import io
    import zipfile
    create("credit_card", note="Thẻ phụ", credit_limit=20_000_000, statement_day=5, payment_due_day=20, interest_rate_bp=2_550)
    create("loan", note="Điện thoại", installment=1_000_000, installment_fee=240_000, payment_due_day=15)
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    rows = {r["Note"]: r for r in csv.DictReader(io.StringIO(z.read("accounts.csv").decode("utf-8-sig")))}
    assert {k: rows["Thẻ phụ"][k] for k in ("Credit limit", "Annual fee", "Statement day", "Payment due day",
                                            "Interest rate (% a year)")} == {"Credit limit": "20000000", "Annual fee": "",
        "Statement day": "5", "Payment due day": "20", "Interest rate (% a year)": "25.50"}
    assert {k: rows["Điện thoại"][k] for k in ("Monthly installment", "Installment fee", "Payment due day")} == {
        "Monthly installment": "1000000", "Installment fee": "240000", "Payment due day": "15"}


def test_bill_dates():
    """The statement day's own transactions belong to its statement; a month without that day uses its
    last; a card is due on the first repayment day after the statement date, a loan on its next payment day."""
    from datetime import date as d

    from app.domain.bills import first_after, last_statement, next_on_or_after
    assert last_statement(d(2026, 10, 20), 25) == d(2026, 9, 25)
    assert last_statement(d(2026, 9, 25), 25) == d(2026, 8, 25)            # the statement day itself is still open
    assert last_statement(d(2026, 9, 26), 25) == d(2026, 9, 25)
    assert last_statement(d(2027, 3, 10), 31) == d(2027, 2, 28)            # February has no 31st
    assert last_statement(d(2027, 1, 5), 25) == d(2026, 12, 25)
    assert first_after(d(2026, 9, 25), 10) == d(2026, 10, 10) and first_after(d(2026, 9, 5), 25) == d(2026, 9, 25)
    assert first_after(d(2026, 12, 25), 10) == d(2027, 1, 10)
    assert next_on_or_after(d(2026, 10, 15), 15) == d(2026, 10, 15) and next_on_or_after(d(2026, 10, 16), 15) == d(2026, 11, 15)


def test_monthly_bills(client, database):
    """A credit card's bill is its statement balance minus the money in since; a loan's is its
    installment, with a one-off fee on the first payment and the interest part recorded as an expense."""
    from datetime import date as d
    from types import SimpleNamespace

    from sqlalchemy.orm import Session

    from app.domain.bills import bill_for, fee_transaction_id, interest_transaction_id
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}"

    def account(kind, opening, opened_on="2026-08-01", **details):
        r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": f"{kind} {uuid.uuid4().hex[:6]}",
                        "kind": kind, "opening_balance": opening, "opened_on": opened_on, **details})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    def txn(type_, day, *entries, txn_id=None):
        r = client.post(f"{base}/transactions", headers=auth(u), json={"id": str(txn_id or uuid.uuid4()), "type": type_,
                        "occurred_on": day, "entries": [{"account_id": a, "amount": m} for a, m in entries]})
        assert r.status_code == 201, r.text

    def bill(account_id, today):
        a = SimpleNamespace(**next(x for x in client.get(f"{base}/accounts", headers=auth(u)).json() if x["id"] == account_id))
        a.id = uuid.UUID(a.id)
        with Session(database) as s:
            return bill_for(s, a, today)

    # A card owing 1,000,000 from before, statement on the 25th, due on the 10th.
    card = account("credit_card", -1_000_000, statement_day=25, payment_due_day=10, credit_limit=10_000_000)
    txn("expense", "2026-09-05", (card, -300_000))
    txn("expense", "2026-09-25", (card, -200_000))                      # on the statement day: in that statement
    txn("expense", "2026-09-26", (card, -50_000))                       # the next statement's
    txn("refund", "2026-09-30", (card, 20_000))
    txn("transfer", "2026-10-05", (accts["Bank"], -400_000), (card, 400_000))
    b = bill(card, d(2026, 10, 20))
    assert (b.kind, b.period_start, b.period_end, b.due_on) == ("card", d(2026, 8, 26), d(2026, 9, 25), d(2026, 10, 10))
    assert (b.amount, b.paid, b.remaining, b.owed_now) == (1_500_000, 420_000, 1_080_000, 1_130_000)
    assert b.pay_from == uuid.UUID(accts["Bank"])
    txn("transfer", "2026-10-09", (accts["Bank"], -1_080_000), (card, 1_080_000))
    assert bill(card, d(2026, 10, 20)).remaining == 0
    assert bill(card, d(2026, 9, 25)).period_end == d(2026, 8, 25)

    # A 0 % installment contract: 12,000,000 over 12 months, a 240,000 fee with the first payment.
    phone = account("loan", -12_000_000, "2026-10-01", installment=1_000_000, payment_due_day=15, installment_fee=240_000)
    b = bill(phone, d(2026, 10, 20))
    assert (b.kind, b.due_on, b.amount, b.fee, b.interest, b.paid, b.remaining) == ("loan", d(2026, 11, 15), 1_240_000,
                                                                                   240_000, 0, 0, 1_240_000)
    assert b.fee_transaction_id == fee_transaction_id(uuid.UUID(phone))
    txn("expense", "2026-10-20", (phone, -240_000), txn_id=b.fee_transaction_id)                # what Pay records
    txn("transfer", "2026-10-20", (accts["Bank"], -1_240_000), (phone, 1_240_000))
    b = bill(phone, d(2026, 10, 20))
    assert (b.amount, b.fee, b.remaining, b.owed_now) == (1_000_000, 0, 0, 11_000_000)     # the fee once; down by 1,000,000
    assert bill(phone, d(2026, 11, 16)).remaining == 1_000_000          # the next month's, without the fee

    # 12 % a year: the month's interest is the part of the installment recorded as an expense.
    car = account("loan", -10_000_000, "2026-10-01", installment=500_000, payment_due_day=15, interest_rate_bp=1_200)
    b = bill(car, d(2026, 10, 20))
    assert (b.amount, b.interest, b.fee, b.remaining) == (500_000, 100_000, 0, 500_000)
    assert b.interest_transaction_id == interest_transaction_id(uuid.UUID(car), d(2026, 11, 15))
    txn("expense", "2026-10-20", (car, -100_000), txn_id=b.interest_transaction_id)
    txn("transfer", "2026-10-20", (accts["Bank"], -200_000), (car, 200_000))                  # paid in two parts
    b = bill(car, d(2026, 10, 20))
    assert (b.amount, b.interest, b.remaining) == (500_000, 0, 300_000)                       # the interest once a month
    txn("transfer", "2026-10-21", (accts["Bank"], -300_000), (car, 300_000))
    b = bill(car, d(2026, 10, 21))
    assert (b.amount, b.remaining, b.owed_now) == (500_000, 0, 9_600_000)                      # principal 400,000

    # The last installment is what's left.
    last = account("loan", -300_000, "2026-10-01", installment=500_000, payment_due_day=15)
    assert (bill(last, d(2026, 10, 20)).amount, bill(last, d(2026, 10, 20)).remaining) == (300_000, 300_000)

    # The API: today's bill; none for other kinds or without what a bill needs; not someone else's.
    assert client.get(f"{base}/accounts/{card}/bill", headers=auth(u)).json()["kind"] == "card"
    assert client.get(f"{base}/accounts/{accts['Cash']}/bill", headers=auth(u)).json() is None
    no_days = account("credit_card", 0)
    assert client.get(f"{base}/accounts/{no_days}/bill", headers=auth(u)).json() is None
    assert client.get(f"{base}/accounts/{card}/bill", headers=auth(signed_up(client))).status_code == 404

    # Loan details: only on loans, an installment above 0; a card can't have them.
    for kind, details in (("credit_card", {"installment": 1}), ("cash", {"installment_fee": 1}), ("loan", {"installment": 0}),
                          ("cash", {"payment_due_day": 5})):
        r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": uuid.uuid4().hex[:8],
                        "kind": kind, **details})
        assert r.status_code == 422, (kind, details)


def test_installment_plans(client, database):
    """R-ACC-8: a card purchase paid in installments stays one expense for its full amount; each statement bills one
    installment per plan, the fee at once or split into the installments, nothing charged twice; ending early bills
    the rest; the unbilled part counts toward the limit unless the plan says otherwise."""
    from datetime import date as d
    from types import SimpleNamespace

    from sqlalchemy.orm import Session

    from app.domain.bills import bill_for, installment_plans
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}"

    def account(kind, **details):
        r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": f"{kind} {uuid.uuid4().hex[:6]}",
                        "kind": kind, "opening_balance": 0, "opened_on": "2026-08-01", **details})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    def txn(type_, day, *entries, txn_id=None, payee=None):
        txn_id = str(txn_id or uuid.uuid4())
        r = client.post(f"{base}/transactions", headers=auth(u), json={"id": txn_id, "type": type_, "occurred_on": day,
                        "payee": payee, "entries": [{"account_id": a, "amount": m} for a, m in entries]})
        assert r.status_code == 201, r.text
        return txn_id

    def plan(transaction_id, as_user=None, **fields):
        return client.post(f"{base}/installments", headers=auth(as_user or u),
                           json={"id": str(uuid.uuid4()), "transaction_id": transaction_id, **fields})

    def bill(account_id, today):
        a = SimpleNamespace(**next(x for x in client.get(f"{base}/accounts", headers=auth(u)).json() if x["id"] == account_id))
        a.id = uuid.UUID(a.id)
        with Session(database) as s:
            return bill_for(s, a, today)

    # A card with its statement on the 25th, due on the 10th; a laptop for 6,000,000 over 6 months, a 120,000 fee.
    card = account("credit_card", statement_day=25, payment_due_day=10, credit_limit=20_000_000)
    laptop = txn("expense", "2026-09-10", (card, -6_000_000), payee="Laptop")
    txn("expense", "2026-09-15", (card, -300_000))
    r = plan(laptop, months=6, fee=120_000)
    assert r.status_code == 201, r.text
    p = r.json()
    assert (p["account_id"], p["months"], p["converted_on"], p["first_statement"], p["fee"], p["fee_split"]) == (
        card, 6, "2026-09-10", "2026-09-25", 120_000, False)
    assert (p["counts_toward_limit"], p["ended_on"], p["installment"], p["version"]) == (True, None, 1_000_000, 1)
    r = plan(laptop, months=3)
    assert (r.status_code, r.json()) == (409, {"detail": "installment_exists"})       # one plan per purchase

    # The September statement: 300,000 plus the first installment, and the whole fee.
    b = bill(card, d(2026, 10, 1))
    assert (b.amount, b.fee) == (1_420_000, 120_000)
    assert [(i["number"], i["months"], i["amount"]) for i in b.installments] == [(1, 6, 1_000_000)]
    [fee] = b.fees
    assert fee["amount"] == 120_000
    txn("expense", "2026-10-02", (card, -120_000), txn_id=fee["transaction_id"])           # what Pay records
    txn("transfer", "2026-10-02", (accts["Bank"], -1_420_000), (card, 1_420_000))
    b = bill(card, d(2026, 10, 3))
    assert (b.amount, b.fee, b.fees, b.remaining) == (1_300_000, 0, [], 0)                 # the fee once

    # October: the second installment only; the balance still says what's owed.
    b = bill(card, d(2026, 11, 1))
    assert (b.amount, b.owed_now) == (1_000_000, 5_000_000)
    assert [i["number"] for i in b.installments] == [2]
    assert b.limit_used == 5_000_000
    r = client.patch(f"{base}/installments/{p['id']}", headers=auth(u), json={"version": 1, "counts_toward_limit": False})
    assert r.status_code == 200 and r.json()["version"] == 2
    assert bill(card, d(2026, 11, 1)).limit_used == 1_000_000          # the 4,000,000 not billed yet doesn't count
    txn("transfer", "2026-11-05", (accts["Bank"], -1_000_000), (card, 1_000_000))

    # A phone bought on the 30th, converted on 2 November: its first installment is on the November statement,
    # and its fee is split into the three.
    phone = txn("expense", "2026-10-30", (card, -3_000_000), payee="Phone")
    r = plan(phone, months=3, converted_on="2026-11-02", fee=100_000, fee_split=True)
    assert r.status_code == 201 and r.json()["first_statement"] == "2026-11-25"
    assert bill(card, d(2026, 11, 3)).amount == 1_000_000              # not on the October statement
    b = bill(card, d(2026, 11, 26))
    assert b.amount == 2_033_333
    assert sorted((i["months"], i["number"], i["amount"]) for i in b.installments) == [(3, 1, 1_000_000), (6, 3, 1_000_000)]
    assert [f["amount"] for f in b.fees] == [33_333]

    # Paid off early: the rest is on the next statement.
    with Session(database) as s:
        lap = next(x for x in installment_plans(s, uuid.UUID(bid), d(2026, 11, 26)) if str(x["transaction_id"]) == laptop)
    assert (lap["billed"], lap["left_to_bill"]) == (3, 3_000_000)
    r = client.patch(f"{base}/installments/{lap['id']}", headers=auth(u), json={"version": lap["version"], "ended_on": "2026-11-28"})
    assert r.status_code == 200, r.text
    b = bill(card, d(2026, 12, 26))
    assert sorted((i["months"], i["number"], i["amount"]) for i in b.installments) == [(3, 2, 1_000_000), (6, 6, 3_000_000)]
    assert [f["amount"] for f in b.fees] == [33_333, 33_333]         # November's part was never recorded: it carries over

    # Editing the purchase's amount recalculates the plan; moving it off the card removes it.
    client.put(f"{base}/transactions/{phone}", headers=auth(u), json={"type": "expense", "occurred_on": "2026-10-30", "version": 1,
               "payee": "Phone", "entries": [{"account_id": card, "amount": -3_300_000}]})
    ph = next(x for x in client.get(f"{base}/installments", headers=auth(u)).json() if x["transaction_id"] == phone)
    assert ph["installment"] == 1_100_000
    r = client.put(f"{base}/transactions/{phone}", headers=auth(u), json={"type": "expense", "occurred_on": "2026-10-30", "version": 2,
                   "payee": "Phone", "entries": [{"account_id": accts["Cash"], "amount": -3_300_000}]})
    assert r.status_code == 200, r.text
    assert [x["transaction_id"] for x in client.get(f"{base}/installments", headers=auth(u)).json()] == [laptop]

    # Deleting the purchase deletes its plan.
    client.delete(f"{base}/transactions/{laptop}?version=1", headers=auth(u))
    assert client.get(f"{base}/installments", headers=auth(u)).json() == []

    # Only an expense on a credit card with a statement day, 2 to 60 months.
    cash_buy = txn("expense", "2026-10-01", (accts["Cash"], -500_000))
    no_day = account("credit_card")
    no_day_buy = txn("expense", "2026-10-01", (no_day, -500_000))
    refund = txn("refund", "2026-10-01", (card, 500_000))
    card_buy = txn("expense", "2026-10-01", (card, -500_000))
    for tid, fields in ((cash_buy, {"months": 3}), (no_day_buy, {"months": 3}), (refund, {"months": 3}),
                        (card_buy, {"months": 1}), (card_buy, {"months": 61}), (card_buy, {"months": 3, "fee": -1}),
                        (card_buy, {"months": 3, "converted_on": "2026-09-30"})):
        r = plan(tid, **fields)
        assert r.status_code == 422, (tid, fields, r.text)

    # Nobody else sees it; a viewer can't add one.
    assert client.get(f"{base}/installments", headers=auth(signed_up(client))).status_code == 404
    viewer_name = f"v_{uuid.uuid4().hex[:8]}"
    viewer = signed_up(client, viewer_name)
    client.post(f"{base}/members", headers=auth(u), json={"username": viewer_name, "role": "viewer"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(viewer))
    assert plan(card_buy, as_user=viewer, months=3).status_code == 403

    # The export lists them.
    assert plan(card_buy, months=3).status_code == 201
    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    rows = z.read("installments.csv").decode("utf-8-sig").splitlines()
    assert rows[0].startswith("Book,Card,Purchase,Date,Amount,Months") and len(rows) == 2


def test_categories(client):
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/categories"
    food = add_category(client, u, bid, "Ăn uống")
    out = add_category(client, u, bid, "Ăn ngoài", parent=food["id"])
    unused = add_category(client, u, bid, "Unused")
    savings = add_category(client, u, bid, "Tiết kiệm", kind="transfer")
    assert food["color"] == "#2563eb"
    assert {c["name"] for c in client.get(base, headers=auth(u)).json()} == {"Ăn uống", "Ăn ngoài", "Unused", "Tiết kiệm"}

    loop = client.patch(f"{base}/{food['id']}", headers=auth(u), json={"version": 1, "parent_id": out["id"]})
    assert (loop.status_code, loop.json()) == (422, {"detail": "invalid"})
    moved = client.patch(f"{base}/{out['id']}", headers=auth(u), json={"version": 1, "top_level": True, "color": ""}).json()
    assert (moved["parent_id"], moved["color"], moved["version"]) == (None, None, 2)
    client.patch(f"{base}/{out['id']}", headers=auth(u), json={"version": 2, "parent_id": food["id"]})

    client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
        "id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-02", "category_id": out["id"],
        "entries": [{"account_id": accts["Cash"], "amount": -50_000}]})
    assert client.delete(f"{base}/{unused['id']}?version=1", headers=auth(u)).json() == {"deleted": True, "archived": False}
    assert client.delete(f"{base}/{food['id']}?version=1", headers=auth(u)).json() == {"detail": "has_subcategories"}
    assert client.delete(f"{base}/{out['id']}?version=3", headers=auth(u)).json() == {"deleted": False, "archived": True}
    assert "Ăn ngoài" not in {c["name"] for c in client.get(base, headers=auth(u)).json()}
    assert "Ăn ngoài" in {c["name"] for c in client.get(f"{base}?include_archived=true", headers=auth(u)).json()}
    kind = client.patch(f"{base}/{out['id']}", headers=auth(u), json={"version": 4, "kind": "transfer"})
    assert (kind.status_code, kind.json()) == (422, {"detail": "category_kind"})
    assert client.patch(f"{base}/{savings['id']}", headers=auth(u), json={"version": 9, "name": "x"}).json() == {"detail": "conflict"}


def test_transactions_have_a_time_of_day(client):
    """R-TXN-6: every transaction has a date and a time of day; lists sort by both; one saved without a time has
    00:00, and an edit that leaves the time out keeps it."""
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"

    def add(payee, time=None):
        body = {"id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-05", "payee": payee,
                "entries": [{"account_id": accts["Cash"], "amount": -10_000}]} | ({"occurred_time": time} if time else {})
        return client.post(base, headers=auth(u), json=body).json()

    evening, morning, unset = add("Dinner", "18:45"), add("Coffee", "08:05"), add("Old app")
    assert (evening["occurred_time"], morning["occurred_time"], unset["occurred_time"]) == ("18:45:00", "08:05:00", "00:00:00")
    listed = client.get(base, headers=auth(u), params={"from": "2026-10-05", "to": "2026-10-05"}).json()["items"]
    assert [x["payee"] for x in listed] == ["Dinner", "Coffee", "Old app"]

    pages, after = [], None
    while True:
        page = client.get(base, headers=auth(u), params={"from": "2026-10-05", "limit": 1} | ({"after": after} if after else {})).json()
        pages += [x["payee"] for x in page["items"]]
        if not (after := page["next"]):
            break
    assert pages == ["Dinner", "Coffee", "Old app"]

    running = client.get(base, headers=auth(u), params={"account_id": accts["Cash"], "from": "2026-10-05"}).json()["items"]
    assert [x["running_balance"] for x in running] == [970_000, 980_000, 990_000]

    edit = {k: v for k, v in morning.items() if k in ("type", "occurred_on", "entries", "payee")} | {"version": morning["version"]}
    kept = client.put(f"{base}/{morning['id']}", headers=auth(u), json=edit).json()
    assert (kept["occurred_time"], kept["version"]) == ("08:05:00", 1)
    moved = client.put(f"{base}/{morning['id']}", headers=auth(u), json=edit | {"occurred_time": "21:00"}).json()
    assert (moved["occurred_time"], moved["version"]) == ("21:00:00", 2)
    history = client.get(f"{base}/{morning['id']}/history", headers=auth(u)).json()
    assert [h["occurred_time"] for h in history] == ["08:05:00", "21:00:00"]

    import csv
    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    times = {r["Payee"]: r["Time"] for r in csv.DictReader(io.StringIO(z.read("transactions.csv").decode("utf-8-sig")))}
    assert (times["Dinner"], times["Coffee"], times["Old app"]) == ("18:45", "21:00", "00:00")


def test_suggestions_from_my_own_history(client):
    """R-TXN-7: a new transaction is filled in from the user's own recent ones of the same type and a close amount
    (within 10 %, the last 90 days): the account, category and payee that make up at least 2 of the last 3."""
    from datetime import date, timedelta
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "editor")}
    owner, editor = (signed_up(client, names[k]) for k in ("owner", "editor"))
    bid, accts = new_book_with_accounts(client, owner)
    client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": names["editor"], "role": "editor"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(editor))
    parking = add_category(client, owner, bid, "Gửi xe")["id"]
    food = add_category(client, owner, bid, "Ăn uống")["id"]
    today = date.today()

    def add(u, amount, account, category, payee, days_ago=0, type_="expense"):
        r = client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": type_, "occurred_on": (today - timedelta(days=days_ago)).isoformat(),
            "category_id": category, "payee": payee,
            "entries": [{"account_id": accts[account], "amount": -amount if type_ == "expense" else amount}]})
        assert r.status_code == 201, r.text

    def suggest(u, amount, type_="expense"):
        r = client.get(f"/v1/books/{bid}/transactions/suggest", headers=auth(u), params={"type": type_, "amount": amount})
        assert r.status_code == 200, r.text
        return r.json()

    add(owner, 5_000, "Cash", parking, "Gửi xe", days_ago=3)
    add(owner, 5_200, "Bank", food, "Bánh mì", days_ago=2)
    add(owner, 4_800, "Cash", parking, "Gửi xe", days_ago=1)
    assert suggest(owner, 5_000) == {"account_id": accts["Cash"], "category_id": parking, "payee": "Gửi xe"}
    assert suggest(owner, 4_600) == suggest(owner, 5_000)                  # close amounts count
    assert suggest(owner, 9_000) is None                                    # nothing close
    assert suggest(owner, 5_000, "income") is None                          # another type

    for _ in range(3):                                                      # someone else's habits aren't mine
        add(editor, 20_000, "Bank", food, "Cơm")
    assert suggest(owner, 20_000) is None
    assert suggest(editor, 20_000) == {"account_id": accts["Bank"], "category_id": food, "payee": "Cơm"}

    for _ in range(3):                                                      # older than 90 days
        add(owner, 77_000, "Bank", food, "Old habit", days_ago=120)
    assert suggest(owner, 77_000) is None
    assert client.get(f"/v1/books/{bid}/transactions/suggest", headers=auth(signed_up(client)),
                      params={"type": "expense", "amount": 5_000}).status_code == 404


def test_transactions_and_two_browsers(client):
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"
    food = add_category(client, u, bid, "Food")
    lunch = add_category(client, u, bid, "Lunch", parent=food["id"])
    move = add_category(client, u, bid, "Move", kind="transfer")

    tid = str(uuid.uuid4())
    expense = {"id": tid, "type": "expense", "occurred_on": "2026-10-03", "category_id": lunch["id"], "payee": "Phở 24",
               "note": "with Tom", "entries": [{"account_id": accts["Cash"], "amount": -65_000}]}
    r = client.post(base, headers=auth(u), json=expense)
    assert r.status_code == 201
    assert (r.json()["version"], r.json()["entries"][0]["currency"], r.json()["created_by"]) == (1, "VND", r.json()["modified_by"])
    assert client.post(base, headers=auth(u), json=expense).json()["version"] == 1          # retry: saved once
    client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "type": "transfer", "occurred_on": "2026-10-04",
                                             "category_id": move["id"], "entries": [
                                                 {"account_id": accts["Bank"], "amount": -2_000_000},
                                                 {"account_id": accts["Cash"], "amount": 2_000_000}]})
    client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "type": "income", "occurred_on": "2026-10-05",
                                             "payee": "Salary", "entries": [{"account_id": accts["Bank"], "amount": 20_000_000}]})

    # A shape error is found at commit: it must come back as an error, not 201.
    bad = client.post(base, headers=auth(u), json={**expense, "id": str(uuid.uuid4()),
                                                   "entries": [{"account_id": accts["Cash"], "amount": 65_000}]})
    assert (bad.status_code, bad.json()) == (422, {"detail": "txn_shape"})
    wrong_kind = client.post(base, headers=auth(u), json={**expense, "id": str(uuid.uuid4()), "category_id": move["id"]})
    assert wrong_kind.json() == {"detail": "category_kind"}

    def listed(**params):
        return client.get(base, headers=auth(u), params=params).json()

    assert [t["type"] for t in listed()["items"]] == ["income", "transfer", "expense", "opening_balance", "opening_balance"]
    cash = listed(account_id=accts["Cash"])["items"]
    assert [(t["type"], t["running_balance"]) for t in cash] == [("transfer", 2_935_000), ("expense", 935_000),
                                                                 ("opening_balance", 1_000_000)]
    assert [t["payee"] for t in listed(category_id=food["id"])["items"]] == ["Phở 24"]          # includes Lunch
    assert [t["type"] for t in listed(**{"from": "2026-10-04", "to": "2026-10-04"})["items"]] == ["transfer"]
    assert [t["type"] for t in listed(type="income")["items"]] == ["income"]
    assert [t["payee"] for t in listed(q="TOM")["items"]] == ["Phở 24"]                        # note, any case
    page1 = listed(limit=2)
    page2 = listed(limit=2, after=page1["next"])
    page3 = listed(limit=2, after=page2["next"])
    assert [t["id"] for t in page1["items"] + page2["items"] + page3["items"]] == [t["id"] for t in listed()["items"]]
    assert page3["next"] is None

    # Two browsers loaded version 1. The first save wins; the second gets 409 and changes nothing.
    edit = {k: v for k, v in expense.items() if k != "id"}
    first = client.put(f"{base}/{tid}", headers=auth(u), json={**edit, "version": 1, "payee": "Phở Hà Nội",
                                                                "entries": [{"account_id": accts["Cash"], "amount": -70_000}]})
    assert (first.status_code, first.json()["version"]) == (200, 2)
    second = client.put(f"{base}/{tid}", headers=auth(u), json={**edit, "version": 1, "note": "from the other tab"})
    assert (second.status_code, second.json()) == (409, {"detail": "conflict"})
    now = client.get(f"{base}/{tid}", headers=auth(u)).json()
    assert (now["payee"], now["note"], now["entries"][0]["amount"]) == ("Phở Hà Nội", "with Tom", -70_000)
    assert client.delete(f"{base}/{tid}?version=1", headers=auth(u)).json() == {"detail": "conflict"}
    assert client.delete(f"{base}/{tid}?version=2", headers=auth(u)).status_code == 204
    assert client.get(f"{base}/{tid}", headers=auth(u)).status_code == 404

    hist = client.get(f"{base}/{tid}/history", headers=auth(u)).json()
    assert [(h["action"], h["version"]) for h in hist] == [("created", 1), ("edited", 2), ("deleted", 2)]
    assert (hist[0]["payee"], hist[0]["entries"][0]["amount"]) == ("Phở 24", -65_000)
    assert (hist[1]["payee"], hist[1]["entries"][0]["amount"]) == ("Phở Hà Nội", -70_000)
    assert hist[0]["changed_by"] == now["created_by"] and hist[2]["entries"] is None

    stranger = signed_up(client)
    assert client.get(base, headers=auth(stranger)).json() == {"detail": "not_found"}
    assert client.get(f"{base}/{tid}/history", headers=auth(stranger)).json() == {"detail": "not_found"}


def test_dashboard_converts_at_todays_rate(client, database):
    from datetime import date as d
    today = d.today()
    with database.connect() as c:                       # what the daily rates job writes (as fx_updater)
        c.execute(text("insert into fx_rates (quote, as_of, rate, source) values ('VND', :t, 26000, 't'),"
                       " ('VND', :y, 25000, 't') on conflict (quote, as_of) do update set rate = excluded.rate"),
                  {"t": today, "y": d(today.year - 1, 1, 1)})
    u = signed_up(client)
    bid = str(uuid.uuid4())
    client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": "VND", "timezone": "UTC",
                                                    "starter_categories": False})
    acct = lambda name, ccy, amount, **kw: client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={  # noqa: E731
        "id": str(uuid.uuid4()), "name": name, "kind": "checking", "currency": ccy, "opening_balance": amount,
        "opened_on": today.isoformat(), **kw}).json()["id"]
    vnd = acct("Ví", "VND", 1_000_000)
    usd = acct("US bank", "USD", 10_000)                # $100.00
    acct("Kuwait", "KWD", 5_000)                         # no KWD rate anywhere: left out and counted
    acct("Held for Mom", "VND", 3_000_000, in_net_worth=False)
    food = add_category(client, u, bid, "Food")
    for account, amount in ((vnd, -50_000), (usd, -500)):    # 50.000 ₫ and $5.00 at 26.000 ₫/$
        client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": "expense", "occurred_on": today.isoformat(), "category_id": food["id"],
            "entries": [{"account_id": account, "amount": amount}]})

    r = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u))
    assert r.status_code == 200, r.text
    dash = r.json()
    rows = {a["name"]: a for a in dash["accounts"]}
    assert (rows["US bank"]["balance"], rows["US bank"]["converted_balance"]) == (9_500, 2_470_000)   # $95.00 today
    assert rows["Kuwait"]["converted_balance"] is None
    assert (dash["currency"], dash["net_worth"], dash["net_worth_missing_rates"]) == ("VND", 950_000 + 2_470_000, 1)
    assert dash["spent_this_month"] == 50_000 + 130_000
    assert dash["top_categories_this_month"][0] | {"category_id": None} == {
        "category_id": None, "category": "Food", "category_parent_id": None, "spent": 180_000, "not_converted": 0}
    assert dash["recent_transactions"][0]["type"] in ("expense", "opening_balance")
    assert client.get(f"/v1/books/{bid}/dashboard", headers=auth(signed_up(client))).json() == {"detail": "not_found"}

    listed = {a["name"]: a for a in client.get(f"/v1/books/{bid}/accounts", headers=auth(u)).json()}
    assert [listed[n]["converted_balance"] for n in ("Ví", "US bank", "Kuwait")] == [950_000, 2_470_000, None]


def test_pinned_accounts(client, database):
    """R-DASH-2: each member pins the accounts their Overview shows; pins are their own, a viewer pins too, and
    leaving the book drops them."""
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "viewer")}
    owner, viewer = (signed_up(client, names[k]) for k in ("owner", "viewer"))
    bid, accts = new_book_with_accounts(client, owner)
    client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": names["viewer"], "role": "viewer"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(viewer))
    base = f"/v1/books/{bid}/accounts"

    def pinned(u):
        return {a["name"] for a in client.get(base, headers=auth(u)).json() if a["pinned"]}

    assert client.put(f"{base}/{accts['Cash']}/pin", headers=auth(owner)).status_code == 204
    assert client.put(f"{base}/{accts['Cash']}/pin", headers=auth(owner)).status_code == 204      # twice is fine
    assert (pinned(owner), pinned(viewer)) == ({"Cash"}, set())
    assert client.put(f"{base}/{accts['Bank']}/pin", headers=auth(viewer)).status_code == 204
    assert (pinned(owner), pinned(viewer)) == ({"Cash"}, {"Bank"})
    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(owner)).json()
    assert {a["name"]: a["pinned"] for a in dash["accounts"]} == {"Cash": True, "Bank": False}

    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(owner)).content))
    rows = list(csv.DictReader(io.StringIO(z.read("accounts.csv").decode("utf-8-sig"))))
    assert {r["Account"]: r["Pinned"] for r in rows} == {"Cash": "Yes", "Bank": "No"}

    assert client.delete(f"{base}/{accts['Cash']}/pin", headers=auth(owner)).status_code == 204
    assert pinned(owner) == set()
    assert client.put(f"{base}/{accts['Cash']}/pin", headers=auth(signed_up(client))).status_code == 404
    assert client.delete(f"/v1/books/{bid}/members/{viewer}", headers=auth(viewer)).status_code == 204
    with database.connect() as c:
        assert c.execute(text("select count(*) from account_pins where user_id = :u"), {"u": viewer}).scalar() == 0


def test_people_and_lending(client):
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/contacts"
    tom = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Tom", "note": "đồng nghiệp"}).json()
    mom = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Mẹ"}).json()
    assert client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Tom"}).json() == {"detail": "name_taken"}
    acc = lambda name, kind, contact: client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={  # noqa: E731
        "id": str(uuid.uuid4()), "name": name, "kind": kind, "contact_id": contact})
    lent = acc("Cho Tom vay", "lent", tom["id"]).json()
    loan = acc("Vay mẹ", "loan", mom["id"]).json()
    assert lent["contact_id"] == tom["id"]
    assert acc("Wrong", "checking", tom["id"]).json() == {"detail": "invalid"}     # only lent and loan take a person
    move = lambda frm, to, amount, day: client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={  # noqa: E731
        "id": str(uuid.uuid4()), "type": "transfer", "occurred_on": day,
        "entries": [{"account_id": frm, "amount": -amount}, {"account_id": to, "amount": amount}]})
    move(accts["Bank"], lent["id"], 2_000_000, "2026-10-02")      # lend Tom 2.000.000
    move(lent["id"], accts["Cash"], 500_000, "2026-10-03")        # he pays back 500.000
    move(loan["id"], accts["Bank"], 10_000_000, "2026-10-04")     # borrow 10.000.000 from Mom
    people = {c["name"]: c["balances"] for c in client.get(base, headers=auth(u)).json()}
    assert people["Tom"] == [{"currency": "VND", "owed_to_you": 1_500_000, "you_owe": 0}]
    assert people["Mẹ"] == [{"currency": "VND", "owed_to_you": 0, "you_owe": 10_000_000}]

    nobody = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Nobody"}).json()
    assert client.delete(f"{base}/{nobody['id']}?version=1", headers=auth(u)).json() == {"deleted": True, "archived": False}
    assert client.delete(f"{base}/{tom['id']}?version=1", headers=auth(u)).json() == {"deleted": False, "archived": True}
    unlinked = client.patch(f"/v1/books/{bid}/accounts/{loan['id']}", headers=auth(u), json={"version": loan["version"], "no_contact": True})
    assert unlinked.json()["contact_id"] is None
    edited = client.patch(f"{base}/{mom['id']}", headers=auth(u), json={"version": 1, "name": "Mẹ yêu", "note": "x"}).json()
    assert (edited["name"], edited["note"], edited["version"]) == ("Mẹ yêu", "x", 2)

    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).json()
    assert [(p["name"], p["owed_to_you"], p["you_owe"]) for p in dash["people"]] == [("Tom", 1_500_000, 0)]


def test_edits_to_amounts_or_accounts_alone_are_versions(client, database):
    """Changing only an amount or an account is an edit like any other: a new version (so a
    second browser still gets 409) and its own line in the history. Saving with nothing changed is neither,
    and leaves the entries alone (no rows in the audit log for them)."""
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"
    tid = str(uuid.uuid4())
    body = {"type": "expense", "occurred_on": "2026-10-03", "payee": "Lẩu", "entries": [{"account_id": accts["Cash"], "amount": -45_000}]}
    assert client.post(base, headers=auth(u), json={**body, "id": tid}).status_code == 201

    def put(version, **changes):
        return client.put(f"{base}/{tid}", headers=auth(u), json={**body, **changes, "version": version})

    amount = put(1, entries=[{"account_id": accts["Cash"], "amount": -65_000}])
    assert (amount.status_code, amount.json()["version"]) == (200, 2)
    stale = put(1, entries=[{"account_id": accts["Cash"], "amount": -50_000}])        # the other browser
    assert (stale.status_code, stale.json()) == (409, {"detail": "conflict"})
    moved = put(2, entries=[{"account_id": accts["Bank"], "amount": -65_000}])
    assert (moved.status_code, moved.json()["version"]) == (200, 3)
    def entry_writes():
        with database.connect() as c:
            return c.execute(text("select count(*) from audit_log where table_name = 'entries'"
                                  " and coalesce(new_row, old_row)->>'transaction_id' = :t"), {"t": tid}).scalar()
    writes = entry_writes()
    same = put(3, entries=[{"account_id": accts["Bank"], "amount": -65_000}])
    assert (same.status_code, same.json()["version"]) == (200, 3)
    assert entry_writes() == writes

    hist = client.get(f"{base}/{tid}/history", headers=auth(u)).json()
    assert [(h["action"], h["version"]) for h in hist] == [("created", 1), ("edited", 2), ("edited", 3)]
    assert [(h["entries"][0]["account_id"], h["entries"][0]["amount"]) for h in hist] == [
        (accts["Cash"], -45_000), (accts["Cash"], -65_000), (accts["Bank"], -65_000)]
    listed = lambda acc: [t["id"] for t in client.get(base, headers=auth(u), params={"account_id": acc}).json()["items"]]
    assert tid not in listed(accts["Cash"]) and tid in listed(accts["Bank"])


def test_budgets(client):
    from datetime import date as d
    today = d.today()
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/budgets"
    food = add_category(client, u, bid, "Food")
    lunch = add_category(client, u, bid, "Lunch", parent=food["id"])
    salary = add_category(client, u, bid, "Salary", kind="income")
    monthly = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "monthly",
                                                       "amount": 3_000_000, "starts_on": today.replace(day=1).isoformat()})
    assert monthly.status_code == 201, monthly.text
    b = monthly.json()
    assert (b["amount"], b["progress"]["spent"], b["progress"]["period_start"]) == (3_000_000, 0, today.replace(day=1).isoformat())
    daily = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "daily",
                                                     "amount": 200_000})
    assert daily.status_code == 201
    dup = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "monthly", "amount": 1})
    assert (dup.status_code, dup.json()) == (409, {"detail": "budget_exists"})
    income = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": salary["id"], "period": "monthly", "amount": 1})
    assert income.json() == {"detail": "budget_expense_only"}
    assert client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "yearly",
                                                    "amount": 0}).json() == {"detail": "invalid"}

    for amount in (120_000, 30_000):                      # spent on Lunch counts toward Food
        client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": "expense", "occurred_on": today.isoformat(), "category_id": lunch["id"],
            "entries": [{"account_id": accts["Cash"], "amount": -amount}]})
    got = {x["period"]: x for x in client.get(base, headers=auth(u)).json()}
    assert (got["monthly"]["progress"]["spent"], got["monthly"]["progress"]["remaining"], got["monthly"]["progress"]["percent_used"]) == \
        (150_000, 2_850_000, 5.0)
    assert got["daily"]["progress"]["percent_used"] == 75.0

    raised = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 1, "amount": 5_000_000}).json()
    assert (raised["amount"], raised["version"]) == (5_000_000, 2)
    assert client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 1, "amount": 1}).json() == {"detail": "conflict"}
    ended = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 2, "ends_on": "2000-01-01"})
    assert ended.json() == {"detail": "invalid"}          # ends before it starts

    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).json()
    assert [(x["category"], x["period"], x["spent"]) for x in dash["budgets"]] == [("Food", "daily", 150_000), ("Food", "monthly", 150_000)]
    assert client.delete(f"{base}/{daily.json()['id']}?version=1", headers=auth(u)).status_code == 204
    assert len(client.get(base, headers=auth(u)).json()) == 1


def events(capsys):
    import json
    return [json.loads(line)["account_event"] for line in capsys.readouterr().out.splitlines() if "account_event" in line]


def test_profile_and_export(client):
    u = signed_up(client)
    r = client.patch("/v1/me", headers=auth(u), json={"username": "New_Name_" + u.hex[:6], "language": "vi", "display_name": "N"})
    assert (r.json()["profile"]["username"], r.json()["profile"]["language"]) == (f"new_name_{u.hex[:6]}", "vi")
    assert client.patch("/v1/me", headers=auth(u), json={"display_name": ""}).json()["profile"]["display_name"] is None

    new_book_with_accounts(client, u)
    zipped = client.get("/v1/me/export", headers=auth(u))
    assert zipped.headers["content-type"] == "application/zip" and "attachment" in zipped.headers["content-disposition"]
    import io
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(zipped.content)).namelist()
    assert "profile.csv" in names and "transactions.csv" in names


def test_close_and_restore(client, capsys):
    u = signed_up(client)
    bid, _ = new_book_with_accounts(client, u)
    capsys.readouterr()
    closed = client.post("/v1/me/delete", headers=auth(u)).json()
    assert closed["deletion_requested_at"] is not None and closed["deletes_on"] > closed["deletion_requested_at"]
    assert client.get("/v1/books", headers=auth(u)).json() == []          # a closed account sees no book data
    client.post("/v1/me/delete", headers=auth(u))                         # again: nothing new to log
    assert client.post("/v1/me/restore", headers=auth(u)).json()["deletion_requested_at"] is None
    assert [b["id"] for b in client.get("/v1/books", headers=auth(u)).json()] == [bid]
    assert events(capsys) == ["account_closed", "account_restored"]
    refused = client.post("/v1/me/restore", headers=auth(u))               # nothing to restore
    assert (refused.status_code, refused.json()) == (409, {"detail": "not_restorable"})


def test_timezone_aliases_become_names_the_database_knows(client, database):
    """Windows browsers report Asia/Saigon, which the postgres image doesn't know."""
    u = signed_up(client)
    bid = str(uuid.uuid4())
    r = client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": "VND", "timezone": "Asia/Saigon"})
    assert r.status_code == 201 and r.json()["timezone"] == "Asia/Ho_Chi_Minh"
    assert client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).status_code == 200
    assert client.patch("/v1/me", headers=auth(u), json={"timezone": "Asia/Calcutta"}).json()["profile"]["timezone"] == "Asia/Kolkata"
    assert client.patch("/v1/me", headers=auth(u), json={"timezone": "Mars/Olympus"}).status_code == 422
    with database.connect() as c, pytest.raises(Exception, match="invalid_timezone"):
        c.execute(text("update books set timezone = 'Asia/Saigon' where id = :b"), {"b": bid})


def test_shared_books(client):
    """Two users keep one book together, and a viewer can't change it."""
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "editor", "viewer", "other")}
    owner, editor, viewer, other = (signed_up(client, names[k]) for k in ("owner", "editor", "viewer", "other"))
    bid, accts = new_book_with_accounts(client, owner)
    members = f"/v1/books/{bid}/members"

    # Invites: by username, any case; unknown and already-in-the-book look alike.
    r = client.post(members, headers=auth(owner), json={"username": names["editor"].upper()})
    assert r.status_code == 201 and [(m["name"], m["role"], m["pending"]) for m in r.json()] == [
        (names["owner"], "owner", False), (names["editor"], "editor", True)]
    client.post(members, headers=auth(owner), json={"username": names["viewer"], "role": "viewer"})
    for name in ("nobody_here", names["editor"], names["owner"]):
        r = client.post(members, headers=auth(owner), json={"username": name})
        assert (r.status_code, r.json()) == (409, {"detail": "cannot_invite"})

    # Pending: the invitee sees the invite and nothing of the book.
    invites = client.get("/v1/me/book-invites", headers=auth(editor)).json()
    assert [(i["book_id"], i["role"], i["invited_by"]) for i in invites] == [(bid, "editor", names["owner"])]
    assert client.get(f"/v1/books/{bid}", headers=auth(editor)).status_code == 404
    assert client.get(members, headers=auth(editor)).status_code == 404
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(other)).status_code == 404
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(editor)).status_code == 204
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(viewer)).status_code == 204
    assert client.get("/v1/me/book-invites", headers=auth(editor)).json() == []
    assert client.get(f"/v1/books/{bid}", headers=auth(editor)).json()["role"] == "editor"

    # Together: the editor adds a transaction the owner sees; the viewer reads but can't write.
    txn = {"id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-03", "payee": "Chợ",
           "entries": [{"account_id": accts["Cash"], "amount": -50_000}]}
    assert client.post(f"/v1/books/{bid}/transactions", headers=auth(editor), json=txn).status_code == 201
    def payees(who):
        return [t["payee"] for t in client.get(f"/v1/books/{bid}/transactions", headers=auth(who)).json()["items"] if t["payee"]]
    assert payees(owner) == payees(viewer) == ["Chợ"]
    for method, path, body in (
            ("post", f"/v1/books/{bid}/transactions", {**txn, "id": str(uuid.uuid4())}),
            ("post", f"/v1/books/{bid}/accounts", {"id": str(uuid.uuid4()), "name": "X", "kind": "cash", "opened_on": "2026-10-01"}),
            ("post", f"/v1/books/{bid}/categories", {"id": str(uuid.uuid4()), "name": "X", "kind": "expense", "color": "#2563EB"}),
            ("patch", f"/v1/books/{bid}", {"version": 1, "name": "mine now"}),
            ("post", members, {"username": names["other"]}),
            ("patch", f"{members}/{editor}", {"role": "viewer"}),
            ("delete", f"{members}/{editor}", None)):
        r = client.request(method, path, headers=auth(viewer), json=body)
        assert r.status_code in (403, 404), (path, r.status_code, r.text)
    assert payees(owner) == ["Chợ"]
    assert client.post(members, headers=auth(editor), json={"username": names["other"]}).json() == {"detail": "forbidden"}

    # Roles: owners only; the last owner can't step down or leave.
    r = client.patch(f"{members}/{owner}", headers=auth(owner), json={"role": "editor"})
    assert (r.status_code, r.json()) == (409, {"detail": "owner_required"})
    assert client.delete(f"{members}/{owner}", headers=auth(owner)).json() == {"detail": "owner_required"}
    r = client.patch(f"{members}/{editor}", headers=auth(owner), json={"role": "owner"})
    assert {m["name"]: m["role"] for m in r.json()}[names["editor"]] == "owner"
    assert client.delete(f"{members}/{owner}", headers=auth(owner)).status_code == 204          # now they can leave
    assert client.get(f"/v1/books/{bid}", headers=auth(owner)).status_code == 404

    # The new owner removes the viewer, invites someone who declines.
    assert client.delete(f"{members}/{viewer}", headers=auth(editor)).status_code == 204
    assert client.get(f"/v1/books/{bid}", headers=auth(viewer)).status_code == 404
    client.post(members, headers=auth(editor), json={"username": names["other"], "role": "viewer"})
    assert client.delete(f"/v1/me/book-invites/{bid}", headers=auth(other)).status_code == 204
    assert client.get("/v1/me/book-invites", headers=auth(other)).json() == []
    assert [(m["name"], m["me"]) for m in client.get(members, headers=auth(editor)).json()] == [(names["editor"], True)]


def test_book_changes_marker(client):
    """A member polls one cheap marker that changes when anyone changes the book."""
    owner, editor, stranger = signed_up(client), signed_up(client), signed_up(client)
    bid, accts = new_book_with_accounts(client, owner)
    editor_name = client.get("/v1/me", headers=auth(editor)).json()["profile"]["username"]
    client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": editor_name})
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(editor)).status_code == 204
    url = f"/v1/books/{bid}/changes"

    first = client.get(url, headers=auth(owner)).json()["marker"]
    assert client.get(url, headers=auth(owner)).json()["marker"] == first == client.get(url, headers=auth(editor)).json()["marker"]
    assert re.fullmatch(r"[0-9a-f]{32}", first)        # opaque: no audit ids, which count changes across the server
    client.post(f"/v1/books/{bid}/transactions", headers=auth(editor), json={
        "id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-05",
        "entries": [{"account_id": accts["Cash"], "amount": -30_000}]})
    second = client.get(url, headers=auth(owner)).json()["marker"]
    assert second != first
    client.patch(f"/v1/books/{bid}", headers=auth(owner), json={"version": 1, "name": "Renamed"})
    assert client.get(url, headers=auth(editor)).json()["marker"] not in (first, second)
    assert client.get(url, headers=auth(stranger)).json() == {"detail": "not_found"}


def test_book_invites_are_rate_limited(client):
    """A found username becomes an invite, so guessing names is slowed down."""
    owner = signed_up(client)
    bid, _ = new_book_with_accounts(client, owner)
    codes = [client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": f"guess{i}"}).status_code
             for i in range(11)]
    assert codes == [409] * 10 + [429]


def test_username_changes_are_rate_limited(client):
    """A taken name answers username_taken, so trying names is slowed down."""
    taken = f"taken_{uuid.uuid4().hex[:8]}"
    signed_up(client, taken)
    u = signed_up(client)
    tries = [client.patch("/v1/me", headers=auth(u), json={"username": taken}).status_code for _ in range(5)]
    assert tries == [409] * 5
    assert client.patch("/v1/me", headers=auth(u), json={"username": taken}).json() == {"detail": "rate_limited"}
    me = client.get("/v1/me", headers=auth(u)).json()["profile"]
    same = client.patch("/v1/me", headers=auth(u), json={"username": me["username"], "display_name": "Mai"})
    assert same.status_code == 200 and same.json()["profile"]["display_name"] == "Mai"     # saving the same name isn't a try
