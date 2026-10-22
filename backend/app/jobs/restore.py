"""Restoring a backup uploaded in the web app (Server admin, or at setup). The API, which never has the database
owner's login, only checks the file, leaves it in BACKUP_DIR/restore/ and stops the server. As the server starts
again, the launcher calls restore_if_requested() before the migrations:

    1. a backup of the database as it is, like the nightly one;
    2. the schemas public and waterflow emptied and the upload loaded: the own-database steps on the public Backups
       and restore page, which work on the built-in database too;
    3. the upload's purged accounts added to PURGE_LOG, and every account in it purged again;
    4. if 2 or 3 fails, the backup from 1 loaded back.

restore/status records the outcome for Server admin. The migrations and the logins then run as on every start.
"""
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import psycopg

from app.jobs import account_deletion, backup, migrate

REQUEST = "request.dump"
PURGED = "purged_accounts.jsonl"
STATUS = "status"
ROLES = ("app_user", "account_purger", "fx_updater")


class RestoreError(Exception):
    pass


class TooNew(RestoreError):
    pass


def folder(backup_dir: str) -> Path:
    return Path(backup_dir) / "restore"


def server_versions() -> list[str]:
    return sorted(f.name.split("_", 1)[0] for f in migrate.MIGRATIONS.glob("*.sql"))


def dump_versions(path: Path) -> list[str]:
    """The migrations a backup had applied. RestoreError when it isn't a Waterflow backup (or an MSaving one, the
    app's former name, whose migrations are in schema msaving)."""
    _, pg_restore = backup._tools()
    toc = subprocess.run([pg_restore, "--list", str(path)], capture_output=True, text=True)
    schema = next((s for s in ("waterflow", "msaving") if f" TABLE DATA {s} migrations " in toc.stdout), None)
    if toc.returncode != 0 or schema is None or " TABLE DATA public users " not in toc.stdout:
        raise RestoreError("not a Waterflow backup")
    data = subprocess.run([pg_restore, "--data-only", f"--schema={schema}", "--table=migrations", "--file=-", str(path)],
                          capture_output=True, text=True)
    lines = data.stdout.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(f"COPY {schema}.migrations")), None)
    if data.returncode != 0 or start is None:
        raise RestoreError("the backup's list of migrations can't be read")
    versions = [line.split("\t", 1)[0] for line in lines[start + 1:lines.index("\\.", start)]]
    if not versions:
        raise RestoreError("the backup lists no migrations")
    return sorted(versions)


def check(path: Path) -> None:
    """Refuses a file that isn't a Waterflow backup, or one from a newer version than this server."""
    if set(dump_versions(path)) - set(server_versions()):
        raise TooNew("the backup is from a newer version of Waterflow than this server")


def _empty(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("drop schema if exists waterflow cascade")
        conn.execute("drop schema if exists msaving cascade")
        conn.execute("drop schema if exists public cascade")
        conn.execute("create schema public")
        conn.execute("alter default privileges revoke execute on functions from public")
        for role in ROLES:
            if not conn.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone():
                conn.execute(f'create role "{role}" nologin')


def _load(url: str, path: str) -> None:
    _, pg_restore = backup._tools()
    dsn, password = backup._split(url)
    env = dict(os.environ, **({"PGPASSWORD": password} if password else {}))
    try:
        toc = backup._run([pg_restore, "--list", path], env)
        with tempfile.NamedTemporaryFile("w", suffix=".list") as listing:
            listing.write("\n".join(line for line in toc.splitlines()
                                    if not any(f" {kind} - {schema}public " in line
                                               for kind in ("SCHEMA", "COMMENT") for schema in ("", "SCHEMA "))))
            listing.flush()
            backup._run([pg_restore, "--no-owner", "--single-transaction", "--exit-on-error", f"--use-list={listing.name}",
                         f"--dbname={dsn}", path], env)
    except backup.BackupError as e:
        raise RestoreError(str(e)) from None


def _repurge(url: str, purge_log: str) -> None:
    ids = list(dict.fromkeys(r["user_id"] for r in account_deletion._read(purge_log) if "purged_at" in r))
    if ids:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute("select repurge_accounts(%s::uuid[])", (ids,))


def _apply(url: str, path: str, purged: Path | None, purge_log: str) -> None:
    _empty(url)
    _load(url, path)
    if purged and purged.exists():
        with open(purge_log, "a") as log:
            log.write(purged.read_text().rstrip("\n") + "\n")
    _repurge(url, purge_log)


def _record(where: Path, status: str, detail: str | None = None) -> None:
    (where / STATUS).write_text(json.dumps({"status": status, "at": datetime.now(timezone.utc).isoformat(), "detail": detail}))


def restore_if_requested(url: str, backup_dir: str, purge_log: str | None = None) -> str | None:
    """'done' or 'failed' when a restore was waiting, None otherwise. Never raises: the server starts either way."""
    where = folder(backup_dir)
    request = where / REQUEST
    if not request.exists():
        return None
    purge_log = purge_log or os.environ.get("PURGE_LOG") or os.path.join(backup_dir, "purged_accounts.jsonl")
    _record(where, "running")
    before = None
    try:
        check(request)
        before, _, _ = backup.run_backup(url, backup_dir)
        _apply(url, str(request), where / PURGED, purge_log)
        _record(where, "done")
        print(f"restored the uploaded backup; the database before it is in {os.path.basename(before)}", flush=True)
        return "done"
    except Exception as e:
        reason = backup._scrub(str(e), url).splitlines()[0] if str(e) else type(e).__name__
        if before:
            try:
                _apply(url, before, None, purge_log)
            except Exception as again:
                reason += f"; putting the database back failed too ({backup._scrub(str(again), url).splitlines()[0]}):" \
                          f" restore {os.path.basename(before)} by hand"
        _record(where, "failed", reason)
        print(f"restoring the uploaded backup failed: {reason}", flush=True)
        return "failed"
    finally:
        for name in (REQUEST, PURGED):
            (where / name).unlink(missing_ok=True)
