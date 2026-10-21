"""The database keeps only each session token's SHA-256. session_user_id() returns the user, or null for an unknown,
expired or ended session or a disabled account; that id becomes app.user_id for the request's transaction (db.py),
and row-level security does the rest."""
from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text

from app.core.sign_in import token_hash

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Caller:
    id: UUID
    token_sha256: bytes      # this session, for signing out it alone or every other one


def _unauthorized() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, "not_signed_in", headers={"WWW-Authenticate": "Bearer"})


def caller_from_token(token: str) -> Caller:
    from app.core.db import SessionLocal      # not at import: the tests set DATABASE_URL first
    digest = token_hash(token)
    with SessionLocal() as s, s.begin():
        user_id = s.execute(text("select session_user_id(:h)"), {"h": digest}).scalar()
    if user_id is None:
        raise _unauthorized()
    return Caller(id=user_id, token_sha256=digest)


def current_caller(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Caller:
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials:
        raise _unauthorized()
    return caller_from_token(creds.credentials)


def current_user(caller: Caller = Depends(current_caller)) -> UUID:
    return caller.id
