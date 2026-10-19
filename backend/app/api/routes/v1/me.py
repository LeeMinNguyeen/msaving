from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.models import Timezone
from app.core.auth import Caller, current_caller
from app.core.events import account_event
from app.domain.export import build_export

router = APIRouter()


class Profile(BaseModel):
    username: str
    display_name: str | None
    email: str
    timezone: str
    language: str
    created_at: datetime
    deletion_requested_at: datetime | None
    plan: str


class Me(BaseModel):
    id: UUID
    # None until the user picks a username and agrees to the privacy policy
    # (Choose username screen), which is when the account is created.
    profile: Profile | None
    # The privacy policy in force hasn't been agreed to: the app shows only
    # the updated policy (screen 11) until the user agrees or withdraws.
    needs_consent: bool = False


def _me(db: Session, user_id: UUID) -> Me:
    row = db.execute(text("select * from my_profile()")).mappings().first()
    if row is None:
        return Me(id=user_id, profile=None)
    needs = db.execute(text("select needs_consent from my_consent_status()")).scalar()
    return Me(id=user_id, profile=Profile(**row), needs_consent=bool(needs))


@router.get("/me")
def me(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Me:
    return _me(db, caller.id)


class CreateProfile(BaseModel):
    # Stored lowercase, so "Nguyin" and "nguyin" can't both exist; the database
    # checks the format (letters, digits, _ and ., 3 to 30, starting with a letter or digit).
    username: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=30)]
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = None
    language: Literal["vi", "en"] = "vi"
    timezone: Timezone = "UTC"
    # The privacy policy version the screen showed and the user ticked. The
    # database accepts only the version in force.
    policy_version: str


@router.post("/me", status_code=201)
def create_profile(body: CreateProfile, caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Me:
    """Choose username: creates the account and records consent, together."""
    if not caller.email:
        raise HTTPException(422, "email_missing")
    db.execute(
        text("with u as (insert into users (id, username, display_name, email, timezone, language)"
             "           values (:i, :u, :d, :e, :tz, :l) returning id)"
             " insert into consents (user_id, purpose, policy_version) select id, 'use_app', :v from u"),
        {"i": caller.id, "u": body.username, "d": body.display_name or None, "e": caller.email,
         "tz": body.timezone, "l": body.language, "v": body.policy_version},
    )
    db.commit()
    return _me(db, caller.id)


# ---------------------------------------------------------------- profile (screen 10)

class UpdateProfile(BaseModel):
    username: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=30)] | None = None
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = None   # "" clears it
    language: Literal["vi", "en"] | None = None
    timezone: Timezone | None = None


@router.patch("/me")
def update_profile(body: UpdateProfile, caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> Me:
    """Last write wins (msaving-docs, Several devices at once)."""
    n = db.execute(text(
        "update users set username = coalesce(:u, username),"
        " display_name = case when cast(:d as text) is null then display_name when cast(:d as text) = '' then null"
        "                     else cast(:d as text) end,"
        " language = coalesce(:l, language), timezone = coalesce(:tz, timezone)"
        " where id = :i"), {"i": caller.id, "u": body.username, "d": body.display_name, "l": body.language,
                            "tz": body.timezone}).rowcount
    if n == 0:
        raise HTTPException(404, "not_found")
    db.commit()
    return _me(db, caller.id)


class AccountStatus(BaseModel):
    deletion_requested_at: datetime | None   # set = closed, restorable until deletes_on
    deletes_on: datetime | None


@router.get("/me/status")
def account_status(db: Session = Depends(get_db)) -> AccountStatus:
    row = db.execute(text("select * from my_account_status()")).mappings().first()
    return AccountStatus(**row) if row else AccountStatus(deletion_requested_at=None, deletes_on=None)


# ---------------------------------------------------------------- privacy policy consent (screens 10, 11)

class ConsentStatus(BaseModel):
    current_version: str | None
    current_path: str | None
    agreed_version: str | None
    agreed_at: datetime | None
    needs_consent: bool        # true: show only the updated policy (screen 11) until agreed or withdrawn


@router.get("/me/consent")
def consent_status(db: Session = Depends(get_db)) -> ConsentStatus:
    row = db.execute(text("select * from my_consent_status()")).mappings().one()
    return ConsentStatus(**row)


class Agree(BaseModel):
    policy_version: str        # the version the screen showed; must be the one in force


@router.post("/me/consent")
def agree(body: Agree, caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> ConsentStatus:
    db.execute(text("insert into consents (user_id, purpose, policy_version) values (:u, 'use_app', :v)"
                    " on conflict do nothing"), {"u": caller.id, "v": body.policy_version})
    db.commit()
    return consent_status(db)


@router.post("/me/consent/withdraw")
def withdraw(caller: Caller = Depends(current_caller), db: Session = Depends(get_db)) -> AccountStatus:
    """Withdrawing closes the account, the same as deleting it: restorable for
    30 days after agreeing to the policy in force again, then purged."""
    n = db.execute(text("select withdraw_consent('use_app')")).scalar()
    db.commit()
    if n:
        account_event("consent_withdrawn", caller.id)
        account_event("account_closed", caller.id)
    return account_status(db)


# ---------------------------------------------------------------- closing and restoring (screens 10, 12)

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
    """Within 30 days. If consent was withdrawn or a new policy was published
    meanwhile, the user agrees to the policy in force first (consent_outdated)."""
    restored = db.execute(text("select restore_account()")).scalar()
    db.commit()
    if restored:
        account_event("account_restored", caller.id)
        return account_status(db)
    if db.execute(text("select needs_consent from my_consent_status()")).scalar():
        raise HTTPException(403, "consent_outdated")
    raise HTTPException(409, "not_restorable")


# ---------------------------------------------------------------- export (screen 10)

@router.get("/me/export")
def export(db: Session = Depends(get_db)) -> Response:
    """A ZIP of readable CSV files, in the user's language."""
    body = build_export(db)
    name = f"msaving-export-{datetime.now(timezone.utc).date().isoformat()}.zip"
    return Response(body, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})
