"""Per-request database session for the FastAPI backend.

Every request runs in one DB transaction with app.user_id set *locally* to the
user from the verified token. Postgres row-level security then limits every
query to the books that user is a member of, with what their role allows.
Because the setting is transaction-local, a pooled connection carries no user
once the request ends, even if it errored.
"""
import os
from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker

# A login that is a member of app_user (no table ownership, no BYPASSRLS):
# api_login, made by app/jobs/migrate.py. A small pool: one API process
# serves a household or a small group. No prepared statements, so an
# operator's own database can sit behind a transaction pooler (Supabase's,
# PgBouncer): app.user_id is transaction-local, so that's safe.
engine = create_engine(
    os.environ["DATABASE_URL"], pool_pre_ping=True, pool_size=5, max_overflow=5, pool_recycle=1800,
    connect_args={"prepare_threshold": None},
)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


@contextmanager
def user_session(user_id: UUID) -> Iterator[Session]:
    with SessionLocal() as session, session.begin():
        session.execute(
            text("select set_config('app.user_id', :uid, true)"),  # true = local to this transaction
            {"uid": str(user_id)},
        )
        yield session


@contextmanager
def request_session(user_id: UUID) -> Iterator[Session]:
    """Like user_session, for API requests, where the route commits
    (db.commit()) before it returns. FastAPI runs a dependency's cleanup after
    the response is sent, so a commit there could fail (the ledger's shape
    checks run at commit) after the client already got 200. Every transaction
    this session begins gets app.user_id set first, so a route can commit and
    then read; anything not committed is rolled back when the request ends."""
    with SessionLocal() as session:
        @event.listens_for(session, "after_begin")
        def _set_user(session, transaction, connection):
            connection.execute(text("select set_config('app.user_id', :uid, true)"), {"uid": str(user_id)})

        yield session

