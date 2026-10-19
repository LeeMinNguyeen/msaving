"""Shared database for test_schema.py and test_api.py, against a real Postgres.

Needs a superuser connection (TEST_ADMIN_URL); it creates a throwaway database,
applies every file in supabase/migrations in order (exactly what reaches dev and
prod), creates one test login per restricted role, then drops it all at the end.
"""
import os
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
ADMIN_URL = make_url(os.environ["TEST_ADMIN_URL"])
DB_NAME = f"spend_test_{uuid.uuid4().hex[:8]}"
POLICY = "dev-2026-10-01"      # privacy policy published by supabase/seed.sql


def _url(user: str):
    return ADMIN_URL.set(database=DB_NAME, username=user, password=None)


@pytest.fixture(scope="session")
def database():
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'create database "{DB_NAME}"'))
    owner = create_engine(ADMIN_URL.set(database=DB_NAME), isolation_level="AUTOCOMMIT")
    with owner.connect() as c:
        # Supabase's own API roles, so the lock-down migration is tested too.
        c.exec_driver_sql("do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then"
                          " create role anon nologin; create role authenticated nologin; end if; end $$")
        # Supabase Auth's two-factor table, cut down to what my_mfa_required() reads.
        c.exec_driver_sql("create schema if not exists auth; create table if not exists auth.mfa_factors"
                          " (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text not null)")
        for kind in ("tables", "sequences", "functions"):      # what Supabase grants on new objects
            c.exec_driver_sql(f"alter default privileges in schema public grant all on {kind} to anon, authenticated")
        for migration in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            c.connection.driver_connection.execute(migration.read_text())   # raw: no % placeholders
        c.connection.driver_connection.execute((ROOT / "supabase" / "seed.sql").read_text())   # as `supabase db reset`
        for login, role in [("t_api", "app_user"), ("t_ai", "ai_reader"), ("t_fx", "fx_updater"), ("t_purge", "account_purger"),
                            ("t_bill", "billing_webhook")]:
            c.exec_driver_sql(f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{login}')"
                              f" then create role {login} login; end if; end $$; grant {role} to {login}")
        c.execute(text("insert into fx_rates (quote, as_of, rate, source) values"
                       " ('EUR', '2026-08-01', 0.8, 't'), ('EUR', '2026-10-01', 0.9, 't'),"
                       " ('JPY', '2026-10-01', 150, 't')"))
    os.environ["DATABASE_URL"] = _url("t_api").render_as_string(hide_password=False)
    sys.path.insert(0, str(ROOT))
    yield owner
    owner.dispose()
    from app.core import db
    db.engine.dispose()
    with admin.connect() as c:
        c.execute(text(f'drop database "{DB_NAME}" with (force)'))
        for login in ("t_api", "t_ai", "t_fx", "t_purge", "t_bill"):
            c.execute(text(f"drop role if exists {login}"))
