"""The server admin's routes. Every database function behind them checks that the caller is the admin
(403 admin_only otherwise).

Codes and tokens are returned once, here; the database keeps only their SHA-256. Clients build the links from the
address they reach the server at:
    invite  https://<server>/join?code=<code>  (QR: waterflow://join?server=<server>&code=<code>)
    reset   https://<server>/reset?token=<token>
"""
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.models import Timezone
from app.core import jobs as schedule
from app.core import sign_in as si
from app.core import updates

router = APIRouter(prefix="/admin")

RESET_HOURS = 24


class User(BaseModel):
    id: UUID
    username: str
    display_name: str | None
    is_admin: bool
    created_at: datetime
    disabled_at: datetime | None
    deletion_requested_at: datetime | None
    last_seen_at: datetime | None
    two_factor: bool


@router.get("/users")
def users(db: Session = Depends(get_db)) -> list[User]:
    return [User(**r) for r in db.execute(text("select * from admin_users()")).mappings()]


class Disable(BaseModel):
    disabled: bool


@router.post("/users/{user_id}/disable", status_code=204)
def disable(user_id: UUID, body: Disable, db: Session = Depends(get_db)) -> Response:
    db.execute(text("select admin_set_disabled(:u, :d)"), {"u": user_id, "d": body.disabled})
    db.commit()
    return Response(status_code=204)


class ResetLink(BaseModel):
    token: str
    expires_at: datetime


@router.post("/users/{user_id}/reset")
def reset_link(user_id: UUID, db: Session = Depends(get_db)) -> ResetLink:
    token, digest = si.new_token()
    expires = datetime.now(timezone.utc) + timedelta(hours=RESET_HOURS)
    db.execute(text("select admin_create_password_reset(:u, :h, :e)"), {"u": user_id, "h": digest, "e": expires})
    db.commit()
    return ResetLink(token=token, expires_at=expires)


class Invite(BaseModel):
    id: UUID
    note: str | None
    created_at: datetime
    expires_at: datetime
    used_by_username: str | None
    used_at: datetime | None
    revoked_at: datetime | None


@router.get("/invites")
def invites(db: Session = Depends(get_db)) -> list[Invite]:
    return [Invite(**r) for r in db.execute(text("select * from admin_invites()")).mappings()]


class NewInvite(BaseModel):
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = None
    days: int = Field(7, ge=1, le=30)
    # The address the admin reaches this server at (the web app sends its origin): the answer then has the link.
    server: Annotated[str, StringConstraints(pattern=r"^https?://[^/\s?#]+$", max_length=200)] | None = None


class CreatedInvite(BaseModel):
    id: UUID
    code: str               # shown once
    expires_at: datetime
    link: str | None
    qr: str | None          # the link as a QR code (data URI)


@router.post("/invites", status_code=201)
def create_invite(body: NewInvite, db: Session = Depends(get_db)) -> CreatedInvite:
    code, digest = si.new_code()
    expires = datetime.now(timezone.utc) + timedelta(days=body.days)
    invite_id = db.execute(text("select admin_create_invite(:h, :e, :n)"),
                           {"h": digest, "e": expires, "n": body.note or None}).scalar()
    db.commit()
    link = f"{body.server}/join?code={code}" if body.server else None
    return CreatedInvite(id=invite_id, code=code, expires_at=expires, link=link, qr=si.qr_svg(link) if link else None)


@router.delete("/invites/{invite_id}", status_code=204)
def revoke_invite(invite_id: UUID, db: Session = Depends(get_db)) -> Response:
    db.execute(text("select admin_revoke_invite(:i)"), {"i": invite_id})
    db.commit()
    return Response(status_code=204)


class InstanceChange(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] | None = None
    signup: Literal["invite", "open"] | None = None


@router.patch("/instance", status_code=204)
def change_instance(body: InstanceChange, db: Session = Depends(get_db)) -> Response:
    db.execute(text("select admin_set_instance(:n, :s)"), {"n": body.name, "s": body.signup})
    db.commit()
    return Response(status_code=204)


class Job(BaseModel):
    name: Literal["purge", "backup", "rates"]
    at_minute: int | None               # its time of day, minutes after midnight in `timezone`; None: JOBS_HOUR (UTC)
    timezone: str | None
    default_minute: int                 # JOBS_HOUR as minutes after midnight UTC
    enabled: bool
    next_run_at: datetime               # also while it's off
    last_started_at: datetime | None
    last_finished_at: datetime | None   # still running while this is before last_started_at, or missing
    last_result: Literal["done", "failed"] | None
    last_detail: str | None             # its last line of output


def _jobs(db: Session) -> dict[str, dict]:
    return {r["name"]: dict(r) for r in db.execute(text("select * from admin_jobs()")).mappings()}


@router.get("/jobs")
def jobs(db: Session = Depends(get_db)) -> list[Job]:
    """In the order they run."""
    now = datetime.now(timezone.utc)
    return [Job(**{k: v for k, v in j.items() if k != "changed_at"}, default_minute=schedule.default_minute(),
                next_run_at=schedule.next_time(now, j["at_minute"], j["timezone"])) for j in _jobs(db).values()]


class JobChange(BaseModel):
    """What's left out stays. A time of day comes with its timezone; null for both goes back to JOBS_HOUR."""
    at_minute: Annotated[int, Field(ge=0, le=1439)] | None = None
    timezone: Timezone | None = None
    enabled: bool | None = None


@router.patch("/jobs/{name}", status_code=204)
def change_job(name: str, body: JobChange, db: Session = Depends(get_db)) -> Response:
    """The database refuses to turn off any job but the exchange rates: a server can't do without backups or the
    purge."""
    job = _jobs(db).get(name)
    if job is None:
        raise HTTPException(404, "not_found")
    at, zone = job["at_minute"], job["timezone"]
    if "at_minute" in body.model_fields_set:
        if body.at_minute is not None and body.timezone is None:
            raise HTTPException(422, "invalid")
        at, zone = body.at_minute, body.timezone if body.at_minute is not None else None
    enabled = job["enabled"] if body.enabled is None else body.enabled
    db.execute(text("select admin_set_job(:n, :a, :z, :e)"), {"n": name, "a": at, "z": zone, "e": enabled})
    db.commit()
    return Response(status_code=204)


class UpdateInfo(BaseModel):
    current_version: str
    latest_version: str | None        # None: unknown (checking is off, offline, or no release yet)
    release_url: str | None
    changelog_url: str | None         # the project's changelog (PROJECT_SITE_URL); None: unset
    update_available: bool
    updater: bool                     # the one-click helper is running (COMPOSE_PROFILES=updater)
    status: str | None                # the helper's last run: running / done / failed, with the time


def _require_admin(db: Session) -> None:
    db.execute(text("select require_admin()"))


@router.get("/update")
def update_info(db: Session = Depends(get_db)) -> UpdateInfo:
    _require_admin(db)
    current = updates.current_version()
    latest = updates.latest_release()
    return UpdateInfo(
        current_version=current, latest_version=latest.version if latest else None,
        release_url=latest.url if latest else None, changelog_url=updates.changelog_url(),
        update_available=bool(latest and updates.newer(latest.version, current)),
        updater=updates.updater_running(), status=updates.status())


@router.post("/update", status_code=202)
def start_update(db: Session = Depends(get_db)) -> Response:
    """The helper pulls the newest release, rebuilds and restarts the server."""
    _require_admin(db)
    if not updates.updater_running():
        raise HTTPException(409, "updater_off")
    updates.request_update()
    return Response(status_code=202)
