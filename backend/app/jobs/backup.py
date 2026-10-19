"""Nightly database backup: one pg_dump of what a restore needs, kept about 6 days.

Why: production runs on Supabase Free during the hobbyist test, and Free has
no managed backups (Supabase backs up Pro, Team and Enterprise projects only,
and asks Free projects to export their data themselves). This job is that
export. Production moves to Pro, with its daily backups, before public launch.

Daily job (python -m app.jobs.backup), a Cloud Run job started by Cloud Scheduler after
the purge job (python -m app.jobs.account_deletion):
    1. pg_dump, custom format, to a local temporary file;
    2. pg_restore --list reads it back, and it must hold the app's tables;
    3. it is copied into BACKUP_DIR as msaving-<UTC time>.dump.partial, then
       renamed, so a run that fails never leaves a file that looks complete;
    4. once the new dump is in place, dumps older than 5 days 12 hours (by the
       time in their name) are deleted.
Any failure exits non-zero: a failed execution is the alert (set a Cloud
Monitoring alert on this job's failed executions). The log line counts the
tables dumped per schema; in production, auth must not be 0.

What is dumped:
- public: the whole app, schema and data: tables, functions, triggers,
  row-level security policies and grants. A restore runs no migrations.
- auth: Supabase Auth's tables. Only their rows are restored (a new project
  already has the tables), so logins, password hashes and two-factor secrets
  come back with the accounts; without them nobody could sign in again.
- supabase_migrations: the Supabase CLI's list of applied migrations, so CI's
  `supabase db push` carries on from the restored version.
A schema that doesn't exist is skipped (plain Postgres in the tests has no
auth). No dump holds Supabase's settings (Auth, API, SMTP), roles and their
passwords, or files in Supabase Storage (unused here).

Connection and role: BACKUP_DATABASE_URL, a secret, is the project's Session
pooler string (port 5432, user postgres.<project ref>, sslmode=require) for
the `postgres` role. The pooler because Free's direct connection is IPv6 only
(the IPv4 add-on is Pro and up) and the pooler takes IPv4; session mode
because pg_dump needs one session, which transaction mode (port 6543) doesn't
keep. `postgres` because pg_dump must see every row: it turns row-level
security off and stops with an error if the role can't bypass it. Every user
data table has row-level security and the app's own logins deliberately can't
bypass it (no BYPASSRLS); Supabase's postgres role can, and can read Supabase
Auth's tables. It is the strongest login the project has, so its URL is only in
Secret Manager, readable only by this job's service account, and the job only
reads. The URL is parsed as libpq parses it, and pg_dump gets the password as
PGPASSWORD, never on its command line; no message prints the URL or password.
Percent-encode a password holding @, /, ? or # (libpq splits at the first @
and stops at /; the job refuses all four raw). Use a pg_dump (PG_DUMP, else PATH) of the server's
major version (`select version()`): an older one refuses to dump, and a newer
one can write settings that an older server rejects on restore.

Where dumps go: BACKUP_DIR is a Cloud Storage bucket in asia-southeast1,
mounted into the job as a Cloud Run volume. Its own bucket, not PURGE_LOG's
(that one keeps versions). The privacy policy says an account leaves backups
within 7 days of its purge:
- Step 4 deletes dumps older than 5 days 12 hours. The last dump holding a
  purged account is the last one taken before the purge, so it goes about 5
  days after the purge when this job runs after the purge job, and about 6
  if the purge ran late. Old dumps are deleted only after a good new one
  exists, so a failing job keeps what's there.
- A lifecycle rule deleting objects 6 days old ({"rule": [{"action": {"type":
  "Delete"}, "condition": {"age": 6}}]}) is the backstop while the job is
  failing, leftover .partial files included. Cloud Storage runs lifecycle
  rules asynchronously with no promised delay, so the alert on failed runs
  is what keeps the 7 days then.
- Object versioning off (the default) and soft delete off
  (`gcloud storage buckets update gs://BUCKET --clear-soft-delete`). Either one
  keeps deleted dumps, restorable, past the 7 days: soft delete keeps every
  deleted object 7 more days by default, including what the lifecycle rule
  deletes and the full .partial copy each night's rename deletes.
- Access: uniform bucket-level access and public access prevention on. Only
  the job's service account writes (roles/storage.objectUser on this bucket:
  the mount needs to list, a rename is a copy plus a delete, and step 4
  deletes). Only the
  project owner reads, to restore. Encrypted at rest by Google by default.
Cloud Run's local disk is memory: give the job memory for twice the dump.

Restore (manual, by the project owner). Supabase documents restoring into a
new project only, so restore into a new one and switch the app over. DUMP is
the dump file, NEW_DB_URL the new project's Session pooler URL as postgres.
Use pg_restore and psql from one Postgres install of the server's major
version. tests/test_backup.py runs the `$` lines on plain Postgres; do one
test restore into a scratch Supabase project before the hobbyist test (pause
the development project first, since Free allows two active projects, and
delete the scratch project afterwards).
    1. Pause the Cloud Scheduler jobs and take the app offline.
    2. Download the newest good dump: gcloud storage cp gs://BUCKET/msaving-<time>.dump .
    3. Create a Supabase project in the same region. Free allows two active
       projects (development and production use both), so pause the old
       production project first; paused projects don't count. Set what no
       dump holds:
       Auth settings (site URL, redirect URLs, SMTP, email confirmation,
       two-factor, rate limits), the Data API off, and any extension the
       migrations use that isn't on by default.
    4. Create the app's roles, which live outside the database: every
       `create role` in supabase/migrations (today app_user, ai_reader,
       fx_updater, account_purger and billing_webhook, all nologin), then one
       login per role with a new password (msaving-docs, Environments).
    5. The app, schema and data, and the CLI's migration list. First take
       back what a new project grants Supabase's API roles on every new
       object in public, as the lock migration does: restored objects are
       created as postgres and would pick those grants up, so anon could call
       the purge functions. Left out of the restore: what the new project
       already has (schema public, Supabase's own entries), and auth, which
       is step 6:
       $ psql -v ON_ERROR_STOP=1 --command='alter default privileges in schema public revoke all on tables from anon, authenticated' --command='alter default privileges in schema public revoke all on sequences from anon, authenticated' --command='alter default privileges in schema public revoke all on functions from anon, authenticated' --command='alter default privileges revoke execute on functions from public' "$NEW_DB_URL"
       $ pg_restore --list "$DUMP" | grep -v -E ' SCHEMA - public | COMMENT - SCHEMA public | auth | supabase_admin$' > app.list
       $ pg_restore --no-owner --single-transaction --exit-on-error --use-list=app.list --dbname="$NEW_DB_URL" "$DUMP"
    6. Logins: Supabase Auth's rows into the new project's auth tables, except
       its own migration list. As in Supabase's restore guide, triggers and
       foreign key checks are off while they load:
       $ pg_restore --list "$DUMP" | grep -E ' (TABLE DATA|SEQUENCE SET) auth ' | grep -v ' schema_migrations ' > auth.list
       $ pg_restore --use-list=auth.list --file=auth.sql "$DUMP"
       $ psql --single-transaction -v ON_ERROR_STOP=1 --command='set session_replication_role = replica' --file=auth.sql "$NEW_DB_URL"
    7. Point the environment at the new project: the login URLs and
       BACKUP_DATABASE_URL in Secret Manager, SUPABASE_URL and the service
       key, the API's token checks, and the web app's Supabase settings.
    8. Before anyone signs in, redo the purges made since the dump, which
       brought those accounts back with their logins: run the purge Cloud Run
       job once with its arguments changed to `-m app.jobs.account_deletion --repurge`
       (gcloud run jobs execute PURGE_JOB --args=... --wait), after step 7
       pointed its secrets at the new project. Run it there, not from a
       laptop: it appends to PURGE_LOG, and only the bucket's copy is the one
       the daily purge reads.
       It reads every purged id from PURGE_LOG (kept outside the database, so
       the restore didn't roll it back), purges again the accounts that are
       back (repurge_accounts skips ids still purged), then deletes the Supabase
       Auth login of every id in the log (404 counts as gone). If a login
       can't be deleted it exits with an error, and the daily purge retries it.
    9. Re-apply what users did to their accounts after the dump, from the
       API's account event log in Cloud Logging (msaving-docs, Deleting an
       account): closures, consent withdrawals, and restores (set users.deletion_requested_at to null for
       those ids, or the purge would delete accounts their owners kept).
   10. Delete DUMP and auth.sql (they hold password hashes and two-factor
       secrets) and the .list files, reopen the app, resume the scheduler jobs.
       Once the new project works, delete the old production project within
       7 days: paused, it still holds every account, including ones purged
       later, which would break the privacy policy's 7-day promise.
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

# Each is dumped if it exists; see the docstring for why.
SCHEMAS = ("public", "auth", "supabase_migrations")
KEEP = timedelta(days=5, hours=12)        # see the docstring: the 7-day promise
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
        raise BackupError(f"BACKUP_DIR {backup_dir} is not a directory: is the bucket mounted?")
    pg_dump, pg_restore = _tools()
    dsn, password = _split(database_url)
    env = dict(os.environ, PGAPPNAME="msaving-backup")
    env.setdefault("PGSSLMODE", "require")          # TLS unless the URL says otherwise
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
            with open(local, "rb") as src, open(partial, "wb") as dst:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())              # on a Cloud Storage volume, the upload happens here
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
