"""Daily job: pull market exchange rates into fx_rates.

Run once a day by the scheduler with FX_DATABASE_URL pointing at fx_login, a
member of fx_updater. That role can only write fx_rates; it can't read any
user data.

Providers (msaving-docs, Exchange rates), both USD-based like fx_rates:
- Default, no key: open.er-api.com (ExchangeRate-API's open endpoint), daily,
  about 160 currencies including VND. Its terms are not checked yet
  (msaving-docs, Open questions).
- With OXR_APP_ID set: Open Exchange Rates, on the operator's own key.
The provider is behind fetch_rates(), so adding one means changing only that.
"""
import json
import os
import urllib.request
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import create_engine, text

OXR_URL = "https://openexchangerates.org/api/latest.json?app_id={app_id}"
OPEN_URL = "https://open.er-api.com/v6/latest/USD"


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "MSaving (self-hosted)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp, parse_float=Decimal)


def fetch_rates() -> tuple[date, dict[str, Decimal], str]:
    """Returns (as_of, {currency: units per 1 USD}, source)."""
    if os.environ.get("OXR_APP_ID"):
        body = _get(OXR_URL.format(app_id=os.environ["OXR_APP_ID"]))
        if body.get("base") != "USD":
            raise ValueError(f"expected USD base, got {body.get('base')}")
        return datetime.fromtimestamp(body["timestamp"], tz=timezone.utc).date(), body["rates"], "openexchangerates"
    body = _get(OPEN_URL)
    if body.get("result") != "success" or body.get("base_code") != "USD":
        raise ValueError(f"unexpected answer from open.er-api.com: {body.get('result')}, {body.get('base_code')}")
    as_of = datetime.fromtimestamp(body["time_last_update_unix"], tz=timezone.utc).date()
    return as_of, {k: Decimal(str(v)) for k, v in body["rates"].items()}, "open.er-api.com"


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
    as_of, rates, source = fetch_rates()
    n = store_rates(engine, as_of, rates, source)
    print(f"stored {n} rates for {as_of}")


if __name__ == "__main__":
    main()
