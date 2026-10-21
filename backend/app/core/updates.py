"""The newest release comes from the project's GitHub releases, checked at most every 6 hours and only when the
admin opens Server admin.

One-click updates go through the `updater` helper (COMPOSE_PROFILES=updater), the only container that can reach Docker
and the checkout. This server leaves a request file in the shared /updates folder; the helper pulls, rebuilds and
restarts. Between updates it touches /updates/updater_alive every few seconds; during one it doesn't, so a recent
"running" status counts as alive too.
"""
import json
import os
import re
import time
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

UPDATES = Path(os.environ.get("UPDATES_DIR", "/updates"))
REPO = os.environ.get("UPDATE_REPO", "LeeMinNguyeen/msaving")
CHECK_EVERY = 6 * 3600
ALIVE_WITHIN = 30          # seconds since the helper's last heartbeat
# When this server started: set by app/launch.py before the backup and migrations, so it's the container's start.
STARTED = float(os.environ.get("SERVER_STARTED_AT") or time.time())
GRACE = 60                 # seconds: after an update the helper writes "done" just as the new server starts
UPDATE_TAKES = 30 * 60     # seconds: the longest a one-click update is taken to run

_cache: tuple[float, "Release | None"] = (0.0, None)


def current_version() -> str:
    """The VERSION file this server was built from: /srv/VERSION in the image,
    the repository root when run from source. 'dev' if there's none."""
    here = Path(__file__).resolve().parents
    for path in (here[2] / "VERSION", here[3] / "VERSION"):
        try:
            return path.read_text().strip() or "dev"
        except OSError:
            continue
    return "dev"


@dataclass(frozen=True)
class Release:
    version: str
    url: str


def _parse(version: str) -> tuple[int, ...] | None:
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version.strip())
    return tuple(int(x) for x in m.groups()) if m else None


def newer(latest: str, current: str) -> bool:
    """False for a development build (current isn't a version number)."""
    a, b = _parse(latest), _parse(current)
    return a is not None and b is not None and a > b


def latest_release(fetch=None) -> Release | None:
    """The newest published release, or None if unknown (off, offline, none yet)."""
    global _cache
    if os.environ.get("UPDATE_CHECK", "on").lower() in ("off", "false", "0"):
        return None
    checked, release = _cache
    if time.monotonic() - checked < CHECK_EVERY and checked:
        return release
    try:
        body = (fetch or _github)(f"https://api.github.com/repos/{REPO}/releases/latest")
        release = Release(version=body["tag_name"].lstrip("v"), url=body["html_url"])
    except Exception:
        release = None
    _cache = (time.monotonic(), release)
    return release


def _github(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "MSaving"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)


def _status_line() -> tuple[str, float | None] | None:
    """The helper's status line, and the time written in it."""
    try:
        line = (UPDATES / "status").read_text().strip()
    except OSError:
        return None
    if not line:
        return None
    m = re.match(r"\w+ (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)", line)
    return line, datetime.strptime(m[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC).timestamp() if m else None


def updater_running() -> bool:
    try:
        if time.time() - (UPDATES / "updater_alive").stat().st_mtime < ALIVE_WITHIN:
            return True
    except OSError:
        pass
    found = _status_line()
    return bool(found and found[0].startswith("running ") and found[1] and time.time() - found[1] < UPDATE_TAKES)


def status() -> str | None:
    """The helper's last result: 'running <time>', 'done <time>' or 'failed <time>: <why>'. None when it's from
    before this server started: then an update by hand or a restart came since, and an old failure would show
    for ever (the folder outlives the containers)."""
    found = _status_line()
    if not found or (found[1] is not None and found[1] < STARTED - GRACE):
        return None
    return found[0]


def changelog_url() -> str | None:
    site = os.environ.get("PROJECT_SITE_URL", "").strip().rstrip("/")
    return f"{site}/docs/changelog/" if site else None


def request_update() -> None:
    (UPDATES / "requested").write_text(str(int(time.time())))
