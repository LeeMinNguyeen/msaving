from collections.abc import Iterator

from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.auth import Caller, current_caller
from app.core.db import SessionLocal, request_session


def get_db(caller: Caller = Depends(current_caller)) -> Iterator[Session]:
    """One database transaction per request, as the signed-in user. Routes that
    write call db.commit() before returning (see request_session). Two-factor,
    when on, was checked at sign-in, before the session existed."""
    with request_session(caller.id) as session:
        yield session


def get_public_db() -> Iterator[Session]:
    """No signed-in user: row-level security shows no user data, only shared
    reference tables and the sign-in functions. For routes used before signing in."""
    with SessionLocal() as session:
        yield session
