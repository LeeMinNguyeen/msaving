"""How the `msaving` container starts (docker-compose.yml). Everything an
operator would otherwise do by hand:

    python -m app.launch secrets   the `secrets` service, first start only: the
                                   built-in database's password, in the secrets
                                   volume, before Postgres first starts
    python -m app.launch           the server:
      1. the database logins' passwords: made once, kept in the secrets volume;
      2. waits for the database;
      3. a backup, then the migrations, when an update brings new ones
         (app/jobs/migrate.py), and the logins;
      4. prints the setup code while the server has no admin;
      5. runs the API (and the web app's files) and the daily jobs
         (app/jobs/scheduler.py) side by side; if either stops, the container
         stops and Docker restarts it.

The API gets only its own login (api_login): never the owner's password, so
even a flaw in the API can't get around row-level security. The daily jobs
get the purge and exchange rate logins, and the owner's for the backup.

Settings (all optional):
    ADMIN_DATABASE_URL   your own Postgres or Supabase, as its owner. Unset:
                         the built-in database container.
    PORT                 8080
    BACKUP_DIR           /backups
    SECRETS_DIR          /secrets
    DEV_RELOAD           development only: restart the API on code changes
"""
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg

from app.jobs import backup, migrate

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
    """The owner's URL with another login: same server, database and options."""
    parts = urlsplit(admin)
    host = parts.hostname or ""
    host = f"[{host}]" if ":" in host else host
    port = f":{parts.port}" if parts.port else ""
    netloc = f"{quote(login, safe='')}:{quote(password, safe='')}@{host}{port}"
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


def serve() -> None:
    admin = admin_url()
    passwords = login_passwords()
    wait_for(admin)
    backup_dir = os.environ.get("BACKUP_DIR", "/backups")

    def backup_first():
        path, _, _ = backup.run_backup(admin, backup_dir)
        print(f"before updating: backed up to {path}", flush=True)

    applied, setup_code = migrate.run(admin, passwords, before_migrating=backup_first)
    print(f"database ready ({len(applied)} migration(s) applied{': ' + ', '.join(applied) if applied else ''})",
          flush=True)
    if setup_code:
        print_setup_code(setup_code)

    base = {k: v for k, v in os.environ.items() if k != "ADMIN_DATABASE_URL"}
    api_env = {**base, "DATABASE_URL": login_url(admin, "api_login", passwords["api_login"])}
    jobs_env = {**base,
                "PURGE_DATABASE_URL": login_url(admin, "purge_login", passwords["purge_login"]),
                "FX_DATABASE_URL": login_url(admin, "fx_login", passwords["fx_login"]),
                "BACKUP_DATABASE_URL": admin, "BACKUP_DIR": backup_dir,
                "PURGE_LOG": os.environ.get("PURGE_LOG", str(Path(backup_dir) / "purged_accounts.jsonl"))}
    port = os.environ.get("PORT", "8080")
    reload = ["--reload"] if os.environ.get("DEV_RELOAD") else []        # development only (scripts/dev.sh)
    children = [
        subprocess.Popen([sys.executable, "-m", "uvicorn", "app.api.main:app", "--host", "0.0.0.0", "--port", port,
                          "--proxy-headers", "--forwarded-allow-ips", "*", *reload], env=api_env),
        subprocess.Popen([sys.executable, "-m", "app.jobs.scheduler"], env=jobs_env),
    ]

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
    else:
        serve()
