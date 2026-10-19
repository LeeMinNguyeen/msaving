"""Shared request field types."""
from functools import lru_cache
from importlib.resources import files
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator, StringConstraints
from sqlalchemy import text


@lru_cache(maxsize=1)
def _database_zones() -> frozenset[str]:
    """The names the database accepts. Its timezone data may leave out old
    aliases (the official postgres image has no Asia/Saigon, which Windows
    browsers report), so names are checked against it, not only Python's."""
    from app.core.db import SessionLocal
    with SessionLocal() as s:
        return frozenset(r[0] for r in s.execute(text("select name from pg_timezone_names")))


def _zone_file(name: str) -> bytes:
    return files("tzdata.zoneinfo").joinpath(name).read_bytes()


@lru_cache(maxsize=1)
def _database_zone_by_rules() -> dict[bytes, str]:
    by_rules: dict[bytes, str] = {}
    for name in sorted(_database_zones()):
        try:
            by_rules.setdefault(_zone_file(name), name)
        except (FileNotFoundError, IsADirectoryError, ValueError):
            pass                      # a name only the database has (posix/..., abbreviations)
    return by_rules


def canonical_timezone(name: str) -> str:
    """The name itself if the database knows it, else the zone the database
    knows with exactly the same rules (Asia/Saigon -> Asia/Ho_Chi_Minh)."""
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("unknown timezone") from None
    if name in _database_zones():
        return name
    try:
        same = _database_zone_by_rules().get(_zone_file(name))
    except (FileNotFoundError, IsADirectoryError, ValueError):
        same = None
    if same is None:
        raise ValueError("unknown timezone")
    return same


def _timezone(name: str) -> str:
    return canonical_timezone(name)


Timezone = Annotated[str, AfterValidator(_timezone)]          # IANA name, e.g. Asia/Ho_Chi_Minh; aliases become the canonical name
CurrencyCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
