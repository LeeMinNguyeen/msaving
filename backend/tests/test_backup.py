"""Needs pg_dump, pg_restore and psql of the server's version on PATH. Restores with the `$` commands in backup.py's
docstring. Drops every database it creates, and the roles it created that weren't there before."""
import ast
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import psycopg
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parents[1]
ADMIN_URL = make_url(os.environ["TEST_ADMIN_URL"])
SOURCE = f"backup_src_{uuid.uuid4().hex[:8]}"
SECRET = f"pw@{uuid.uuid4().hex[:12]}"
# The restore commands documented in backup.py: steps 2 (outside the dump) and 3 (the app).
RESTORE = [line.strip()[2:] for line in
           ast.get_docstring(ast.parse((ROOT / "app" / "jobs" / "backup.py").read_text())).splitlines()
           if line.strip().startswith("$ ")]
# Roles the migrations and this file create, dropped at the end if they're new.
OUR_ROLES = {"app_user", "fx_updater", "account_purger"}

def libpq_url(database, **kw):
    """The test server as a libpq URL, which pg_dump and psql take."""
    return ADMIN_URL.set(drivername="postgresql", database=database, **kw).render_as_string(hide_password=False)


def sql(database, *statements, autocommit=True):
    """Runs statements (one transaction unless autocommit); returns the last one's rows."""
    eng = create_engine(ADMIN_URL.set(database=database), poolclass=NullPool,
                        **({"isolation_level": "AUTOCOMMIT"} if autocommit else {}))
    with eng.begin() as c:
        rows = None
        for s in statements:
            stmt, params = (s, {}) if isinstance(s, str) else s
            result = c.execute(text(stmt), params)
            rows = result.all() if result.returns_rows else None
    return rows


@pytest.fixture(scope="module")
def source():
    roles_before = {r[0] for r in sql(ADMIN_URL.database, "select rolname from pg_roles")}
    sql(ADMIN_URL.database, f'create database "{SOURCE}"')
    from app.jobs import migrate
    with psycopg.connect(libpq_url(SOURCE), autocommit=True) as conn:
        for migration in migrate.pending(conn):
            migrate.apply(conn, migration)
        conn.execute("update instance_settings set signup = 'open'")
    # A user, a book, an account and a transaction, written as that user.
    u, b, a, t = (str(uuid.uuid4()) for _ in range(4))
    sql(SOURCE,
        ("select set_config('app.user_id', :u, true)", {"u": u}),
        ("insert into users (id, username) values (:u, 'backup_user')", {"u": u}),
        ("insert into books (id, created_by, name, base_currency, timezone) values (:b, :u, 'Home', 'USD', 'UTC')", {"b": b, "u": u}),
        ("insert into accounts (id, book_id, name, kind, currency) values (:a, :b, 'Checking', 'checking', 'USD')", {"a": a, "b": b}),
        ("insert into transactions (id, book_id, type, occurred_on) values (:t, :b, 'opening_balance', '2026-10-01')", {"t": t, "b": b}),
        ("insert into entries (book_id, transaction_id, account_id, amount) values (:b, :t, :a, 100000)", {"b": b, "t": t, "a": a}),
        autocommit=False)
    yield SOURCE
    sql(ADMIN_URL.database, f'drop database "{SOURCE}" with (force)')
    for role in OUR_ROLES - roles_before:
        try:
            sql(ADMIN_URL.database, f'drop role if exists "{role}"')
        except DBAPIError:      # another test database uses it now, so it isn't ours alone
            pass


@pytest.fixture
def target(source):
    """An empty database to restore into."""
    name = f"backup_dst_{uuid.uuid4().hex[:8]}"
    sql(ADMIN_URL.database, f'create database "{name}"')
    yield name
    sql(ADMIN_URL.database, f'drop database "{name}" with (force)')


def run_job(url, backup_dir):
    return subprocess.run([sys.executable, "-B", "-m", "app.jobs.backup"], cwd=ROOT, capture_output=True, text=True,
                          env={**os.environ, "BACKUP_DATABASE_URL": url, "BACKUP_DIR": str(backup_dir),
                               "PG_DUMP": shutil.which("pg_dump") or ""})


def backup(tmp_path):
    bucket = tmp_path / "bucket"
    bucket.mkdir()
    r = run_job(libpq_url(SOURCE), bucket)
    assert r.returncode == 0, r.stderr
    files = os.listdir(bucket)
    assert len(files) == 1 and files[0].startswith("msaving-") and files[0].endswith(".dump"), files
    assert (bucket / files[0]).stat().st_mode & 0o777 == 0o600            # holds password hashes
    return bucket / files[0], r.stdout


def restore(dump, database, steps, workdir):
    for step in steps:
        r = subprocess.run(step, shell=True, executable="/bin/bash", cwd=workdir, capture_output=True, text=True,
                           env={**os.environ, "DUMP": str(dump), "NEW_DB_URL": libpq_url(database)})
        assert r.returncode == 0, (step, r.stderr)


def snapshot(database):
    """Row counts of every table in public, and what makes it work: grants, policies, triggers.
    Grants are compared as they take effect (a dump leaves out ones equal to the default)."""
    tables = [r[0] for r in sql(database, "select tablename from pg_tables where schemaname = 'public' order by 1")]
    acl = "(select string_agg(a::text, ',' order by a::text) from unnest({}) a)"
    in_public = "in (select oid from pg_class where relnamespace = 'public'::regnamespace)"
    rel_acl = "coalesce(relacl, acldefault(case relkind when 'S' then 's' else 'r' end::\"char\", relowner))"
    proc_acl = "coalesce(proacl, acldefault('f', proowner))"
    return {
        "rows": {t: sql(database, f'select count(*) from public."{t}"')[0][0] for t in tables},
        "relations": sql(database, f"select relname, relkind, relrowsecurity, {acl.format(rel_acl)} from pg_class"
                                   " where relnamespace = 'public'::regnamespace order by 1"),
        "columns": sql(database, f"select attrelid::regclass::text, attname, {acl.format('attacl')} from pg_attribute"
                                 f" where attrelid {in_public} and attnum > 0 and not attisdropped order by 1, 2"),
        "functions": sql(database, f"select oid::regprocedure::text, prosecdef, {acl.format(proc_acl)} from pg_proc"
                                   " where pronamespace = 'public'::regnamespace and oid not in"
                                   " (select objid from pg_depend where deptype = 'e') order by 1"),   # not pgcrypto's
        "policies": sql(database, "select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies"
                                  " where schemaname = 'public' order by 1, 2"),
        "triggers": sql(database, f"select tgrelid::regclass::text, tgname, tgenabled from pg_trigger"
                                  f" where tgrelid {in_public} and not tgisinternal order by 1, 2"),
        "default_privileges": sql(database, "select defaclrole::regrole::text, defaclnamespace, defaclobjtype,"
                                            f" {acl.format('defaclacl')} from pg_default_acl order by 1, 2, 3"),
    }


def test_restore_commands_documented():
    assert len(RESTORE) == 4 and RESTORE[0].startswith("psql") and RESTORE[3].startswith("pg_restore --no-owner")


def test_backup_restores_everything(source, target, tmp_path):
    dump, log = backup(tmp_path)
    assert "in public" in log and "in msaving" in log
    restore(dump, target, RESTORE, tmp_path)
    before, after = snapshot(source), snapshot(target)
    assert before["rows"]["users"] == before["rows"]["transactions"] == before["rows"]["entries"] == 1
    for part in before:
        assert after[part] == before[part], part
    # The list of applied migrations came back: the server won't run them again.
    assert sql(target, "select version from msaving.migrations order by 1") == \
        sql(source, "select version from msaving.migrations order by 1")


def fake_pg_dump(tmp_path, body):
    """A pg_dump stand-in that records how it was called, then runs body."""
    wrapper = tmp_path / "bin" / "pg_dump"
    wrapper.parent.mkdir()
    wrapper.write_text(f'#!/bin/bash\nprintf "%s\\n" "argv: $*" "PGPASSWORD=${{PGPASSWORD-unset}}" >> "{tmp_path}/calls"\n{body}\n')
    wrapper.chmod(0o755)
    return wrapper


def test_password_goes_to_pg_dump_only_as_pgpassword(source, tmp_path):
    wrapper = fake_pg_dump(tmp_path, f'exec "{shutil.which("pg_dump")}" "$@"')
    bucket = tmp_path / "bucket"
    bucket.mkdir()
    r = subprocess.run([sys.executable, "-B", "-m", "app.jobs.backup"], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, "BACKUP_DATABASE_URL": libpq_url(SOURCE, password=SECRET),
                            "BACKUP_DIR": str(bucket), "PG_DUMP": str(wrapper)})
    assert r.returncode == 0, r.stderr                                    # the test server trusts local logins
    argv, env = (tmp_path / "calls").read_text().splitlines()
    assert SECRET not in argv and quote(SECRET) not in argv and env == f"PGPASSWORD={SECRET}"
    assert len(os.listdir(bucket)) == 1


def test_errors_never_show_the_password(source, tmp_path):
    wrapper = fake_pg_dump(tmp_path, 'echo "$* $PGPASSWORD" >&2; exit 1')
    bucket = tmp_path / "bucket"
    bucket.mkdir()
    tail = SECRET.split("@")[1]
    raw = [libpq_url(SOURCE).replace("@", f":{c}{tail}@", 1) for c in "#/?@"]     # unencoded, refused
    for url in (libpq_url(SOURCE, password=SECRET), *raw):
        r = subprocess.run([sys.executable, "-B", "-m", "app.jobs.backup"], cwd=ROOT, capture_output=True, text=True,
                           env={**os.environ, "BACKUP_DATABASE_URL": url, "BACKUP_DIR": str(bucket), "PG_DUMP": str(wrapper)})
        out = r.stdout + r.stderr
        assert r.returncode == 1 and "backup failed" in out and SECRET not in out and quote(SECRET) not in out, out
        assert tail not in out, out
        assert (url in raw) == ("percent-encode" in out), out              # refused before pg_dump runs
    assert os.listdir(bucket) == []


def test_old_dumps_are_deleted_after_a_good_one(source, tmp_path):
    """Dumps older than 5 days 12 hours go once a new dump exists."""
    bucket = tmp_path / "bucket"
    bucket.mkdir()
    five_days_ago = datetime.now(timezone.utc) - timedelta(days=5)
    old, recent, other = "msaving-20200101T000000Z.dump", f"msaving-{five_days_ago:%Y%m%dT%H%M%SZ}.dump", "notes.txt"
    for n in (old, old + ".partial", recent, other):
        (bucket / n).write_text("x")
    r = run_job(libpq_url(SOURCE), bucket)
    assert r.returncode == 0, r.stderr
    left = sorted(os.listdir(bucket))
    assert old not in left and old + ".partial" not in left and recent in left and other in left and len(left) == 3
    # A failed run deletes nothing.
    (bucket / old).write_text("x")
    assert run_job(libpq_url("no_such_db"), bucket).returncode == 1 and old in os.listdir(bucket)


@pytest.mark.parametrize("url", [
    libpq_url("no_such_db", username="nobody", password=SECRET),       # pg_dump can't connect
    f"postgresql+psycopg://nobody:{quote(SECRET)}@localhost/x",         # not a URL pg_dump takes
])
def test_failed_backup_leaves_nothing_and_hides_the_password(tmp_path, url):
    r = run_job(url, tmp_path)
    assert r.returncode != 0 and "backup failed" in r.stderr
    assert os.listdir(tmp_path) == []
    out = r.stdout + r.stderr
    assert SECRET not in out and quote(SECRET) not in out and url not in out


@pytest.fixture
def live(source, tmp_path):
    """A running server's database, restored from a backup of the source, and that backup."""
    name = f"backup_live_{uuid.uuid4().hex[:8]}"
    sql(ADMIN_URL.database, f'create database "{name}"')
    dump, _ = backup(tmp_path)
    restore(dump, name, RESTORE, tmp_path)
    yield name, dump
    sql(ADMIN_URL.database, f'drop database "{name}" with (force)')


def requested(tmp_path, dump_bytes, purged=None):
    backups = tmp_path / "backups"
    (backups / "restore").mkdir(parents=True)
    (backups / "restore" / "request.dump").write_bytes(dump_bytes)
    if purged is not None:
        (backups / "restore" / "purged_accounts.jsonl").write_text(purged)
    return backups


def users(database):
    return [r[0] for r in sql(database, "select username from users order by 1")]


def test_restore_requested_from_the_web(live, tmp_path):
    """R-INST-8: the launcher restores a backup the admin uploaded, after backing up what it replaces, and adds the
    backup's purged accounts to PURGE_LOG."""
    from app.jobs import restore as web_restore
    name, dump = live
    sql(name, "insert into users (id, username) values (gen_random_uuid(), 'after_backup')")
    gone = str(uuid.uuid4())
    backups = requested(tmp_path, dump.read_bytes(), json.dumps({"user_id": gone, "purged_at": "2026-10-20T00:00:00Z"}) + "\n")
    assert web_restore.restore_if_requested(libpq_url(name), str(backups)) == "done"
    assert users(name) == ["backup_user"]
    status = json.loads((backups / "restore" / "status").read_text())
    assert status["status"] == "done" and status["at"]
    assert not (backups / "restore" / "request.dump").exists()
    assert len(list(backups.glob("msaving-*.dump"))) == 1                 # what it replaced
    assert gone in (backups / "purged_accounts.jsonl").read_text()
    assert web_restore.restore_if_requested(libpq_url(name), str(backups)) is None


def test_a_failed_restore_puts_the_database_back(live, tmp_path, monkeypatch):
    from app.jobs import restore as web_restore
    name, dump = live
    sql(name, "insert into users (id, username) values (gen_random_uuid(), 'after_backup')")
    backups = requested(tmp_path, dump.read_bytes())
    real = web_restore._load

    def broken_once(url, path):
        if Path(path).name == "request.dump":
            raise web_restore.RestoreError("pg_restore failed: something broke")
        return real(url, path)

    monkeypatch.setattr(web_restore, "_load", broken_once)
    assert web_restore.restore_if_requested(libpq_url(name), str(backups)) == "failed"
    assert users(name) == ["after_backup", "backup_user"]
    status = json.loads((backups / "restore" / "status").read_text())
    assert status["status"] == "failed" and "something broke" in status["detail"]
    assert not (backups / "restore" / "request.dump").exists()


def test_a_file_that_is_no_backup_changes_nothing(live, tmp_path):
    from app.jobs import restore as web_restore
    name, _ = live
    backups = requested(tmp_path, b"not a dump at all")
    assert web_restore.restore_if_requested(libpq_url(name), str(backups)) == "failed"
    assert users(name) == ["backup_user"]
    assert not list(backups.glob("msaving-*.dump"))
