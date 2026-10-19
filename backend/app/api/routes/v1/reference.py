"""Shared reference data: currencies and the privacy policy in force."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db, get_public_db

router = APIRouter()


class Currency(BaseModel):
    code: str
    minor_unit: int        # decimals: VND 0, USD 2, KWD 3
    name: str              # English; the apps show a translated name


@router.get("/currencies")
def currencies(db: Session = Depends(get_db)) -> list[Currency]:
    rows = db.execute(text("select code, minor_unit, name from currencies order by code")).mappings()
    return [Currency(**r) for r in rows]


class Policy(BaseModel):
    version: str
    path: str              # on the landing site: SITE_URL + path


@router.get("/policy")
def policy(db: Session = Depends(get_public_db)) -> Policy:
    """No sign-in needed: the sign-up screen links the exact version."""
    row = db.execute(text("select version, path from policy_versions where version = current_policy_version()")).mappings().first()
    if row is None:        # production before its first policy migration: sign-up can't work
        raise HTTPException(503, "no_policy")
    return Policy(**row)
