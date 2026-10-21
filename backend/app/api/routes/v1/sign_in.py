"""Setup, joining and signing in each return a session token for `Authorization: Bearer`. No email anywhere."""
import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db, get_public_db
from app.api.models import Timezone
from app.core import sign_in as si
from app.core.auth import Caller, current_caller
from app.core.db import user_session

router = APIRouter()

Username = Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=30)]
Password = Annotated[str, StringConstraints(min_length=si.MIN_PASSWORD, max_length=si.MAX_PASSWORD)]
AnyPassword = Annotated[str, StringConstraints(max_length=si.MAX_PASSWORD)]
Code = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)]
DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
RECOVERY_CODES = 10


class Token(BaseModel):
    token: str


def _client_ip(request: Request) -> str:
    # Behind a reverse proxy (Caddy, a tunnel), uvicorn's --proxy-headers puts
    # the browser's address here.
    return request.client.host if request.client else "unknown"


def _limit(*checks: tuple[si.RateLimit, str]) -> None:
    for limit, key in checks:
        if not limit.allow(key):
            raise HTTPException(429, "rate_limited")


def _device(request: Request) -> str | None:
    return si.device_label(request.headers.get("user-agent"))


def _start_session(user_id: uuid.UUID, device: str | None) -> Token:
    token, digest = si.new_token()
    with user_session(user_id) as s:
        s.execute(text("insert into sessions (token_sha256, user_id, device) values (:h, :u, :d)"),
                  {"h": digest, "u": user_id, "d": device})
    return Token(token=token)


class NewAccount(BaseModel):
    username: Username
    password: Password
    display_name: DisplayName | None = None
    language: Literal["vi", "en"] = "vi"
    timezone: Timezone = "UTC"


def _create_account(body: NewAccount, device: str | None, before_insert: str | None, after_insert: str | None,
                    code: bytes | None, then: Callable[[Session], object] | None = None) -> Token:
    """The users row and its password in one transaction, with the setup or invite claimed in it. The database
    refuses an account with no way in (users_need_a_way_in)."""
    user_id = uuid.uuid4()
    with user_session(user_id) as s:
        if before_insert:
            s.execute(text(before_insert), {"c": code})
        s.execute(text("insert into users (id, username, display_name, timezone, language)"
                       " values (:i, :u, :d, :tz, :l)"),
                  {"i": user_id, "u": body.username, "d": body.display_name or None, "tz": body.timezone,
                   "l": body.language})
        if after_insert:
            s.execute(text(after_insert), {"c": code})
        s.execute(text("insert into local_credentials (user_id, password_hash) values (:i, :h)"),
                  {"i": user_id, "h": si.hash_password(body.password)})
        if then:
            then(s)
    return _start_session(user_id, device)


class Setup(NewAccount):
    setup_code: Code
    server_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] | None = None


@router.post("/setup", status_code=201)
def setup(body: Setup, request: Request) -> Token:
    """The first account, which becomes the admin."""
    _limit((si.per_ip, f"setup:{_client_ip(request)}"))
    name = body.server_name
    return _create_account(body, _device(request), "select claim_setup(:c)", None, si.code_hash(body.setup_code),
                           then=lambda s: name and s.execute(text("select admin_set_instance(:n, null)"), {"n": name}))


class InviteCheck(BaseModel):
    code: Code


class InviteStatus(BaseModel):
    valid: bool


@router.post("/auth/invite-check")
def invite_check(body: InviteCheck, request: Request, db: Session = Depends(get_public_db)) -> InviteStatus:
    _limit((si.per_ip, f"invite:{_client_ip(request)}"))
    return InviteStatus(valid=bool(db.execute(text("select invite_is_valid(:c)"), {"c": si.code_hash(body.code)}).scalar()))


class SignUp(NewAccount):
    invite_code: Code | None = None      # required unless the admin has opened sign-up


@router.post("/auth/sign-up", status_code=201)
def sign_up(body: SignUp, request: Request) -> Token:
    """Without an invite code, the database refuses unless sign-up is open (403 invite_required)."""
    ip = _client_ip(request)
    _limit((si.sign_ups_per_ip, ip), (si.per_ip, f"invite:{ip}"))
    if body.invite_code:
        return _create_account(body, _device(request), None, "select claim_invite(:c)", si.code_hash(body.invite_code))
    return _create_account(body, _device(request), None, None, None)


class SignIn(BaseModel):
    username: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, max_length=30)]
    password: AnyPassword
    code: Code | None = None           # the authenticator's 6 digits, or a recovery code


@router.post("/auth/sign-in")
def sign_in(body: SignIn, request: Request, db: Session = Depends(get_public_db)) -> Token:
    _limit((si.per_ip, f"sign-in:{_client_ip(request)}"), (si.per_username, body.username))
    row = db.execute(text("select * from sign_in_lookup(:u)"), {"u": body.username}).mappings().first()
    if not si.password_matches(row["password_hash"] if row else None, body.password):
        raise HTTPException(401, "invalid_credentials")
    if row["totp_secret"]:
        if not body.code:
            raise HTTPException(401, "code_required")
        ok = si.totp_matches(row["totp_secret"], body.code) or db.execute(
            text("select use_recovery_code(:u, :c)"), {"u": row["user_id"], "c": si.code_hash(body.code)}).scalar()
        db.commit()
        if not ok:
            raise HTTPException(401, "invalid_code")
    return _start_session(row["user_id"], _device(request))


@router.post("/auth/sign-out", status_code=204)
def sign_out(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Response:
    db.execute(text("delete from sessions where token_sha256 = :h"), {"h": caller.token_sha256})
    db.commit()
    return Response(status_code=204)


class DeviceSession(BaseModel):
    id: uuid.UUID
    device: str | None          # "Chrome · Windows"; None: not recognised, or signed in before devices were kept
    created_at: datetime
    last_used_at: datetime      # updated at most once a minute
    current: bool               # the device making this request


@router.get("/auth/sessions")
def sessions(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> list[DeviceSession]:
    """Never a token or its hash. Sessions past their lifetime aren't listed, even before the purge deletes them."""
    rows = db.execute(text("select id, device, created_at, last_used_at, token_sha256 = :h as current from sessions"
                           " where user_id = :u and last_used_at > now() - session_lifetime(:u)"
                           " order by token_sha256 = :h desc, last_used_at desc"),
                      {"u": caller.id, "h": caller.token_sha256}).mappings()
    return [DeviceSession(**r) for r in rows]


@router.delete("/auth/sessions/{session_id}", status_code=204)
def end_session(session_id: uuid.UUID, caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Response:
    """Ending this device's own session signs it out."""
    n = db.execute(text("delete from sessions where id = :i and user_id = :u"), {"i": session_id, "u": caller.id}).rowcount
    if not n:
        raise HTTPException(404, "not_found")
    db.commit()
    return Response(status_code=204)


@router.post("/auth/sign-out-others", status_code=204)
def sign_out_others(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Response:
    db.execute(text("delete from sessions where user_id = :u and token_sha256 <> :h"),
               {"u": caller.id, "h": caller.token_sha256})
    db.commit()
    return Response(status_code=204)


class ChangePassword(BaseModel):
    current_password: AnyPassword
    new_password: Password


@router.post("/auth/password", status_code=204)
def change_password(body: ChangePassword, caller: Caller = Depends(current_caller),
                    db: Session = Depends(get_db)) -> Response:
    _limit((si.per_user_action, str(caller.id)))
    current = db.execute(text("select password_hash from local_credentials where user_id = :u"), {"u": caller.id}).scalar()
    if not si.password_matches(current, body.current_password):
        raise HTTPException(401, "invalid_credentials")
    db.execute(text("update local_credentials set password_hash = :h, updated_at = now() where user_id = :u"),
               {"h": si.hash_password(body.new_password), "u": caller.id})
    db.execute(text("delete from sessions where user_id = :u and token_sha256 <> :h"),
               {"u": caller.id, "h": caller.token_sha256})
    db.commit()
    return Response(status_code=204)


class Reset(BaseModel):
    token: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
    new_password: Password


@router.post("/auth/reset")
def reset_password(body: Reset, request: Request, db: Session = Depends(get_public_db)) -> Token:
    """use_password_reset also turns two-factor off and ends every session."""
    _limit((si.per_ip, f"reset:{_client_ip(request)}"))
    user_id = db.execute(text("select use_password_reset(:h)"), {"h": si.token_hash(body.token)}).scalar()
    db.commit()
    with user_session(user_id) as s:
        s.execute(text("update local_credentials set password_hash = :h, updated_at = now() where user_id = :u"),
                  {"h": si.hash_password(body.new_password), "u": user_id})
    return _start_session(user_id, _device(request))


class TwoFactor(BaseModel):
    enabled: bool
    recovery_codes_left: int


@router.get("/auth/two-factor")
def two_factor(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> TwoFactor:
    secret = db.execute(text("select totp_secret from local_credentials where user_id = :u"), {"u": caller.id}).scalar()
    left = db.execute(text("select count(*) from recovery_codes where user_id = :u and used_at is null"),
                      {"u": caller.id}).scalar()
    return TwoFactor(enabled=bool(secret), recovery_codes_left=left)


class TwoFactorSetup(BaseModel):
    secret: str
    uri: str            # otpauth://
    qr: str             # the same, as a QR code (data URI)


@router.post("/auth/two-factor/setup")
def two_factor_setup(db: Session = Depends(get_db)) -> TwoFactorSetup:
    """A new secret to show; nothing is saved until /enable gets a code from it."""
    username = db.execute(text("select username from my_profile()")).scalar() or "msaving"
    server = db.execute(text("select name from instance_info()")).scalar() or "MSaving"
    secret = si.new_totp_secret()
    uri = si.totp_uri(secret, username, server)
    return TwoFactorSetup(secret=secret, uri=uri, qr=si.qr_svg(uri))


class RecoveryCodes(BaseModel):
    recovery_codes: list[str]       # shown once; each works once instead of the authenticator code


def _new_recovery_codes(db: Session, user_id: uuid.UUID) -> RecoveryCodes:
    db.execute(text("delete from recovery_codes where user_id = :u"), {"u": user_id})
    codes = [si.new_code() for _ in range(RECOVERY_CODES)]
    db.execute(text("insert into recovery_codes (user_id, code_sha256) values (:u, :h)"),
               [{"u": user_id, "h": h} for _, h in codes])
    return RecoveryCodes(recovery_codes=[c for c, _ in codes])


class Enable(BaseModel):
    secret: Annotated[str, StringConstraints(pattern=r"^[A-Z2-7]{32}$")]
    code: Code


@router.post("/auth/two-factor/enable")
def two_factor_enable(body: Enable, caller: Caller = Depends(current_caller),
                      db: Session = Depends(get_db)) -> RecoveryCodes:
    _limit((si.per_user_action, str(caller.id)))
    if not si.totp_matches(body.secret, body.code):
        raise HTTPException(422, "invalid_code")
    db.execute(text("update local_credentials set totp_secret = :s, updated_at = now() where user_id = :u"),
               {"s": body.secret, "u": caller.id})
    codes = _new_recovery_codes(db, caller.id)
    db.commit()
    return codes


class CurrentCode(BaseModel):
    code: Code


def _check_current_code(db: Session, caller: Caller, code: str) -> bool:
    """False when two-factor is off; raises for a wrong code."""
    _limit((si.per_user_action, str(caller.id)))
    secret = db.execute(text("select totp_secret from local_credentials where user_id = :u"), {"u": caller.id}).scalar()
    if not secret:
        return False
    if not si.totp_matches(secret, code):
        raise HTTPException(422, "invalid_code")
    return True


@router.post("/auth/two-factor/recovery-codes")
def two_factor_new_recovery_codes(body: CurrentCode, caller: Caller = Depends(current_caller),
                                  db: Session = Depends(get_db)) -> RecoveryCodes:
    if not _check_current_code(db, caller, body.code):
        raise HTTPException(409, "two_factor_off")
    codes = _new_recovery_codes(db, caller.id)
    db.commit()
    return codes


@router.post("/auth/two-factor/disable", status_code=204)
def two_factor_disable(body: CurrentCode, caller: Caller = Depends(current_caller),
                       db: Session = Depends(get_db)) -> Response:
    """Needs a current code, so a session left open somewhere can't turn it off."""
    if _check_current_code(db, caller, body.code):
        db.execute(text("update local_credentials set totp_secret = null, updated_at = now() where user_id = :u"),
                   {"u": caller.id})
        db.execute(text("delete from recovery_codes where user_id = :u"), {"u": caller.id})
        db.commit()
    return Response(status_code=204)
