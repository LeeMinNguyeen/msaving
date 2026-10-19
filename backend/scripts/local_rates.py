"""Exchange rates for the LOCAL Supabase stack only.

With OXR_APP_ID set, runs the real daily job (app/jobs/fx_update.py) against
the local database. Without it, stores made-up rates for today and the last
90 days, rounded and roughly right, so conversions show up while developing.
Never point it at a hosted database.

    python scripts/local_rates.py
"""
import os
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import create_engine  # noqa: E402

from app.jobs import fx_update  # noqa: E402

URL = os.environ.get("LOCAL_FX_DATABASE_URL",
                     "postgresql+psycopg://fx_login:local-only-password@127.0.0.1:54322/postgres?sslmode=disable")
# Units per 1 USD. Made up for local development, not market data.
SAMPLE = {"VND": "26000", "EUR": "0.92", "GBP": "0.78", "JPY": "150", "SGD": "1.33", "AUD": "1.52",
          "CAD": "1.37", "THB": "36", "KRW": "1380", "CNY": "7.2", "KWD": "0.31"}

if not any(h in URL for h in ("127.0.0.1", "localhost")):
    sys.exit(f"refusing: {URL} is not local")
engine = create_engine(URL)
if os.environ.get("OXR_APP_ID"):
    as_of, rates = fx_update.fetch_rates()
    print(f"stored {fx_update.store_rates(engine, as_of, rates, 'openexchangerates')} real rates for {as_of}")
else:
    today = date.today()
    for back in range(0, 91):
        fx_update.store_rates(engine, today - timedelta(days=back), {k: Decimal(v) for k, v in SAMPLE.items()}, "local-sample")
    print(f"stored made-up rates for {len(SAMPLE)} currencies, {today - timedelta(days=90)} to {today}")
