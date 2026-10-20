"""The building blocks of signing in (docs: Sign-in): passwords, codes,
tokens and rate limits. The routes are in app/api/routes/v1/sign_in.py.

- Passwords: argon2id (argon2-cffi's defaults), checked here; the database
  keeps only the hash.
- Two-factor, optional: TOTP (any authenticator app), 30-second steps, one
  step of clock drift either way; or one of ten one-time recovery codes.
- Tokens (sessions, password reset links) are random; codes people type
  (invites, the setup code, recovery codes) are short and readable. The
  database keeps the SHA-256 of each, never the value.
- Rate limits: in memory, per server process (a server runs one).
"""
import base64
import hashlib
import secrets
import threading
import time
from collections import deque
from io import BytesIO

import pyotp
import segno
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

hasher = PasswordHasher()
# Checked against when the username doesn't exist, so a wrong username takes
# as long as a wrong password and doesn't reveal which accounts exist.
_DUMMY_HASH = hasher.hash(secrets.token_urlsafe(16))

MIN_PASSWORD = 10
MAX_PASSWORD = 256
# Crockford's base32 without look-alikes (no I, L, O, U): easy to read aloud and type.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def hash_password(password: str) -> str:
    return hasher.hash(password)


def password_matches(password_hash: str | None, password: str) -> bool:
    try:
        return hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def sha256(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def token_hash(token: str) -> bytes:
    return sha256(token)


def new_token() -> tuple[str, bytes]:
    """A session or reset token: (the value for the client, its SHA-256)."""
    token = secrets.token_urlsafe(32)
    return token, token_hash(token)


def new_code(groups: int = 2) -> tuple[str, bytes]:
    """A code people type, like X7K2-9QPM (two groups: 40 bits; with expiry,
    one use and rate limits, enough for an invite). (code, SHA-256 of its
    normal form)."""
    code = "-".join("".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(groups))
    return code, code_hash(code)


def code_hash(code: str) -> bytes:
    """Typed codes are compared without dashes, spaces or case, and with the
    look-alikes read as Crockford reads them (I and L as 1, O as 0)."""
    normal = code.upper().replace("-", "").replace(" ", "")
    return sha256(normal.translate(str.maketrans("ILO", "110")))


def new_totp_secret() -> str:
    return pyotp.random_base32()        # 32 characters, 160 bits


def totp_uri(secret: str, username: str, server_name: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=server_name)


def totp_matches(secret: str, code: str) -> bool:
    code = code.strip().replace(" ", "")
    return code.isdigit() and len(code) == 6 and pyotp.TOTP(secret).verify(code, valid_window=1)


def qr_svg(data: str) -> str:
    """A QR code as an SVG data URI, for an <img>."""
    out = BytesIO()
    segno.make(data, error="m").save(out, kind="svg", scale=4, border=2, xmldecl=False)
    return "data:image/svg+xml;base64," + base64.b64encode(out.getvalue()).decode()


class RateLimit:
    """At most `limit` hits per key in a sliding `window` of seconds."""

    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            if len(self._hits) > 10_000:     # forget idle keys so memory stays bounded
                for k in [k for k, v in self._hits.items() if not v or v[-1] <= now - self.window]:
                    del self._hits[k]
            return True


# Defaults, not decided (docs: Sign-in): enough for a person who
# mistypes, far too few for guessing.
per_ip = RateLimit(30, 15 * 60)               # sign-in, join, setup, reset, invite checks
per_username = RateLimit(10, 15 * 60)         # sign-in attempts on one account
per_user_action = RateLimit(10, 15 * 60)      # password and two-factor changes by a signed-in user
sign_ups_per_ip = RateLimit(5, 60 * 60)
# A taken name answers username_taken, so changing one's username can list who
# has an account: a few tries an hour.
username_changes = RateLimit(5, 60 * 60)
