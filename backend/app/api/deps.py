from collections.abc import Iterator

from fastapi import Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.auth import Caller, current_caller
from app.core.db import SessionLocal, request_session


def get_db(caller: Caller = Depends(current_caller)) -> Iterator[Session]:
    """One database transaction per request, as the signed-in user. Routes that
    write call db.commit() before returning (see request_session).

    A user with two-factor sign-in must have used it: a password-only token
    (aal1) gets 401 mfa_required, and the app asks for the code."""
    with request_session(caller.id) as session:
        if caller.aal != "aal2" and session.execute(text("select my_mfa_required()")).scalar():
            raise HTTPException(401, "mfa_required", headers={"WWW-Authenticate": "Bearer"})
        yield session


def get_public_db() -> Iterator[Session]:
    """No signed-in user: row-level security shows no user data, only shared
    reference tables. For routes the sign-up screen needs before an account exists."""
    with SessionLocal() as session:
        yield session
