"""The daily jobs' schedule (msaving#6, docs: Background jobs): when each one
runs, and whether it's due.

Each job runs once a day at its time of day: the one the admin set on Server
admin, in their own timezone (kept with it, so daylight saving time doesn't
move it), or JOBS_HOUR (UTC, default 19 = 02:00 in Vietnam) until then. A job
is due once its time has come since it last started and since its schedule
last changed: a server that was off at that time catches up when it starts, a
new one runs every job at its first start, and moving a time to earlier in
the day doesn't run the job straight away. The scheduler
(app/jobs/scheduler.py) asks every half minute; Server admin shows the next
run.
"""
import os
from collections.abc import Mapping
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

# The jobs and their modules, in the order they run when due together.
JOBS = {"purge": "app.jobs.account_deletion", "backup": "app.jobs.backup", "rates": "app.jobs.fx_update"}


def default_minute() -> int:
    """JOBS_HOUR from .env, as minutes after midnight UTC: when a job runs until the admin sets a time."""
    return int(os.environ.get("JOBS_HOUR", "19")) % 24 * 60


def _time_on(day: date, at_minute: int | None, timezone: str | None) -> datetime:
    minute, zone = (default_minute(), UTC) if at_minute is None else (at_minute, ZoneInfo(timezone))
    return datetime.combine(day, time(minute // 60, minute % 60), tzinfo=zone)


def _today(now: datetime, at_minute: int | None, timezone: str | None) -> date:
    return now.astimezone(UTC if at_minute is None else ZoneInfo(timezone)).date()


def last_time(now: datetime, at_minute: int | None, timezone: str | None) -> datetime:
    """The job's most recent scheduled time, at or before now."""
    day = _today(now, at_minute, timezone)
    at = _time_on(day, at_minute, timezone)
    return at if at <= now else _time_on(day - timedelta(days=1), at_minute, timezone)


def next_time(now: datetime, at_minute: int | None, timezone: str | None) -> datetime:
    """The job's next scheduled time, after now."""
    day = _today(now, at_minute, timezone)
    at = _time_on(day, at_minute, timezone)
    return at if at > now else _time_on(day + timedelta(days=1), at_minute, timezone)


def is_due(now: datetime, job: Mapping) -> bool:
    """A row of job_schedule(): on, and its time has come since it last started and since its schedule changed."""
    if not job["enabled"]:
        return False
    since = max((t for t in (job["last_started_at"], job["changed_at"]) if t is not None), default=None)
    return since is None or last_time(now, job["at_minute"], job["timezone"]) > since
