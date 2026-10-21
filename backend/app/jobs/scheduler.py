"""Runs the daily jobs that are due (app/core/jobs.py), each as its own process, so one failing doesn't stop the
others. Logs in as purge_login, which can also read the schedule and record the results.

With --once (`python -m app.launch jobs`) it looks once and exits: on Cloud Run, which pauses the server between
requests, a scheduled task runs it every hour instead.
"""
import os
import subprocess
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from app.core.jobs import JOBS, is_due

TICK = 30   # seconds


def run_job(name: str) -> tuple[bool, str]:
    """Runs one job as its own process: whether it worked, and its last line of output."""
    p = subprocess.run([sys.executable, "-m", JOBS[name]], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = p.stdout.strip()
    if out:
        print(out, flush=True)
    print(f"{name}: {'done' if p.returncode == 0 else f'FAILED (exit code {p.returncode})'}", flush=True)
    return p.returncode == 0, out.splitlines()[-1] if out else ""


def run_due(engine: Engine, now: datetime, run: Callable[[str], tuple[bool, str]] = run_job) -> list[str]:
    """Runs every job that's due now, in order, recording each start and result. Returns their names."""
    with engine.begin() as c:
        schedule = c.execute(text("select * from job_schedule()")).mappings().all()
    ran = []
    for job in schedule:
        if not is_due(now, job):
            continue
        with engine.begin() as c:
            c.execute(text("select job_started(:n)"), {"n": job["name"]})
        done, detail = run(job["name"])
        with engine.begin() as c:
            c.execute(text("select job_finished(:n, :d, :t)"), {"n": job["name"], "d": done, "t": detail})
        ran.append(job["name"])
    return ran


def once(engine: Engine, now: datetime, run: Callable[[str], tuple[bool, str]] = run_job) -> int:
    """One look (--once, for `python -m app.launch jobs`): 1 if a job that was due failed, else 0."""
    failed = []

    def run_and_note(name: str) -> tuple[bool, str]:
        done, detail = run(name)
        if not done:
            failed.append(name)
        return done, detail
    ran = run_due(engine, now, run_and_note)
    print(f"jobs: {', '.join(ran) or 'none due'}", flush=True)
    return 1 if failed else 0


def main() -> None:
    engine = create_engine(os.environ["PURGE_DATABASE_URL"], pool_pre_ping=True)
    if sys.argv[1:] == ["--once"]:
        sys.exit(once(engine, datetime.now(UTC)))
    while True:
        try:
            run_due(engine, datetime.now(UTC))
        except Exception as e:  # noqa: BLE001 - the database restarting, say: one bad look mustn't stop the jobs
            print(f"scheduler: {e}", flush=True)
        time.sleep(TICK)


if __name__ == "__main__":
    main()
