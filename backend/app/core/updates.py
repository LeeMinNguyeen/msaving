"""Is there a newer release, and can this server install it by itself?
(docs: Updates)

- The newest release comes from the project's GitHub releases, checked at
  most every 6 hours, only when the admin opens the admin page. UPDATE_CHECK=off
  turns it off. Nothing about the server is sent beyond an ordinary request.
- One-click updates need the operator to turn on the `updater` helper in
  docker-compose.yml (COMPOSE_PROFILES=updater). Only that helper can reach
  Docker; this server only leaves a request file in the shared /updates folder,
  which the helper picks up: pull the new image, restart this container. The
  helper touches /updates/updater_alive every few seconds while it runs.
"""
import json
import os
import re
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

UPDATES = Path(os.environ.get("UPDATES_DIR", "/updates"))
REPO = os.environ.get("UPDATE_REPO", "LeeMinNguyeen/msaving")
CHECK_EVERY = 6 * 3600
ALIVE_WITHIN = 30          # seconds since the helper's last heartbeat

_cache: tuple[float, "Release | None"] = (0.0, None)


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


def updater_running() -> bool:
    try:
        return time.time() - (UPDATES / "updater_alive").stat().st_mtime < ALIVE_WITHIN
    except OSError:
        return False


def status() -> str | None:
    """The helper's last result: 'running ...', 'done ...' or 'failed ...'."""
    try:
        return (UPDATES / "status").read_text().strip() or None
    except OSError:
        return None


def request_update() -> None:
    (UPDATES / "requested").write_text(str(int(time.time())))
