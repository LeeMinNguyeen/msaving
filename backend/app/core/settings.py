"""Settings read from the environment. No URL is written into code: each
environment sets them (Cloud Run settings and Secret Manager, or an untracked
.env locally). Read once, at import.
"""
import os
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    # Supabase project URL. The API fetches the token signing keys from it and
    # checks that tokens were issued by its Auth.
    supabase_url: str
    # Where to fetch those keys, if not from supabase_url. Only the local API
    # container needs it: tokens name 127.0.0.1 as issuer, which inside a
    # container is the container itself.
    supabase_jwks_url: str
    # The web app's origin; CORS allows it (locally, the Vite server).
    app_url: str
    # Development only: localhost origins CORS also allows, so a frontend developer's
    # local web app can call the hosted dev API. Empty in production.
    local_origins: tuple[str, ...]


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def parse_local_origins(raw: str) -> tuple[str, ...]:
    """EXTRA_ALLOWED_ORIGINS, comma-separated. Only http://localhost:<port> or
    http://127.0.0.1:<port>, so a typo can never open the API to a real site."""
    origins = tuple(o.strip().rstrip("/") for o in raw.split(",") if o.strip())
    for o in origins:
        if not re.fullmatch(r"http://(localhost|127\.0\.0\.1):\d{1,5}", o):
            raise RuntimeError(f"EXTRA_ALLOWED_ORIGINS: {o!r} is not a localhost origin")
    return origins


_supabase_url = _required("SUPABASE_URL").rstrip("/")
settings = Settings(
    supabase_url=_supabase_url,
    supabase_jwks_url=os.environ.get("SUPABASE_JWKS_URL") or f"{_supabase_url}/auth/v1/.well-known/jwks.json",
    app_url=_required("APP_URL").rstrip("/"),
    local_origins=parse_local_origins(os.environ.get("EXTRA_ALLOWED_ORIGINS", "")),
)
