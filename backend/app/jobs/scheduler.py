"""The daily jobs, started by app/launch.py next to the API.

Once a day at JOBS_HOUR (UTC, default 19 = 02:00 in Vietnam), in this order:
    1. account_deletion: purge accounts closed more than 30 days ago, and
       expired sessions;
    2. backup: one pg_dump into BACKUP_DIR, keeping about 6 days;
    3. fx_update: exchange rates (no key needed; OXR_APP_ID to use Open
       Exchange Rates instead).
Each job runs as its own process, so one failing doesn't stop the others; the
failure is printed (docker compose logs msaving). Also runs once at start.
"""
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

JOBS = ["account_deletion", "backup", "fx_update"]


def run_all() -> None:
    for job in JOBS:
        code = subprocess.call([sys.executable, "-m", f"app.jobs.{job}"])
        print(f"{job}: {'done' if code == 0 else f'FAILED (exit code {code})'}", flush=True)


def next_run(now: datetime, hour: int) -> datetime:
    at = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


def main() -> None:
    hour = int(os.environ.get("JOBS_HOUR", "19"))
    run_all()
    while True:
        at = next_run(datetime.now(timezone.utc), hour)
        print(f"next run {at.isoformat()}", flush=True)
        time.sleep(max(0.0, (at - datetime.now(timezone.utc)).total_seconds()))
        run_all()


if __name__ == "__main__":
    main()
