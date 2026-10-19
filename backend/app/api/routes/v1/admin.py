"""The server's admin: invites, users, password reset links, the server's
name and whether sign-up is open (msaving-docs, Accounts on an instance).
Every database function behind these checks the caller is the admin
(403 admin_only otherwise).

Codes and tokens are returned once, here; the database keeps only their
SHA-256. Clients build the links from the address they reach the server at:
    invite  https://<server>/join?code=<code>  (QR: msaving://join?server=<server>&code=<code>)
    reset   https://<server>/reset?token=<token>
"""
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core import sign_in as si

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
    """Disabled: can't sign in, and is signed out everywhere at once. Their
    data and shared books stay; enabling again gives everything back."""
    db.execute(text("select admin_set_disabled(:u, :d)"), {"u": user_id, "d": body.disabled})
    db.commit()
    return Response(status_code=204)


class ResetLink(BaseModel):
    token: str
    expires_at: datetime


@router.post("/users/{user_id}/reset")
def reset_link(user_id: UUID, db: Session = Depends(get_db)) -> ResetLink:
    """A one-time link for someone who forgot their password. Using it also
    turns their two-factor off. Give it to them yourself; it lasts 24 hours."""
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
    # The address the admin reaches this server at (the web app sends its own
    # origin). Given: the answer includes the join link and its QR code.
    server: Annotated[str, StringConstraints(pattern=r"^https?://[^/\s?#]+$", max_length=200)] | None = None


class CreatedInvite(BaseModel):
    id: UUID
    code: str               # shown once
    expires_at: datetime
    link: str | None        # https://<server>/join?code=<code>
    qr: str | None          # the link as a QR code image (data URI), for a phone's camera or the app


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
