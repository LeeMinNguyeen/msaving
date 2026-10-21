"""Setting up a server, joining, signing in and the admin's tools
(docs: Sign-in; Accounts on an instance), plus the migration runner,
the launcher's helpers and the scheduler. Uses the database from conftest.py;
tests that need a fresh server (setup) build their own.
"""
import uuid
from datetime import datetime, timezone

import psycopg
import pyotp
import pytest
from sqlalchemy import create_engine, text

from conftest import ADMIN_URL

PASSWORD = "correct horse battery"


@pytest.fixture(scope="module")
def client(database):
    from fastapi.testclient import TestClient

    from app.api.main import app
    from app.core import sign_in
    saved = sign_in.sign_ups_per_ip, sign_in.per_ip
    sign_in.sign_ups_per_ip = sign_in.per_ip = sign_in.RateLimit(100_000, 60)
    yield TestClient(app)
    sign_in.sign_ups_per_ip, sign_in.per_ip = saved


@pytest.fixture
def invite_only(database):
    with database.connect() as c:
        c.execute(text("update instance_settings set signup = 'invite'"))
    yield
    with database.connect() as c:
        c.execute(text("update instance_settings set signup = 'open'"))


@pytest.fixture
def admin(client, database):
    """An admin account (made directly: setup itself is tested on a fresh server below)."""
    name, token = sign_up(client)
    with database.connect() as c:
        c.execute(text("update users set is_admin = true where username = :n"), {"n": name})
    return name, token


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def sign_up(client, name=None, password=PASSWORD, status=201, headers=None, **extra):
    name = name or f"u{uuid.uuid4().hex[:10]}"
    r = client.post("/v1/auth/sign-up", json={"username": name, "password": password, **extra}, headers=headers)
    assert r.status_code == status, r.text
    return (name, r.json()["token"]) if status == 201 else r.json()


def sign_in(client, name, password=PASSWORD, code=None):
    return client.post("/v1/auth/sign-in", json={"username": name, "password": password, "code": code})


def me(client, token):
    return client.get("/v1/me", headers=bearer(token))


# ---------------------------------------------------------------- joining

def test_invite_only_server_needs_an_invite(client, admin, invite_only):
    assert client.get("/v1/instance").json()["signup"] == "invite"
    assert sign_up(client, status=403) == {"detail": "invite_required"}
    assert sign_up(client, status=403, invite_code="AAAA-BBBB") == {"detail": "invite_invalid"}

    _, admin_token = admin
    inv = client.post("/v1/admin/invites", headers=bearer(admin_token),
                      json={"note": "Lan", "days": 3, "server": "https://money.example.com"})
    assert inv.status_code == 201
    code = inv.json()["code"]
    assert inv.json()["link"] == f"https://money.example.com/join?code={code}" and inv.json()["qr"].startswith("data:image/svg")
    bad_server = client.post("/v1/admin/invites", headers=bearer(admin_token), json={"server": "https://x/y?z"})
    assert bad_server.status_code == 422
    assert len(code) == 9 and code[4] == "-"
    assert client.post("/v1/auth/invite-check", json={"code": code.lower()}).json() == {"valid": True}

    name, token = sign_up(client, invite_code=code.lower().replace("-", " "))   # typed loosely: still the code
    assert me(client, token).json()["profile"]["is_admin"] is False
    assert client.post("/v1/auth/invite-check", json={"code": code}).json() == {"valid": False}   # one use
    assert sign_up(client, status=403, invite_code=code) == {"detail": "invite_invalid"}
    listed = client.get("/v1/admin/invites", headers=bearer(admin_token)).json()
    mine = next(i for i in listed if i["id"] == inv.json()["id"])
    assert (mine["note"], mine["used_by_username"]) == ("Lan", name)


def test_revoked_and_expired_invites(client, admin, invite_only, database):
    _, admin_token = admin
    revoked = client.post("/v1/admin/invites", headers=bearer(admin_token), json={}).json()
    assert client.delete(f"/v1/admin/invites/{revoked['id']}", headers=bearer(admin_token)).status_code == 204
    assert sign_up(client, status=403, invite_code=revoked["code"]) == {"detail": "invite_invalid"}
    expired = client.post("/v1/admin/invites", headers=bearer(admin_token), json={}).json()
    with database.connect() as c:
        c.execute(text("update invites set expires_at = now() - interval '1 minute' where id = :i"), {"i": expired["id"]})
    assert sign_up(client, status=403, invite_code=expired["code"]) == {"detail": "invite_invalid"}


def test_admin_can_open_sign_up(client, admin, invite_only):
    _, admin_token = admin
    assert client.patch("/v1/admin/instance", headers=bearer(admin_token), json={"signup": "open", "name": "Nhà"}).status_code == 204
    assert client.get("/v1/instance").json() | {"server_version": None} == {
        "name": "Nhà", "signup": "open", "api_version": 1, "setup_needed": False, "server_version": None}
    sign_up(client)
    client.patch("/v1/admin/instance", headers=bearer(admin_token), json={"name": "MSaving"})


def test_only_the_admin_has_admin_tools(client, admin):
    _, token = sign_up(client)
    for method, path, body in (("get", "/v1/admin/users", None), ("get", "/v1/admin/invites", None),
                               ("post", "/v1/admin/invites", {}), ("patch", "/v1/admin/instance", {"signup": "open"})):
        r = client.request(method, path, headers=bearer(token), json=body)
        assert (r.status_code, r.json()) == (403, {"detail": "admin_only"}), path


def test_nobody_can_make_themselves_admin(client, database):
    _, token = sign_up(client)
    uid = me(client, token).json()["id"]
    from app.core import db
    with pytest.raises(Exception, match="permission denied"):
        with db.user_session(uuid.UUID(uid)) as s:
            s.execute(text("update users set is_admin = true where id = :u"), {"u": uid})


# ---------------------------------------------------------------- signing in

def test_sign_in_and_wrong_credentials(client):
    name, _ = sign_up(client)
    for bad in (sign_in(client, name, "wrong password!"), sign_in(client, f"nobody_{uuid.uuid4().hex[:6]}")):
        assert (bad.status_code, bad.json()) == (401, {"detail": "invalid_credentials"})   # same answer for both
    ok = sign_in(client, name.upper())
    assert ok.status_code == 200 and me(client, ok.json()["token"]).json()["profile"]["username"] == name


@pytest.mark.parametrize("body", [
    {"username": "shortpass", "password": "123456789"},          # under 10 characters
    {"username": "-bad", "password": PASSWORD},
    {"username": "ab", "password": PASSWORD},
])
def test_sign_up_rejects_bad_input(client, body):
    assert client.post("/v1/auth/sign-up", json=body).status_code == 422


def test_username_taken(client):
    name, _ = sign_up(client)
    assert sign_up(client, name=name.upper(), status=409) == {"detail": "username_taken"}


def test_tokens_are_stored_hashed(client, database):
    _, token = sign_up(client)
    with database.connect() as c:
        stored = c.execute(text("select count(*) from sessions where token_sha256 = sha256(convert_to(:t, 'utf8'))"),
                           {"t": token}).scalar()
        raw = c.execute(text("select count(*) from sessions where position(convert_to(:t, 'utf8') in token_sha256) > 0"),
                        {"t": token}).scalar()
    assert (stored, raw) == (1, 0)


def test_expired_sessions_are_refused(client, database):
    _, token = sign_up(client)
    with database.connect() as c:
        c.execute(text("update sessions set last_used_at = now() - interval '31 days'"
                       " where token_sha256 = sha256(convert_to(:t, 'utf8'))"), {"t": token})
    assert me(client, token).status_code == 401


def test_sign_out_and_sign_out_others(client):
    name, first = sign_up(client)
    second = sign_in(client, name).json()["token"]
    third = sign_in(client, name).json()["token"]
    assert client.post("/v1/auth/sign-out", headers=bearer(first)).status_code == 204
    assert me(client, first).status_code == 401
    assert client.post("/v1/auth/sign-out-others", headers=bearer(second)).status_code == 204
    assert me(client, third).status_code == 401 and me(client, second).status_code == 200


def test_change_password_signs_out_other_devices(client):
    name, token = sign_up(client)
    other = sign_in(client, name).json()["token"]
    wrong = client.post("/v1/auth/password", headers=bearer(token),
                        json={"current_password": "not it at all", "new_password": "a new password"})
    assert (wrong.status_code, wrong.json()) == (401, {"detail": "invalid_credentials"})
    assert client.post("/v1/auth/password", headers=bearer(token),
                       json={"current_password": PASSWORD, "new_password": "a new password"}).status_code == 204
    assert me(client, other).status_code == 401 and me(client, token).status_code == 200
    assert sign_in(client, name).status_code == 401 and sign_in(client, name, "a new password").status_code == 200


CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
SAFARI_IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
                 " Version/18.6 Mobile/15E148 Safari/604.1")


def test_signed_in_devices(client, database):
    """msaving#5: a user sees where they're signed in, this device first, and signs out one other device."""
    name, laptop = sign_up(client, headers={"User-Agent": CHROME_WINDOWS})
    phone = client.post("/v1/auth/sign-in", json={"username": name, "password": PASSWORD},
                        headers={"User-Agent": SAFARI_IPHONE}).json()["token"]
    script = sign_in(client, name).json()["token"]                          # no browser: no label
    _, stranger = sign_up(client)

    listed = client.get("/v1/auth/sessions", headers=bearer(phone)).json()
    assert [(s["device"], s["current"]) for s in listed][:1] == [("Safari · iOS", True)]
    assert sorted((s["device"] or "", s["current"]) for s in listed) == [
        ("", False), ("Chrome · Windows", False), ("Safari · iOS", True)]
    assert set(listed[0]) == {"id", "device", "created_at", "last_used_at", "current"}   # never a token or its hash
    assert [s["current"] for s in client.get("/v1/auth/sessions", headers=bearer(stranger)).json()] == [True]  # only theirs

    chrome = next(s["id"] for s in listed if s["device"] == "Chrome · Windows")
    assert client.delete(f"/v1/auth/sessions/{chrome}", headers=bearer(stranger)).json() == {"detail": "not_found"}
    assert me(client, laptop).status_code == 200
    assert client.delete(f"/v1/auth/sessions/{chrome}", headers=bearer(phone)).status_code == 204
    assert me(client, laptop).status_code == 401 and me(client, script).status_code == 200
    assert client.delete(f"/v1/auth/sessions/{uuid.uuid4()}", headers=bearer(phone)).status_code == 404

    # A session unused for 30 days isn't a device any more, even before the daily purge deletes it.
    with database.connect() as c:
        c.execute(text("update sessions set last_used_at = now() - interval '31 days'"
                       " where token_sha256 = sha256(convert_to(:t, 'utf8'))"), {"t": script})
    assert [s["device"] for s in client.get("/v1/auth/sessions", headers=bearer(phone)).json()] == ["Safari · iOS"]


def test_idle_sign_out(client, database):
    """msaving#26: each user can have their own sessions end after so many minutes unused; off by default
    (30 days), and nobody else's setting touches them."""
    name, token = sign_up(client)
    other = sign_in(client, name).json()["token"]
    _, neighbour = sign_up(client)
    assert me(client, token).json()["profile"]["idle_sign_out_minutes"] is None
    for bad in (0, 1441, "five"):
        assert client.patch("/v1/me", headers=bearer(token), json={"idle_sign_out_minutes": bad}).status_code == 422

    def unused_for(t, minutes):
        with database.connect() as c:
            c.execute(text("update sessions set last_used_at = now() - make_interval(mins => :m)"
                           " where token_sha256 = sha256(convert_to(:t, 'utf8'))"), {"t": t, "m": minutes})

    assert client.patch("/v1/me", headers=bearer(token), json={"idle_sign_out_minutes": 5}).json()["profile"][
        "idle_sign_out_minutes"] == 5
    assert client.patch("/v1/me", headers=bearer(token), json={"language": "en"}).json()["profile"][
        "idle_sign_out_minutes"] == 5                                     # left out: kept
    assert "idle_sign_out_minutes" not in client.get("/v1/instance").json()   # not a server setting
    unused_for(token, 5)                     # kept to the minute, so a minute's grace: still signed in
    assert me(client, token).status_code == 200
    unused_for(token, 7)
    assert me(client, token).status_code == 401
    unused_for(neighbour, 7)                 # someone else's sessions: their own 30 days
    assert me(client, neighbour).status_code == 200
    unused_for(other, 7)                     # not listed, then deleted by the daily purge
    third = sign_in(client, name).json()["token"]
    assert [s["current"] for s in client.get("/v1/auth/sessions", headers=bearer(third)).json()] == [True]
    with database.connect() as c:
        c.execute(text("select purge_expired_sign_in()"))
        left = c.execute(text("select count(*) from sessions s join users u on u.id = s.user_id where u.username = :n"),
                         {"n": name}).scalar()
    assert left == 1
    assert client.patch("/v1/me", headers=bearer(third), json={"idle_sign_out_minutes": None}).json()["profile"][
        "idle_sign_out_minutes"] is None
    unused_for(third, 7 * 24 * 60)           # off again: 30 days
    assert me(client, third).status_code == 200


@pytest.mark.parametrize("agent, label", [
    (CHROME_WINDOWS, "Chrome · Windows"),
    (SAFARI_IPHONE, "Safari · iOS"),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
     "Safari · macOS"),
    ("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox · Linux"),
    ("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
     "Chrome · Android"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
     " Edg/141.0.0.0", "Edge · Windows"),
    ("Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0"
     " Chrome/130.0.0.0 Mobile Safari/537.36", "Samsung Internet · Android"),
    ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0"
     " Mobile/15E148 Safari/604.1", "Chrome · iOS"),
    ("MSaving/1.0 (Android 15)", "MSaving · Android"),
    ("python-httpx/0.28.1", None),
    (None, None),
])
def test_device_label(agent, label):
    from app.core.sign_in import device_label
    assert device_label(agent) == label


def test_two_factor_with_recovery_codes(client):
    name, token = sign_up(client)
    assert client.get("/v1/auth/two-factor", headers=bearer(token)).json() == {"enabled": False, "recovery_codes_left": 0}
    setup = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()
    assert setup["uri"].startswith("otpauth://totp/MSaving:") and setup["qr"].startswith("data:image/svg+xml;base64,")
    secret = setup["secret"]
    bad = client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": "000000"})
    assert (bad.status_code, bad.json()) == (422, {"detail": "invalid_code"})
    codes = client.post("/v1/auth/two-factor/enable", headers=bearer(token),
                        json={"secret": secret, "code": pyotp.TOTP(secret).now()}).json()["recovery_codes"]
    assert len(codes) == 10 and len(set(codes)) == 10

    assert sign_in(client, name).json() == {"detail": "code_required"}
    assert sign_in(client, name, code="123456").json() == {"detail": "invalid_code"}
    assert sign_in(client, name, "wrong password!", code=pyotp.TOTP(secret).now()).json() == {"detail": "invalid_credentials"}
    assert sign_in(client, name, code=pyotp.TOTP(secret).now()).status_code == 200
    assert sign_in(client, name, code=codes[0]).status_code == 200                      # a recovery code works once
    assert sign_in(client, name, code=codes[0]).json() == {"detail": "invalid_code"}
    assert client.get("/v1/auth/two-factor", headers=bearer(token)).json() == {"enabled": True, "recovery_codes_left": 9}

    fresh = client.post("/v1/auth/two-factor/recovery-codes", headers=bearer(token),
                        json={"code": pyotp.TOTP(secret).now()}).json()["recovery_codes"]
    assert sign_in(client, name, code=codes[1]).json() == {"detail": "invalid_code"}    # the old ones stopped working
    assert sign_in(client, name, code=fresh[0]).status_code == 200

    assert client.post("/v1/auth/two-factor/disable", headers=bearer(token), json={"code": "123456"}).status_code == 422
    assert client.post("/v1/auth/two-factor/disable", headers=bearer(token),
                       json={"code": pyotp.TOTP(secret).now()}).status_code == 204
    assert sign_in(client, name).status_code == 200


def test_rate_limits(client):
    from app.core import sign_in as si
    name, _ = sign_up(client)
    saved, si.per_username = si.per_username, si.RateLimit(3, 60)
    try:
        assert [sign_in(client, name, "wrong password!").status_code for _ in range(4)] == [401, 401, 401, 429]
        assert sign_in(client, name).json() == {"detail": "rate_limited"}      # even with the right password
    finally:
        si.per_username = saved
    saved, si.sign_ups_per_ip = si.sign_ups_per_ip, si.RateLimit(1, 60)
    try:
        sign_up(client)
        assert sign_up(client, status=429) == {"detail": "rate_limited"}
    finally:
        si.sign_ups_per_ip = saved


# ---------------------------------------------------------------- the admin

def test_admin_disables_and_resets(client, admin):
    _, admin_token = admin
    name, token = sign_up(client)
    uid = me(client, token).json()["id"]
    users = {u["username"]: u for u in client.get("/v1/admin/users", headers=bearer(admin_token)).json()}
    assert users[name]["disabled_at"] is None and users[name]["two_factor"] is False and users[name]["last_seen_at"]

    assert client.post(f"/v1/admin/users/{uid}/disable", headers=bearer(admin_token), json={"disabled": True}).status_code == 204
    assert me(client, token).status_code == 401                                    # signed out at once
    assert sign_in(client, name).json() == {"detail": "invalid_credentials"}
    assert client.post(f"/v1/admin/users/{uid}/disable", headers=bearer(admin_token), json={"disabled": False}).status_code == 204
    token = sign_in(client, name).json()["token"]

    admin_id = me(client, admin_token).json()["id"]
    selfie = client.post(f"/v1/admin/users/{admin_id}/disable", headers=bearer(admin_token), json={"disabled": True})
    assert (selfie.status_code, selfie.json()) == (409, {"detail": "admin_self"})

    # Forgot the password and lost the phone: the admin's reset link.
    secret = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": pyotp.TOTP(secret).now()})
    link = client.post(f"/v1/admin/users/{uid}/reset", headers=bearer(admin_token)).json()
    assert datetime.fromisoformat(link["expires_at"]) > datetime.now(timezone.utc)
    weak = client.post("/v1/auth/reset", json={"token": link["token"], "new_password": "short"})
    assert weak.status_code == 422
    new = client.post("/v1/auth/reset", json={"token": link["token"], "new_password": "brand new password"})
    assert new.status_code == 200 and me(client, new.json()["token"]).status_code == 200
    assert me(client, token).status_code == 401                                    # every old session ended
    assert sign_in(client, name, "brand new password").status_code == 200          # and two-factor is off
    again = client.post("/v1/auth/reset", json={"token": link["token"], "new_password": "another password"})
    assert (again.status_code, again.json()) == (403, {"detail": "reset_invalid"})


def test_purge_removes_sign_in(client, database):
    name, token = sign_up(client)
    uid = me(client, token).json()["id"]
    with database.connect() as c:
        c.execute(text("update users set deletion_requested_at = now() - interval '31 days' where id = :u"), {"u": uid})
        assert uuid.UUID(uid) in {r[0] for r in c.execute(text("select * from purge_deleted_accounts()"))}
    assert me(client, token).status_code == 401 and sign_in(client, name).status_code == 401


# ---------------------------------------------------------------- a fresh server: migrate and setup

@pytest.fixture
def fresh_server(monkeypatch):
    """A new, empty database built by the server's own runner, with the API pointed at it."""
    from app.jobs import migrate
    name = f"fresh_{uuid.uuid4().hex[:8]}"
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'create database "{name}"'))
    url = ADMIN_URL.set(drivername="postgresql", database=name).render_as_string(hide_password=False)
    passwords = {login: "p" + uuid.uuid4().hex for login in migrate.LOGINS}
    try:
        yield url, passwords
    finally:
        from app.core import db
        db.engine.dispose()
        with admin.connect() as c:
            c.execute(text(f'drop database "{name}" with (force)'))
            for login in migrate.LOGINS:
                c.execute(text(f"drop role if exists {login}"))


def test_migrate_builds_a_server_and_is_safe_to_repeat(fresh_server):
    from app.jobs import migrate
    url, passwords = fresh_server
    backups = []
    applied, code = migrate.run(url, passwords, before_migrating=lambda: backups.append(1))
    assert applied == [m.name for m in sorted(migrate.MIGRATIONS.glob("*.sql"))] and backups == []   # nothing to back up yet
    assert code and len(code) == 14                                                 # XXXX-XXXX-XXXX
    applied2, code2 = migrate.run(url, passwords, before_migrating=lambda: backups.append(1))
    assert applied2 == [] and backups == [] and code2 != code                       # a new code each start
    with psycopg.connect(url) as conn:
        roles = dict(conn.execute(
            "select m.rolname, r.rolname from pg_auth_members a join pg_roles r on r.oid = a.roleid"
            " join pg_roles m on m.oid = a.member where m.rolname in ('api_login', 'purge_login', 'fx_login')"))
        assert roles == {"api_login": "app_user", "purge_login": "account_purger", "fx_login": "fx_updater"}
        assert not conn.execute("select bool_or(rolbypassrls or rolsuper) from pg_roles"
                                " where rolname in ('api_login', 'purge_login', 'fx_login')").fetchone()[0]
        # A later update with a new migration backs up first, then applies it.
        last = conn.execute("delete from msaving.migrations where version = (select max(version) from msaving.migrations)"
                            " returning name").fetchone()[0]
        conn.commit()
    applied3, _ = migrate.run(url, passwords, before_migrating=lambda: backups.append(1))
    assert backups == [1] and len(applied3) == 1 and last in applied3[0]


def test_setup_creates_the_admin_once(fresh_server, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    from app.core import db
    from app.jobs import migrate
    url, passwords = fresh_server
    _, code = migrate.run(url, passwords)
    from app.launch import login_url
    engine = create_engine(login_url(url, "api_login", passwords["api_login"]), connect_args={"prepare_threshold": None})
    monkeypatch.setattr(db, "engine", engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", sessions)
    from app.api import deps
    monkeypatch.setattr(deps, "SessionLocal", sessions)
    from app.api.main import app
    client = TestClient(app)

    assert client.get("/v1/instance").json()["setup_needed"] is True
    assert client.post("/v1/auth/sign-up", json={"username": "first", "password": PASSWORD}).json() == {"detail": "invite_required"}
    body = {"username": "Boss", "password": PASSWORD, "server_name": "Nhà Lan", "language": "vi"}
    wrong = client.post("/v1/setup", json={**body, "setup_code": "AAAA-BBBB-CCCC"})
    assert (wrong.status_code, wrong.json()) == (403, {"detail": "setup_invalid"})
    ok = client.post("/v1/setup", json={**body, "setup_code": code.lower()})
    assert ok.status_code == 201
    assert client.get("/v1/me", headers=bearer(ok.json()["token"])).json()["profile"]["is_admin"] is True
    assert client.get("/v1/instance").json() | {"server_version": None} == {
        "name": "Nhà Lan", "signup": "invite", "api_version": 1, "setup_needed": False, "server_version": None}
    again = client.post("/v1/setup", json={**body, "username": "boss2", "setup_code": code})
    assert (again.status_code, again.json()) == (403, {"detail": "setup_invalid"})
    _, code_after = migrate.run(url, passwords)
    assert code_after is None                                                       # no code once there's an admin
    engine.dispose()


def test_launcher_builds_login_urls():
    from app.launch import login_url
    assert login_url("postgresql://postgres:x@db:5432/postgres?sslmode=disable", "api_login", "p@ss/w?rd") == \
        "postgresql+psycopg://api_login:p%40ss%2Fw%3Frd@db:5432/postgres?sslmode=disable"
    assert login_url("postgresql://u:x@[::1]/app", "fx_login", "p", driver="postgresql") == "postgresql://fx_login:p@[::1]/app"


def test_job_schedule_times(monkeypatch):
    """msaving#6: each job at its time of day, the admin's (in their timezone) or JOBS_HOUR (UTC) until then; due
    once its time has come since it last started and since its schedule changed."""
    from zoneinfo import ZoneInfo

    from app.core import jobs
    monkeypatch.setenv("JOBS_HOUR", "19")
    t = lambda *a: datetime(*a, tzinfo=timezone.utc)
    assert (jobs.next_time(t(2026, 10, 21, 18), None, None), jobs.next_time(t(2026, 10, 21, 19), None, None)) == (
        t(2026, 10, 21, 19), t(2026, 10, 22, 19))
    assert jobs.last_time(t(2026, 10, 21, 18), None, None) == t(2026, 10, 20, 19)
    assert jobs.next_time(t(2026, 10, 21, 12), 150, "Asia/Ho_Chi_Minh") == t(2026, 10, 21, 19, 30)   # 02:30 in Vietnam
    # Daylight saving time doesn't move it: 02:00 in Berlin is 00:00 UTC in summer and 01:00 after 25 October.
    assert jobs.next_time(t(2026, 10, 20, 12), 120, "Europe/Berlin") == t(2026, 10, 21, 0)
    assert jobs.next_time(t(2026, 10, 30, 12), 120, "Europe/Berlin") == datetime(2026, 10, 31, 2, tzinfo=ZoneInfo("Europe/Berlin"))
    assert jobs.next_time(t(2026, 10, 30, 12), 120, "Europe/Berlin") == t(2026, 10, 31, 1)

    def due(now, **job):
        return jobs.is_due(now, {"enabled": True, "at_minute": None, "timezone": None, "last_started_at": None,
                                 "changed_at": None} | job)
    assert due(t(2026, 10, 21, 18))                                                     # never ran: a new server
    assert not due(t(2026, 10, 21, 18), last_started_at=t(2026, 10, 20, 19, 0, 5))      # ran at yesterday's time
    assert due(t(2026, 10, 21, 19, 0, 30), last_started_at=t(2026, 10, 20, 19, 0, 5))   # today's has come
    assert due(t(2026, 10, 21, 23), last_started_at=t(2026, 10, 19, 19))                # off at 19:00: catches up
    assert not due(t(2026, 10, 21, 23), last_started_at=t(2026, 10, 19, 19), changed_at=t(2026, 10, 21, 22))
    assert not due(t(2026, 10, 21, 23), enabled=False)


def test_daily_jobs_on_server_admin(client, admin, database):
    """msaving#6: the admin sees each job's time and last run, sets the time in their own timezone, and can turn
    only the exchange rates off."""
    _, admin_token = admin
    _, member = sign_up(client)
    url = "/v1/admin/jobs"
    assert client.get(url, headers=bearer(member)).json() == {"detail": "admin_only"}
    assert client.patch(f"{url}/backup", headers=bearer(member), json={"enabled": True}).json() == {"detail": "admin_only"}

    def listed():
        return {j["name"]: j for j in client.get(url, headers=bearer(admin_token)).json()}
    try:
        jobs = client.get(url, headers=bearer(admin_token)).json()
        assert [j["name"] for j in jobs] == ["purge", "backup", "rates"]
        assert all((j["at_minute"], j["timezone"], j["default_minute"], j["enabled"]) == (None, None, 19 * 60, True) for j in jobs)
        assert datetime.fromisoformat(jobs[0]["next_run_at"]).astimezone(timezone.utc).strftime("%H:%M") == "19:00"

        patch = lambda name, **body: client.patch(f"{url}/{name}", headers=bearer(admin_token), json=body)
        assert patch("backup", at_minute=150, timezone="Asia/Saigon").status_code == 204        # an alias, kept as the real name
        backup = listed()["backup"]
        assert (backup["at_minute"], backup["timezone"], backup["enabled"]) == (150, "Asia/Ho_Chi_Minh", True)
        from zoneinfo import ZoneInfo
        assert datetime.fromisoformat(backup["next_run_at"]).astimezone(ZoneInfo("Asia/Ho_Chi_Minh")).strftime("%H:%M") == "02:30"
        assert listed()["purge"]["at_minute"] is None                                        # the others stay

        for body in ({"at_minute": 150}, {"at_minute": 1440, "timezone": "UTC"}, {"at_minute": 60, "timezone": "Mars/Base"}):
            assert patch("purge", **body).status_code == 422, body
        assert patch("backup", enabled=False).json() == {"detail": "invalid"}                # can't do without backups
        assert patch("purge", enabled=False).json() == {"detail": "invalid"}
        assert patch("rates", enabled=False).status_code == 204 and listed()["rates"]["enabled"] is False
        assert listed()["rates"]["at_minute"] is None                                        # left out: stays
        assert patch("backup", at_minute=None).status_code == 204                            # back to JOBS_HOUR
        assert (listed()["backup"]["at_minute"], listed()["backup"]["timezone"]) == (None, None)
        assert patch("nightly", enabled=True).json() == {"detail": "not_found"}
    finally:
        with database.connect() as c:
            c.execute(text("update jobs set at_minute = null, timezone = null, enabled = true, changed_at = null"))


# ---------------------------------------------------------------- updates

def test_update_info_and_one_click_update(client, admin, tmp_path, monkeypatch):
    from app.core import updates
    _, admin_token = admin
    _, member_token = sign_up(client)
    assert client.get("/v1/admin/update", headers=bearer(member_token)).json() == {"detail": "admin_only"}

    monkeypatch.setattr(updates, "UPDATES", tmp_path)
    monkeypatch.setattr(updates, "current_version", lambda: "1.2.0")
    monkeypatch.setattr(updates, "_cache", (0.0, None))
    monkeypatch.setattr(updates, "_github", lambda url: {"tag_name": "v1.3.0", "html_url": "https://github.com/x/releases/v1.3.0"})
    info = client.get("/v1/admin/update", headers=bearer(admin_token)).json()
    assert info | {"status": None} == {"current_version": "1.2.0", "latest_version": "1.3.0", "update_available": True,
                                       "release_url": "https://github.com/x/releases/v1.3.0",
                                       "updater": False, "status": None}
    refused = client.post("/v1/admin/update", headers=bearer(admin_token))
    assert (refused.status_code, refused.json()) == (409, {"detail": "updater_off"})

    (tmp_path / "updater_alive").touch()                          # the helper is running
    assert client.get("/v1/admin/update", headers=bearer(admin_token)).json()["updater"] is True
    assert client.post("/v1/admin/update", headers=bearer(member_token)).json() == {"detail": "admin_only"}
    assert not (tmp_path / "requested").exists()
    assert client.post("/v1/admin/update", headers=bearer(admin_token)).status_code == 202
    assert (tmp_path / "requested").exists()

    # The helper's last result, unless it's from before this server started (an update by hand or a restart
    # since); a minute's grace, as it writes "done" just as the new server comes up.
    def status_after(line, started):
        (tmp_path / "status").write_text(line + "\n")
        monkeypatch.setattr(updates, "STARTED", datetime.fromisoformat(started).timestamp())
        return client.get("/v1/admin/update", headers=bearer(admin_token)).json()["status"]
    old = "failed 2026-10-19T16:01:40Z: Error response from daemon: error from registry: denied"
    assert status_after(old, "2026-10-20T16:27:30+00:00") is None
    assert status_after(old, "2026-10-19T16:00:00+00:00") == old                   # failed while this server ran
    assert status_after("done 2026-10-20T16:28:05Z", "2026-10-20T16:28:30+00:00") == "done 2026-10-20T16:28:05Z"
    assert status_after("running 2026-10-20T16:20:00Z", "2026-10-20T16:27:30+00:00") is None


def test_versions_compare():
    from app.core.updates import current_version, newer
    assert newer("1.10.0", "1.9.3") and not newer("1.2.0", "1.2.0") and not newer("1.3.0", "dev")
    assert newer("9999.0.0", current_version())                  # the repository's VERSION file is a version
