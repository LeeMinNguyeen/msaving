"""Daily job: market exchange rates into fx_rates, as fx_login, which can write fx_rates and read no user data.

Sources, all USD-based like fx_rates:
- open.er-api.com, no key. Its terms allow caching, forbid passing the data on (each server fetches its own; the
  project ships none) and require the credit "Rates By Exchange Rate API", which the dashboard shows.
- If that fails or announces its end (time_eol_unix): fawazahmed0's currency-api, public domain (CC0), from
  jsDelivr with Cloudflare Pages as its fallback.
- With OXR_APP_ID: Open Exchange Rates, on the operator's own key.
"""
import json
import os
import ssl
import sys
import urllib.request
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import create_engine, text

OXR_URL = "https://openexchangerates.org/api/latest.json?app_id={app_id}"
OPEN_URL = "https://open.er-api.com/v6/latest/USD"
CC0_URLS = ("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
            "https://latest.currency-api.pages.dev/v1/currencies/usd.json")


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "MSaving (self-hosted)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp, parse_float=Decimal)


UNTRUSTED = "certificate not trusted"


def why(exc: Exception) -> str:
    """A short reason a source failed (urllib wraps the real cause)."""
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return f"{UNTRUSTED} ({reason.verify_message})"
    if isinstance(reason, TimeoutError):
        return "no answer in time"
    return str(reason)


class NoRates(Exception):
    """No source answered; the message says why, for the last line of the job's output."""


def fetch_rates() -> tuple[date, dict[str, Decimal], str]:
    """Returns (as_of, {currency: units per 1 USD}, source); NoRates when no source answered."""
    if os.environ.get("OXR_APP_ID"):
        try:
            body = _get(OXR_URL.format(app_id=os.environ["OXR_APP_ID"]))
        except Exception as exc:
            raise NoRates(_summary({"openexchangerates.org": why(exc)})) from None
        if body.get("base") != "USD":
            raise ValueError(f"expected USD base, got {body.get('base')}")
        return datetime.fromtimestamp(body["timestamp"], tz=timezone.utc).date(), body["rates"], "openexchangerates"
    failures = {}
    try:
        return _open_er_api()
    except Exception as exc:
        failures["open.er-api.com"] = why(exc)
        print(f"open.er-api.com: {failures['open.er-api.com']}; trying currency-api", flush=True)
    for url in CC0_URLS:
        try:
            return _currency_api(url)
        except Exception as exc:
            failures[url.split("/")[2]] = why(exc)
            print(f"{url.split('/')[2]}: {failures[url.split('/')[2]]}", flush=True)
    raise NoRates(_summary(failures))


def _summary(failures: dict[str, str]) -> str:
    if all(reason.startswith(UNTRUSTED) for reason in failures.values()):
        return ("no source's HTTPS certificate was trusted: something on this network replaces them (antivirus HTTPS"
                " scanning, a company proxy or firewall). See Troubleshooting, \"Exchange rates don't update\".")
    return "no source answered: " + "; ".join(f"{host}: {reason}" for host, reason in failures.items())


def _open_er_api() -> tuple[date, dict[str, Decimal], str]:
    body = _get(OPEN_URL)
    if body.get("result") != "success" or body.get("base_code") != "USD":
        raise ValueError(f"unexpected answer: {body.get('result')}, {body.get('base_code')}")
    if body.get("time_eol_unix"):
        raise ValueError(f"the open endpoint is ending ({body.get('time_eol_unix')})")
    as_of = datetime.fromtimestamp(body["time_last_update_unix"], tz=timezone.utc).date()
    return as_of, {k: Decimal(str(v)) for k, v in body["rates"].items()}, "open.er-api.com"


def _currency_api(url: str) -> tuple[date, dict[str, Decimal], str]:
    body = _get(url)
    rates = body["usd"]
    return date.fromisoformat(body["date"]), {k.upper(): Decimal(str(v)) for k, v in rates.items()}, "currency-api"


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


def main() -> int:
    engine = create_engine(os.environ["FX_DATABASE_URL"])
    try:
        as_of, rates, source = fetch_rates()
    except NoRates as exc:
        print(f"rates failed: {exc}", flush=True)
        return 1
    n = store_rates(engine, as_of, rates, source)
    print(f"stored {n} rates for {as_of}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
