"""Verifies the Supabase access token on every request.

Checks the signature against the project's published signing keys (asymmetric
only: a shared secret would let anyone who holds it mint tokens), the expiry,
the audience and the issuer, then returns the user's id. That id becomes
app.user_id for the request's database transaction (see db.py), and row-level
security does the rest.
"""
from dataclasses import dataclass
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.settings import settings

AUDIENCE = "authenticated"                  # Supabase's audience for signed-in users
ISSUER = f"{settings.supabase_url}/auth/v1"
ALGORITHMS = ["ES256", "RS256"]             # never HS256

# Keys are cached; an unknown key id (after a key rotation) triggers one refetch.
jwks = jwt.PyJWKClient(settings.supabase_jwks_url, cache_keys=True, lifespan=600)
bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Caller:
    id: UUID
    # Supabase only issues tokens after the email link is clicked (confirmations
    # are on), so this is a confirmed address. The users row copies it from
    # here, never from what the user types.
    email: str | None
    # How this sign-in was made: aal2 = with the second factor.
    aal: str = "aal1"


def _unauthorized() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, "not_signed_in", headers={"WWW-Authenticate": "Bearer"})


def caller_from_token(token: str) -> Caller:
    try:
        key = jwks.get_signing_key_from_jwt(token)
        claims = jwt.decode(token, key.key, algorithms=ALGORITHMS, audience=AUDIENCE, issuer=ISSUER,
                            options={"require": ["exp", "sub", "aud", "iss"]})
        return Caller(id=UUID(claims["sub"]), email=claims.get("email") or None, aal=claims.get("aal") or "aal1")
    except (jwt.PyJWTError, ValueError):
        raise _unauthorized() from None


def current_caller(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Caller:
    if creds is None or creds.scheme.lower() != "bearer":
        raise _unauthorized()
    return caller_from_token(creds.credentials)


def current_user(caller: Caller = Depends(current_caller)) -> UUID:
    return caller.id
