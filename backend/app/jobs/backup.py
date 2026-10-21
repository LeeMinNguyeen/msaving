r"""Nightly database backup: one pg_dump of what a restore needs, kept about 6 days. Also run by app/launch.py
before an update applies new migrations.

The dump is checked with pg_restore --list, then copied into BACKUP_DIR as .partial and renamed, so a run that fails
never leaves a file that looks complete; only then are old dumps deleted.

What is dumped: the schemas public (the whole app, with its policies and grants) and msaving (the applied
migrations). Not the roles or their passwords, which live outside any one database.

BACKUP_DATABASE_URL is the database owner: pg_dump must see every row, and the app's own logins can't bypass
row-level security. pg_dump gets the password as PGPASSWORD, never on its command line, and no message prints the
URL or the password. A password holding @, /, ? or # must be percent-encoded (libpq splits at the first @ and stops
at /). pg_dump (PG_DUMP, else PATH) must be the server's major version.

Restore (by the operator; the setup guide has the same steps as docker
commands). DUMP is the dump file, NEW_DB_URL an empty database on the same
or a new server, as its owner. tests/test_backup.py runs the `$` lines.
    1. Stop the server (docker compose stop msaving).
    2. What lives outside the dump: functions made later aren't executable by
       everyone (the baseline's lock-down), and the roles the app's grants
       name, if this server doesn't have them yet (a new server). Their logins
       and passwords are made when the server starts:
       $ psql -v ON_ERROR_STOP=1 --command='alter default privileges revoke execute on functions from public' "$NEW_DB_URL"
       $ psql -v ON_ERROR_STOP=1 "$NEW_DB_URL" <<< "select format('create role %I nologin', r) from unnest(array['app_user', 'account_purger', 'fx_updater']) r where not exists (select 1 from pg_roles where rolname = r) \gexec"
    3. The app, its data and the list of applied migrations, leaving out the
       schema public itself, which every database already has:
       $ pg_restore --list "$DUMP" | grep -v -E ' (SCHEMA|COMMENT) - (SCHEMA )?public ' > msaving.list
       $ pg_restore --no-owner --single-transaction --exit-on-error --use-list=msaving.list --dbname="$NEW_DB_URL" "$DUMP"
    4. Start the server. Before anyone uses it, redo the purges made since the
       dump, which brought those accounts back:
           docker compose exec msaving python -m app.admin repurge
       It reads every purged id from PURGE_LOG (in the backups volume, outside
       the database, so the restore didn't roll it back) and purges again the
       accounts that are back.
    5. Accounts closed or restored after the dump: the server's log has an
       account_event line for each (app/core/events.py). Close or restore them
       again by hand if it matters.
"""
import contextlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

from psycopg import Error as PsycopgError
from psycopg.conninfo import conninfo_to_dict, make_conninfo

# Each is dumped if it exists.
SCHEMAS = ("public", "msaving")
KEEP = timedelta(days=5, hours=12)        # about 6 days, counting the newest
DUMP_NAME = re.compile(r"msaving-(\d{8}T\d{6}Z)\.dump(\.partial)?")


class BackupError(Exception):
    pass


def _split(url: str) -> tuple[str, str]:
    """(a libpq connection string without the password, the password), read as libpq reads the URL."""
    scheme, sep, rest = url.partition("://")
    if scheme not in ("postgresql", "postgres") or not sep:
        raise BackupError("BACKUP_DATABASE_URL must be a postgresql:// URL")
    if any(c in rest.rpartition("@")[0] for c in "@/?#"):
        raise BackupError("percent-encode the password in BACKUP_DATABASE_URL")
    try:
        params = conninfo_to_dict(url)
    except PsycopgError:
        raise BackupError("BACKUP_DATABASE_URL can't be parsed") from None
    password = params.pop("password", None) or ""
    return make_conninfo(**params), password


def _scrub(message: str, url: str) -> str:
    """Hide the URL and its password, encoded or not, in a message."""
    raw = url.partition("://")[2].rpartition("@")[0].partition(":")[2]
    secrets = {url, raw, unquote(raw)}
    with contextlib.suppress(Exception):
        secrets.add(conninfo_to_dict(url).get("password") or "")
    for secret in sorted(filter(None, secrets), key=len, reverse=True):
        message = message.replace(secret, "***")
    return message


def _tools() -> tuple[str, str]:
    """pg_dump from PG_DUMP, else PATH; pg_restore from beside it, so they match."""
    pg_dump = shutil.which(os.environ.get("PG_DUMP") or "pg_dump")
    if not pg_dump:
        raise BackupError("pg_dump not found: set PG_DUMP or PATH")
    beside = os.path.join(os.path.dirname(pg_dump), "pg_restore")
    pg_restore = beside if os.path.exists(beside) else shutil.which("pg_restore")
    if not pg_restore:
        raise BackupError("pg_restore not found")
    return pg_dump, pg_restore


def _run(cmd: list[str], env: dict) -> str:
    r = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        raise BackupError(f"{os.path.basename(cmd[0])} failed: {r.stderr.strip() or f'exit code {r.returncode}'}")
    return r.stdout


def prune(backup_dir: str, now: datetime) -> list[str]:
    """Deletes dumps (and leftover .partial files) older than KEEP. Returns their names."""
    old = [n for n in sorted(os.listdir(backup_dir))
           if (m := DUMP_NAME.fullmatch(n))
           and now - datetime.strptime(m[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc) > KEEP]
    for n in old:
        os.remove(os.path.join(backup_dir, n))
    return old


def run_backup(database_url: str, backup_dir: str) -> tuple[str, dict[str, int], list[str]]:
    """Writes one dump into backup_dir, then prunes. Returns its path, its table count per schema
    and the names of the old dumps deleted."""
    if not os.path.isdir(backup_dir):
        raise BackupError(f"BACKUP_DIR {backup_dir} is not a directory: is the volume mounted?")
    pg_dump, pg_restore = _tools()
    dsn, password = _split(database_url)
    env = dict(os.environ, PGAPPNAME="msaving-backup")
    # TLS as the address says (?sslmode=require for a database across the internet), else libpq's default, as in the
    # rest of the server: forcing it fails on a plain local Postgres.
    if password:
        env["PGPASSWORD"] = password
    now = datetime.now(timezone.utc)
    name = f"msaving-{now:%Y%m%dT%H%M%SZ}.dump"
    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, name)
        _run([pg_dump, "--format=custom", "--no-password", *[f"--schema={s}" for s in SCHEMAS],
              f"--file={local}", f"--dbname={dsn}"], env)
        toc = _run([pg_restore, "--list", local], env)
        tables = {s: toc.count(f" TABLE DATA {s} ") for s in SCHEMAS}
        if not tables["public"]:
            raise BackupError("the dump has no tables in schema public: wrong database?")
        final = os.path.join(backup_dir, name)
        partial = final + ".partial"
        try:
            # Owner-only: a dump holds password hashes and two-factor secrets.
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with open(local, "rb") as src, os.fdopen(fd, "wb") as dst:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            if os.path.getsize(partial) != os.path.getsize(local):
                raise BackupError("the copy in BACKUP_DIR is incomplete")
            os.replace(partial, final)
        except BaseException:
            with contextlib.suppress(OSError):
                os.remove(partial)
            raise
    return final, tables, prune(backup_dir, now)


def main() -> int:
    url, backup_dir = os.environ.get("BACKUP_DATABASE_URL", ""), os.environ.get("BACKUP_DIR", "")
    try:
        if not url or not backup_dir:
            raise BackupError("BACKUP_DATABASE_URL and BACKUP_DIR are required")
        path, tables, pruned = run_backup(url, backup_dir)
    except Exception as e:
        print(f"backup failed: {_scrub(str(e), url)}", file=sys.stderr)
        return 1
    counts = ", ".join(f"{n} in {s}" for s, n in tables.items())
    print(f"wrote {os.path.basename(path)} ({os.path.getsize(path)} bytes); tables: {counts};"
          f" deleted {len(pruned)} old: {', '.join(pruned) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
