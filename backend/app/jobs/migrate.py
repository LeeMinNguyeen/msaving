"""Brings the database up to date on every start, before the API; safe to repeat. Connects as the database's owner.

Applies the migrations not applied yet, each in its own transaction; creates or updates one login per role the
server uses, never superuser or BYPASSRLS; and while the server has no admin, prints a new setup code, so that only
whoever can read the server's log can create the admin account.
"""
from pathlib import Path

import psycopg
from psycopg import sql

from app.core.sign_in import new_code

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"
LOGINS = {"api_login": "app_user", "purge_login": "account_purger", "fx_login": "fx_updater"}


def pending(conn: psycopg.Connection) -> list[Path]:
    conn.execute("create schema if not exists msaving")
    conn.execute("create table if not exists msaving.migrations"
                 " (version text primary key, name text not null, applied_at timestamptz not null default now())")
    done = {r[0] for r in conn.execute("select version from msaving.migrations")}
    return [f for f in sorted(MIGRATIONS.glob("*.sql")) if f.name.split("_", 1)[0] not in done]


def has_data(conn: psycopg.Connection) -> bool:
    """True once the first migration has run: a backup is worth taking."""
    return conn.execute("select to_regclass('msaving.migrations') is not null"
                        " and exists (select 1 from msaving.migrations)").fetchone()[0]


def apply(conn: psycopg.Connection, migration: Path) -> None:
    version, _, name = migration.stem.partition("_")
    with conn.transaction():
        conn.execute(migration.read_text())          # no parameters: % stays as written
        conn.execute("insert into msaving.migrations (version, name) values (%s, %s)", (version, name))


def set_logins(conn: psycopg.Connection, passwords: dict[str, str]) -> None:
    """Since PostgreSQL 16 only a superuser may name SUPERUSER or BYPASSRLS in ALTER ROLE, even to turn them off,
    and an owner on Supabase isn't one: an existing login gets its password, then those two are checked, and
    turned off only if one is on (which then needs a superuser owner, and fails loudly otherwise)."""
    for login, role in LOGINS.items():
        name, password = sql.Identifier(login), sql.Literal(passwords[login])
        found = conn.execute("select rolsuper or rolbypassrls from pg_roles where rolname = %s", (login,)).fetchone()
        if found is None:
            conn.execute(sql.SQL("create role {} login nosuperuser nobypassrls password {}").format(name, password))
        else:
            conn.execute(sql.SQL("alter role {} login password {}").format(name, password))
            if found[0]:
                conn.execute(sql.SQL("alter role {} nosuperuser nobypassrls").format(name))
        conn.execute(sql.SQL("grant {} to {}").format(sql.Identifier(role), name))


def new_setup_code(conn: psycopg.Connection) -> str | None:
    """A fresh setup code while there's no admin, else None."""
    if not conn.execute("select setup_needed from instance_info()").fetchone()[0]:
        return None
    code, digest = new_code(groups=3)
    conn.execute("update instance_settings set setup_code_sha256 = %s", (digest,))
    return code


def run(admin_url: str, passwords: dict[str, str], before_migrating=None) -> tuple[list[str], str | None]:
    """Returns (the migrations applied, the setup code if the server needs one).
    before_migrating(): called once, only when an existing database is about
    to change (the launcher takes a backup there)."""
    with psycopg.connect(admin_url, autocommit=True) as conn:
        todo = pending(conn)
        if todo and before_migrating and has_data(conn):
            before_migrating()
        for migration in todo:
            apply(conn, migration)
        set_logins(conn, passwords)
        return [m.name for m in todo], new_setup_code(conn)
