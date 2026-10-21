from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.models import Timezone
from app.core import sign_in as si
from app.core.auth import Caller, current_caller
from app.core.events import account_event
from app.domain.export import build_export

router = APIRouter()


class Profile(BaseModel):
    username: str
    display_name: str | None
    timezone: str
    language: str
    created_at: datetime
    deletion_requested_at: datetime | None
    is_admin: bool
    idle_sign_out_minutes: int | None   # signs this user out after this long without activity (msaving#26); 5 by default; None: never


class Me(BaseModel):
    id: UUID
    profile: Profile


def _me(db: Session, user_id: UUID) -> Me:
    row = db.execute(text("select * from my_profile()")).mappings().one()
    return Me(id=user_id, profile=Profile(**row))


@router.get("/me")
def me(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Me:
    return _me(db, caller.id)


# ---------------------------------------------------------------- profile

class UpdateProfile(BaseModel):
    username: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=30)] | None = None
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = None   # "" clears it
    language: Literal["en", "vi"] | None = None
    timezone: Timezone | None = None
    # Sign me out after this many minutes without activity, on every device (msaving#26); null turns it off.
    idle_sign_out_minutes: Annotated[int, Field(ge=1, le=1440)] | None = None


@router.patch("/me")
def update_profile(body: UpdateProfile, caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Me:
    """Last write wins (docs: The ledger, several devices). Trying a new
    username is rate limited (429 rate_limited); saving the same one isn't."""
    if body.username is not None:
        current = db.execute(text("select username from users where id = :i"), {"i": caller.id}).scalar()
        if body.username != current and not si.username_changes.allow(str(caller.id)):
            raise HTTPException(429, "rate_limited")
    n = db.execute(text(
        "update users set username = coalesce(:u, username),"
        " display_name = case when cast(:d as text) is null then display_name when cast(:d as text) = '' then null"
        "                     else cast(:d as text) end,"
        " language = coalesce(:l, language), timezone = coalesce(:tz, timezone)"
        " where id = :i"), {"i": caller.id, "u": body.username, "d": body.display_name, "l": body.language,
                            "tz": body.timezone}).rowcount
    if n == 0:
        raise HTTPException(404, "not_found")
    if "idle_sign_out_minutes" in body.model_fields_set:        # left out leaves it; null turns it off
        db.execute(text("update users set idle_sign_out_minutes = :m where id = :i"),
                   {"m": body.idle_sign_out_minutes, "i": caller.id})
    db.commit()
    return _me(db, caller.id)


class AccountStatus(BaseModel):
    deletion_requested_at: datetime | None   # set = closed, restorable until deletes_on
    deletes_on: datetime | None


@router.get("/me/status")
def account_status(db: Session = Depends(get_db)) -> AccountStatus:
    row = db.execute(text("select * from my_account_status()")).mappings().first()
    return AccountStatus(**row) if row else AccountStatus(deletion_requested_at=None, deletes_on=None)


# ---------------------------------------------------------------- closing and restoring

@router.post("/me/delete")
def close_account(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> AccountStatus:
    """Closes the account now; deleted for good 30 days later by the daily purge."""
    was_open = db.execute(text("select deletion_requested_at is null from my_account_status()")).scalar()
    db.execute(text("select request_account_deletion()"))
    db.commit()
    if was_open:
        account_event("account_closed", caller.id)
    return account_status(db)


@router.post("/me/restore")
def restore(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> AccountStatus:
    """Within 30 days."""
    restored = db.execute(text("select restore_account()")).scalar()
    db.commit()
    if restored:
        account_event("account_restored", caller.id)
        return account_status(db)
    raise HTTPException(409, "not_restorable")


# ---------------------------------------------------------------- export

@router.get("/me/export")
def export(db: Session = Depends(get_db)) -> Response:
    """A ZIP of readable CSV files, in the user's language."""
    body = build_export(db)
    name = f"msaving-export-{datetime.now(timezone.utc).date().isoformat()}.zip"
    return Response(body, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})
