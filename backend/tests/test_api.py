"""Tests for the FastAPI app: token checks, CORS and /v1/me, against the
database from conftest.py. Tokens are signed with a key made here; the API is
pointed at it instead of a real Supabase project's published keys.
"""
import os
import time
import uuid
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import text

from conftest import POLICY

SUPABASE_URL = "http://supabase.test"
APP_URL = "http://app.test"
ISSUER = f"{SUPABASE_URL}/auth/v1"
KEY = ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(scope="module")
def client(database):
    os.environ.update(SUPABASE_URL=SUPABASE_URL, APP_URL=APP_URL)
    from fastapi.testclient import TestClient

    from app.api.main import app
    from app.core import auth
    auth.jwks.get_signing_key_from_jwt = lambda token: SimpleNamespace(key=KEY.public_key())
    return TestClient(app)


def token(sub, key=KEY, alg="ES256", **claims):
    body = {"sub": str(sub), "aud": "authenticated", "iss": ISSUER, "exp": int(time.time()) + 300, **claims}
    return jwt.encode({k: v for k, v in body.items() if v is not None}, key, algorithm=alg)


def get_me(client, tok):
    return client.get("/v1/me", headers={"Authorization": f"Bearer {tok}"})


def test_health_needs_no_token(client):
    r = client.get("/v1/health")
    assert r.json() == {"ok": True}
    assert r.headers["cache-control"] == "no-store"      # nothing may cache API answers


def test_me_without_a_profile_yet(client):
    uid = uuid.uuid4()
    r = get_me(client, token(uid))
    assert r.status_code == 200
    assert r.json() == {"id": str(uid), "profile": None, "needs_consent": False}


def test_me_returns_only_my_profile(client):
    from app.core import db
    mine, other = uuid.uuid4(), uuid.uuid4()
    for uid, name in ((mine, f"me_{mine.hex[:8]}"), (other, f"other_{other.hex[:8]}")):
        with db.user_session(uid) as s:
            s.execute(text("with u as (insert into users (id, username, email) values (:i, :n, :e) returning id)"
                           " insert into consents (user_id, purpose, policy_version) select id, 'use_app', :v from u"),
                      {"i": uid, "n": name, "e": f"{name}@example.com", "v": POLICY})
    r = get_me(client, token(mine))
    assert r.status_code == 200
    profile = r.json()["profile"]
    assert profile["username"] == f"me_{mine.hex[:8]}"
    assert profile["language"] == "vi" and profile["plan"] == "free"


@pytest.mark.parametrize("bad", [
    "no-token", "not-a-jwt", "expired", "wrong-audience", "wrong-issuer", "no-expiry", "other-key", "hs256", "sub-not-uuid",
])
def test_bad_tokens_are_refused(client, bad):
    uid = uuid.uuid4()
    tok = {
        "not-a-jwt": "abc.def.ghi",
        "expired": lambda: token(uid, exp=int(time.time()) - 10),
        "wrong-audience": lambda: token(uid, aud="anon"),
        "wrong-issuer": lambda: token(uid, iss="http://evil.test/auth/v1"),
        "no-expiry": lambda: token(uid, exp=None),
        "other-key": lambda: token(uid, key=ec.generate_private_key(ec.SECP256R1())),
        "hs256": lambda: token(uid, key="a-shared-secret-that-is-at-least-32-bytes", alg="HS256"),
        "sub-not-uuid": lambda: token("someone"),
    }.get(bad)
    headers = {} if bad == "no-token" else {"Authorization": f"Bearer {tok() if callable(tok) else tok}"}
    r = client.get("/v1/me", headers=headers)
    assert r.status_code == 401
    assert r.json() == {"detail": "not_signed_in"}


def test_cors_allows_only_the_web_app(client):
    preflight = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    ok = client.options("/v1/me", headers={"Origin": APP_URL, **preflight})
    assert ok.headers.get("access-control-allow-origin") == APP_URL
    evil = client.options("/v1/me", headers={"Origin": "http://evil.test", **preflight})
    assert "access-control-allow-origin" not in evil.headers


def test_extra_origins_are_localhost_only():
    from app.core.settings import parse_local_origins
    assert parse_local_origins("") == ()
    assert parse_local_origins("http://localhost:5173, http://127.0.0.1:5173/") == (
        "http://localhost:5173", "http://127.0.0.1:5173")
    for bad in ("https://localhost:5173", "http://localhost", "http://evil.test:5173",
                "http://localhost.evil.test:5173", "*", "null"):
        with pytest.raises(RuntimeError):
            parse_local_origins(bad)


# ---------------------------------------------------------------- milestone 2: sign-up, books, accounts

def auth(uid, email=None):
    return {"Authorization": f"Bearer {token(uid, email=email or f'{uid.hex[:12]}@example.com')}"}


def signed_up(client, name=None, language="vi"):
    uid = uuid.uuid4()
    r = client.post("/v1/me", headers=auth(uid), json={"username": name or f"U{uid.hex[:10]}", "language": language,
                                                         "timezone": "Asia/Ho_Chi_Minh", "policy_version": POLICY})
    assert r.status_code == 201, r.text
    return uid


def test_choose_username_creates_the_account_with_consent(client):
    uid = uuid.uuid4()
    assert client.get("/v1/policy").json() == {"version": POLICY, "path": f"/privacy/{POLICY}"}      # no sign-in needed
    body = {"username": "  Nguyin_Test ", "display_name": "N", "timezone": "Asia/Ho_Chi_Minh", "policy_version": POLICY}
    r = client.post("/v1/me", headers=auth(uid, "real@example.com"), json={**body, "email": "forged@example.com"})
    assert r.status_code == 201
    profile = r.json()["profile"]
    assert (profile["username"], profile["email"], profile["language"]) == ("nguyin_test", "real@example.com", "vi")
    assert client.post("/v1/me", headers=auth(uid), json=body).json() == {"detail": "profile_exists"}
    taken = client.post("/v1/me", headers=auth(uuid.uuid4()), json={**body, "username": "NGUYIN_TEST"})
    assert (taken.status_code, taken.json()) == (409, {"detail": "username_taken"})


@pytest.mark.parametrize("change, status, code", [
    ({"policy_version": "2020-01-01"}, 403, "consent_outdated"),     # not the policy in force
    ({"username": "-bad"}, 422, "invalid"),
    ({"username": "ab"}, 422, "invalid"),
    ({"timezone": "Mars/Base"}, 422, "invalid"),
    ({"language": "fr"}, 422, "invalid"),
])
def test_choose_username_refusals(client, change, status, code):
    body = {"username": f"u{uuid.uuid4().hex[:10]}", "timezone": "UTC", "policy_version": POLICY, **change}
    r = client.post("/v1/me", headers=auth(uuid.uuid4()), json=body)
    assert (r.status_code, r.json()) == (status, {"detail": code})


def test_currencies(client):
    ccy = {c["code"]: c for c in client.get("/v1/currencies", headers=auth(uuid.uuid4())).json()}
    assert ccy["VND"]["minor_unit"] == 0 and ccy["KWD"]["minor_unit"] == 3 and len(ccy) == 155


def test_books(client):
    owner, stranger = signed_up(client), signed_up(client, language="en")
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


# ---------------------------------------------------------------- milestone 3: categories, transactions

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


# ---------------------------------------------------------------- milestone 4: dashboard

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


# ---------------------------------------------------------------- milestone 5: people, budgets

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


# ---------------------------------------------------------------- milestone 6: your data

def events(capsys):
    import json
    return [json.loads(line)["account_event"] for line in capsys.readouterr().out.splitlines() if "account_event" in line]


def test_profile_export_and_two_factor(client, database):
    u = signed_up(client)
    r = client.patch("/v1/me", headers=auth(u), json={"username": "New_Name_" + u.hex[:6], "language": "en", "display_name": "N"})
    assert (r.json()["profile"]["username"], r.json()["profile"]["language"]) == (f"new_name_{u.hex[:6]}", "en")
    assert client.patch("/v1/me", headers=auth(u), json={"display_name": ""}).json()["profile"]["display_name"] is None

    bid, _ = new_book_with_accounts(client, u)
    zipped = client.get("/v1/me/export", headers=auth(u))
    assert zipped.headers["content-type"] == "application/zip" and "attachment" in zipped.headers["content-disposition"]
    import io
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(zipped.content)).namelist()
    assert "profile.csv" in names and "transactions.csv" in names

    # Two-factor set up: a password-only token (aal1) gets nothing; aal2 works.
    with database.connect() as c:
        c.execute(text("insert into auth.mfa_factors (user_id, status) values (:u, 'verified')"), {"u": u})
    assert client.get("/v1/books", headers=auth(u)).json() == {"detail": "mfa_required"}
    aal2 = {"Authorization": f"Bearer {token(u, email='x@example.com', aal='aal2')}"}
    assert [b["id"] for b in client.get("/v1/books", headers=aal2).json()] == [bid]
    other = signed_up(client)
    with database.connect() as c:                         # an unverified factor doesn't count yet
        c.execute(text("insert into auth.mfa_factors (user_id, status) values (:u, 'unverified')"), {"u": other})
    assert client.get("/v1/books", headers=auth(other)).status_code == 200


def test_close_restore_and_withdraw(client, capsys):
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

    status = client.post("/v1/me/consent/withdraw", headers=auth(u)).json()
    assert status["deletion_requested_at"] is not None
    assert events(capsys) == ["consent_withdrawn", "account_closed"]
    assert client.get("/v1/me", headers=auth(u)).json()["needs_consent"] is True
    refused = client.post("/v1/me/restore", headers=auth(u))
    assert (refused.status_code, refused.json()) == (403, {"detail": "consent_outdated"})
    assert client.post("/v1/me/consent", headers=auth(u), json={"policy_version": POLICY}).json()["needs_consent"] is False
    assert client.post("/v1/me/restore", headers=auth(u)).json()["deletion_requested_at"] is None
    assert events(capsys) == ["account_restored"]


def test_new_policy_version_needs_consent(client, database):
    u = signed_up(client)
    new = "2099-01-01-test"
    with database.connect() as c:                         # publishing a policy is a migration in real life
        c.execute(text("insert into policy_versions (version, published_at, path, text_sha256)"
                       " values (:v, now(), '/privacy/test', repeat('a', 64))"), {"v": new})
    try:
        me = client.get("/v1/me", headers=auth(u)).json()
        assert me["needs_consent"] is True
        st = client.get("/v1/me/consent", headers=auth(u)).json()
        assert (st["current_version"], st["agreed_version"], st["needs_consent"]) == (new, POLICY, True)
        old = client.post("/v1/me/consent", headers=auth(u), json={"policy_version": POLICY})
        assert (old.status_code, old.json()) == (403, {"detail": "consent_outdated"})
        assert client.post("/v1/me/consent", headers=auth(u), json={"policy_version": new}).json()["needs_consent"] is False
        assert client.post("/v1/me/consent", headers=auth(u), json={"policy_version": new}).status_code == 200   # twice is fine
    finally:
        with database.connect() as c:
            c.execute(text("delete from consents where policy_version = :v"), {"v": new})
            c.execute(text("delete from policy_versions where version = :v"), {"v": new})
