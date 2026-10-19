"""Shared database for the tests, against a real Postgres.

Needs a superuser connection (TEST_ADMIN_URL); it creates a throwaway database,
applies every file in migrations/ in order with the server's own runner
(app/jobs/migrate.py), creates one test login per restricted role, then drops
it all at the end.
"""
import os
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
ADMIN_URL = make_url(os.environ["TEST_ADMIN_URL"])
DB_NAME = f"spend_test_{uuid.uuid4().hex[:8]}"


def _url(user: str):
    return ADMIN_URL.set(database=DB_NAME, username=user, password=None)


@pytest.fixture(scope="session")
def database():
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'create database "{DB_NAME}"'))
    owner = create_engine(ADMIN_URL.set(database=DB_NAME), isolation_level="AUTOCOMMIT")
    with owner.connect() as c:
        # Supabase's own API roles, as on an operator's own Supabase project, so the lock-down is tested too.
        c.exec_driver_sql("do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then"
                          " create role anon nologin; create role authenticated nologin; end if; end $$")
        for kind in ("tables", "sequences", "functions"):      # what Supabase grants on new objects
            c.exec_driver_sql(f"alter default privileges in schema public grant all on {kind} to anon, authenticated")
    from app.jobs import migrate
    with psycopg.connect(ADMIN_URL.set(drivername="postgresql", database=DB_NAME).render_as_string(hide_password=False),
                         autocommit=True) as conn:
        for migration in migrate.pending(conn):
            migrate.apply(conn, migration)
    with owner.connect() as c:
        for login, role in [("t_api", "app_user"), ("t_fx", "fx_updater"), ("t_purge", "account_purger")]:
            c.exec_driver_sql(f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{login}')"
                              f" then create role {login} login; end if; end $$; grant {role} to {login}")
        # Most tests make accounts directly: open sign-up, so they need no invite.
        # test_sign_in.py tests invite-only, and sets it back.
        c.execute(text("update instance_settings set signup = 'open'"))
        c.execute(text("insert into fx_rates (quote, as_of, rate, source) values"
                       " ('EUR', '2026-08-01', 0.8, 't'), ('EUR', '2026-10-01', 0.9, 't'),"
                       " ('JPY', '2026-10-01', 150, 't')"))
    os.environ["DATABASE_URL"] = _url("t_api").render_as_string(hide_password=False)
    yield owner
    owner.dispose()
    from app.core import db
    db.engine.dispose()
    with admin.connect() as c:
        c.execute(text(f'drop database "{DB_NAME}" with (force)'))
        for login in ("t_api", "t_fx", "t_purge"):
            c.execute(text(f"drop role if exists {login}"))
