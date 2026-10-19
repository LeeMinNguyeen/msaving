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

# Login role that is a member of app_user (no table ownership, no BYPASSRLS).
# sslmode=require so credentials and data are never sent in clear text.
# Small pool: on Supabase Free the Session pooler shares about 15 database
# connections between every client. 2 + 2 per instance, times the API's
# max_instance_count (3, infra/terraform), leaves room for the jobs. Developers'
# local APIs use the Transaction pooler (port 6543) instead, which shares
# connections between many clients; app.user_id is transaction-local, so that's
# safe, but it can't keep prepared statements, so psycopg never makes any.
engine = create_engine(
    os.environ["DATABASE_URL"], pool_pre_ping=True, pool_size=2, max_overflow=2, pool_recycle=1800,
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


# FastAPI wiring (superseded by app/api/deps.py, kept as the short version) (current_user verifies the auth provider's JWT and returns its user id):
#
#   def get_db(user_id: UUID = Depends(current_user)) -> Iterator[Session]:
#       with user_session(user_id) as session:
#           yield session
#
#   @app.get("/books/{book_id}/balances")
#   def balances(book_id: UUID, db: Session = Depends(get_db)):
#       return db.execute(
#           text("select * from account_balances where book_id = :b"), {"b": book_id}
#       ).mappings().all()
