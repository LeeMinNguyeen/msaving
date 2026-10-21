from collections.abc import Iterator

from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.auth import Caller, current_caller
from app.core.db import SessionLocal, request_session


def get_db(caller: Caller = Depends(current_caller)) -> Iterator[Session]:
    """One transaction per request, as the signed-in user. Routes that write must call db.commit()."""
    with request_session(caller.id) as session:
        yield session


def get_public_db() -> Iterator[Session]:
    """For routes used before sign-in: with no user, row-level security shows no user data."""
    with SessionLocal() as session:
        yield session
