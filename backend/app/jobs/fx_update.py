"""Daily job: pull market exchange rates into fx_rates.

Run once a day (cron, a scheduled cloud job, or a worker queue) with
FX_DATABASE_URL pointing at a login that is a member of fx_updater. That role
can only write fx_rates; it can't read any user data.

One shared sync for all users: the job fetches every currency once a day
and every book reads from fx_rates, so the cost doesn't grow with users.

Provider: Open Exchange Rates (openexchangerates.org). Widely used, ~170
currencies including VND, USD base (which is how fx_rates stores rates).
One call a day is ~31 calls a month, far inside its smallest plan's quota.
Set OXR_APP_ID. Not run against the live API from here: check the response
format, and the licence terms for commercial use, before launch.
The provider is behind fetch_rates(), so switching means changing only that.
"""
import json
import os
import urllib.request
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import create_engine, text

OXR_URL = "https://openexchangerates.org/api/latest.json?app_id={app_id}"


def fetch_rates() -> tuple[date, dict[str, Decimal]]:
    """Returns (as_of, {currency: units per 1 USD})."""
    with urllib.request.urlopen(OXR_URL.format(app_id=os.environ["OXR_APP_ID"]), timeout=30) as resp:
        body = json.load(resp, parse_float=Decimal)
    if body.get("base") != "USD":
        raise ValueError(f"expected USD base, got {body.get('base')}")
    as_of = datetime.fromtimestamp(body["timestamp"], tz=timezone.utc).date()
    return as_of, body["rates"]


def store_rates(engine, as_of: date, rates: dict[str, Decimal], source: str) -> int:
    """Upserts rates for currencies we know about. Safe to run repeatedly."""
    with engine.begin() as conn:
        known = {r[0] for r in conn.execute(text("select code from currencies"))}
        rows = [{"q": c, "d": as_of, "r": r, "s": source}
                for c, r in rates.items() if c in known and c != "USD" and r > 0]
        if rows:
            conn.execute(
                text("insert into fx_rates (quote, as_of, rate, source) values (:q, :d, :r, :s)"
                     " on conflict (quote, as_of) do update"
                     " set rate = excluded.rate, source = excluded.source, fetched_at = now()"),
                rows,
            )
        return len(rows)


def main() -> None:
    engine = create_engine(os.environ["FX_DATABASE_URL"])
    as_of, rates = fetch_rates()
    n = store_rates(engine, as_of, rates, "openexchangerates")
    print(f"stored {n} rates for {as_of}")


if __name__ == "__main__":
    main()
