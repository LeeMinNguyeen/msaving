"""How the `msaving` container starts:

    python -m app.launch secrets   first start only: the built-in database's password, before Postgres starts
    python -m app.launch           the server: a backup when an update brings migrations, the migrations and logins,
                                   the setup code, then the API and the scheduler side by side (if either stops,
                                   the container stops and Docker restarts it)
    python -m app.launch jobs      the due jobs, once, for a server with RUN_JOBS=off (Cloud Run); non-zero if one
                                   failed. Needs the server to have started once.

The API gets only its own login, never the owner's password, so even a flaw in the API can't get around row-level
security. The logins' passwords file can be mounted read-only (Cloud Run's Secret Manager): the server then sets
those passwords instead of making new ones.
"""
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import psycopg

from app.jobs import backup, migrate, restore

SECRETS = Path(os.environ.get("SECRETS_DIR", "/secrets"))
POSTGRES_PASSWORD = SECRETS / "postgres_password"
LOGIN_PASSWORDS = SECRETS / "db_logins.json"


def _write_secret(path: Path, value: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w") as f:
        f.write(value)


def make_postgres_password() -> None:
    if not POSTGRES_PASSWORD.exists():
        # Readable by the database container's own user too. The secrets volume
        # is mounted only into the database and this server.
        _write_secret(POSTGRES_PASSWORD, secrets.token_hex(24), 0o644)
        print("made the built-in database's password", flush=True)


def login_passwords() -> dict[str, str]:
    if not LOGIN_PASSWORDS.exists():
        _write_secret(LOGIN_PASSWORDS, json.dumps({login: secrets.token_hex(24) for login in migrate.LOGINS}))
    return json.loads(LOGIN_PASSWORDS.read_text())


def admin_url() -> str:
    own = os.environ.get("ADMIN_DATABASE_URL", "").strip()
    if own:
        return own.replace("postgresql+psycopg://", "postgresql://")
    password = POSTGRES_PASSWORD.read_text().strip()
    return f"postgresql://postgres:{password}@db:5432/postgres?sslmode=disable"


def login_url(admin: str, login: str, password: str, driver: str = "postgresql+psycopg") -> str:
    """The owner's URL with another login: same server, database and options.
    An owner name with a dot is a pooler's (Supabase's shared pooler, Supavisor: postgres.<project ref>), which
    reads the part after the dot as the project: the login gets the same suffix."""
    parts = urlsplit(admin)
    host = parts.hostname or ""
    host = f"[{host}]" if ":" in host else host
    port = f":{parts.port}" if parts.port else ""
    _, dot, project = unquote(parts.username or "").partition(".")
    netloc = f"{quote(login + dot + project, safe='')}:{quote(password, safe='')}@{host}{port}"
    return urlunsplit((driver, netloc, parts.path, parts.query, ""))


def wait_for(url: str, seconds: int = 120) -> None:
    deadline = time.monotonic() + seconds
    while True:
        try:
            psycopg.connect(url, connect_timeout=5).close()
            return
        except psycopg.OperationalError as e:
            if time.monotonic() > deadline:
                raise SystemExit(f"the database isn't reachable: {str(e).splitlines()[0]}") from None
            time.sleep(2)


def print_setup_code(code: str) -> None:
    line = "=" * 64
    print(f"\n{line}\n  This server has no admin yet. Open it in a browser and enter\n"
          f"  this setup code to create the admin account:\n\n      {code}\n\n"
          f"  A new code is printed every time the server starts, until then.\n{line}\n", flush=True)


def _without_owner() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k != "ADMIN_DATABASE_URL"}


def jobs_env(admin: str, passwords: dict[str, str], backup_dir: str) -> dict[str, str]:
    """What the scheduler and its jobs need: their own logins, and the owner's for the backup."""
    return {"PURGE_DATABASE_URL": login_url(admin, "purge_login", passwords["purge_login"]),
            "FX_DATABASE_URL": login_url(admin, "fx_login", passwords["fx_login"]),
            "BACKUP_DATABASE_URL": admin, "BACKUP_DIR": backup_dir,
            "PURGE_LOG": os.environ.get("PURGE_LOG", str(Path(backup_dir) / "purged_accounts.jsonl"))}


def jobs_here() -> bool:
    return os.environ.get("RUN_JOBS", "on").lower() not in ("off", "false", "0")


def run_jobs_once() -> None:
    admin = admin_url()
    passwords = login_passwords()
    wait_for(admin)
    env = {**_without_owner(), **jobs_env(admin, passwords, os.environ.get("BACKUP_DIR", "/backups"))}
    sys.exit(subprocess.run([sys.executable, "-m", "app.jobs.scheduler", "--once"], env=env).returncode)


def serve() -> None:
    started = time.time()              # before the backup and migrations: see app/core/updates.py status()
    admin = admin_url()
    passwords = login_passwords()
    wait_for(admin)
    backup_dir = os.environ.get("BACKUP_DIR", "/backups")

    def backup_first():
        path, _, _ = backup.run_backup(admin, backup_dir)
        print(f"before updating: backed up to {path}", flush=True)

    restored = restore.restore_if_requested(admin, backup_dir)
    if restored:
        print(f"restore from the web app: {restored}", flush=True)
    applied, setup_code = migrate.run(admin, passwords, before_migrating=backup_first)
    print(f"database ready ({len(applied)} migration(s) applied{': ' + ', '.join(applied) if applied else ''})",
          flush=True)
    if setup_code:
        print_setup_code(setup_code)

    base = {**_without_owner(), "SERVER_STARTED_AT": str(started), "LAUNCHER_PID": str(os.getpid())}
    api_env = {**base, "DATABASE_URL": login_url(admin, "api_login", passwords["api_login"])}
    port = os.environ.get("PORT", "8080")
    reload = ["--reload"] if os.environ.get("DEV_RELOAD") else []        # development only (scripts/dev.sh)
    children = [
        subprocess.Popen([sys.executable, "-m", "uvicorn", "app.api.main:app", "--host", "0.0.0.0", "--port", port,
                          "--proxy-headers", "--forwarded-allow-ips", "*", *reload], env=api_env),
    ]
    if jobs_here():
        children.append(subprocess.Popen([sys.executable, "-m", "app.jobs.scheduler"],
                                         env={**base, **jobs_env(admin, passwords, backup_dir)}))
    else:
        print("RUN_JOBS=off: the daily jobs run elsewhere (python -m app.launch jobs)", flush=True)

    def stop(*_):
        for c in children:
            c.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while all(c.poll() is None for c in children):
        time.sleep(1)
    stop()
    for c in children:
        c.wait(timeout=20)
    sys.exit(next((c.returncode for c in children if c.returncode), 0))


if __name__ == "__main__":
    if sys.argv[1:] == ["secrets"]:
        make_postgres_password()
    elif sys.argv[1:] == ["jobs"]:
        run_jobs_once()
    else:
        serve()
