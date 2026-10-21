from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db

router = APIRouter()


class Currency(BaseModel):
    code: str
    minor_unit: int        # decimals: VND 0, USD 2, KWD 3
    name: str              # English; the apps show a translated name


@router.get("/currencies")
def currencies(db: Session = Depends(get_db)) -> list[Currency]:
    rows = db.execute(text("select code, minor_unit, name from currencies order by code")).mappings()
    return [Currency(**r) for r in rows]

