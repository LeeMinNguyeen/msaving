"""Account deletion: close now, restore within 30 days, then delete for good.

API (runs in user_session, as the signed-in user):
    POST /v1/me/delete   -> request_deletion(db)   returns the date it will be deleted
    POST /v1/me/restore  -> restore(db)            True if restored
    GET  /v1/me/status   -> status(db)

Daily job (python -m app.jobs.account_deletion), connected as a login that is a member
of account_purger, which can run the purge and nothing else:
    1. purge_deleted_accounts() deletes accounts closed more than 30 days ago;
    2. their ids are appended to PURGE_LOG, kept outside the database, before
       the purge commits, so no purged id is ever missing from it;
    3. their logins are deleted at Supabase Auth. Every run retries any logged
       id whose login isn't confirmed deleted yet (404 counts as deleted);
    4. sign-ups whose email was never confirmed within 7 days are deleted at
       Supabase Auth. They never had an account in the app (it is created only
       after the email link), so nothing is logged for them.
If a backup from before a purge is ever restored, `--repurge` deletes those
accounts again, and their logins, which live in the same database (Supabase
Auth's own schema) and come back with it. Keep PURGE_LOG at least as long as
your oldest backup. In production it is a file on a Cloud Storage bucket with
object versioning, mounted into the Cloud Run job as a volume.
"""
import json
import os
import sys
import urllib.request
from collections.abc import Callable, Iterator
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session


def request_deletion(db: Session) -> datetime:
    return db.execute(text("select request_account_deletion()")).scalar_one()


def restore(db: Session) -> bool:
    return bool(db.execute(text("select restore_account()")).scalar())


def status(db: Session) -> dict:
    row = db.execute(text("select * from my_account_status()")).mappings().first()
    return dict(row) if row else {}


UNCONFIRMED_DAYS = 7


def _auth_admin(method: str, path: str):
    """Supabase Auth admin API, with the service key. Checked against the local
    Supabase stack; check once against a hosted project before launch."""
    req = urllib.request.Request(
        f"{os.environ['SUPABASE_URL']}/auth/v1/admin/{path}",
        method=method,
        headers={"apikey": os.environ["SUPABASE_SERVICE_ROLE_KEY"],
                 "Authorization": f"Bearer {os.environ['SUPABASE_SERVICE_ROLE_KEY']}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"null")


def delete_auth_user(user_id: UUID) -> None:
    try:
        _auth_admin("DELETE", f"users/{user_id}")
    except urllib.error.HTTPError as e:
        if e.code != 404:          # already gone is fine
            raise


def list_auth_users(per_page: int = 500) -> Iterator[dict]:
    page = 1
    while True:
        users = _auth_admin("GET", f"users?page={page}&per_page={per_page}")["users"]
        yield from users
        if len(users) < per_page:
            return
        page += 1


def _time(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def purge_unconfirmed_signups(list_users: Callable[[], Iterator[dict]] = list_auth_users,
                              delete_login=delete_auth_user, now: datetime | None = None) -> list[UUID]:
    """Deletes Supabase logins whose email wasn't confirmed within 7 days of
    signing up. Supabase has no setting for it: its links expire, the sign-ups
    stay, and with open sign-up bots can fill auth.users. Never touches a login
    that confirmed an email or a phone, or ever signed in."""
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=UNCONFIRMED_DAYS)
    stale = [UUID(u["id"]) for u in list_users()          # listed in full first: deleting shifts the pages
             if not u.get("email_confirmed_at") and not u.get("phone_confirmed_at") and not u.get("last_sign_in_at")
             and _time(u.get("created_at")) is not None and _time(u["created_at"]) < cutoff]
    failed = []
    for i in stale:
        try:
            delete_login(i)
        except Exception as e:          # retried on the next run
            failed.append((i, e))
    if failed:
        raise RuntimeError(f"{len(failed)} unconfirmed sign-up(s) not deleted yet, retried next run: {failed}")
    return stale


def _log_path(purge_log: str | None) -> str:
    log = purge_log or os.environ.get("PURGE_LOG")
    if not log:
        raise RuntimeError("PURGE_LOG is required: purged ids must be kept outside the database")
    return log


def _append(log: str, records: list[dict]) -> None:
    with open(log, "a") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _read(log: str) -> list[dict]:
    if not os.path.exists(log):
        return []
    with open(log) as f:
        return [json.loads(line) for line in f if line.strip()]


def _pending_logins(records: list[dict]) -> list[str]:
    """Ids whose latest purge isn't followed by a confirmed login deletion. Order
    matters: after a backup restore, a login deleted earlier can be back."""
    last_purge, last_done = {}, {}
    for n, r in enumerate(records):
        if "purged_at" in r:
            last_purge[r["user_id"]] = n
        if "login_deleted_at" in r:
            last_done[r["user_id"]] = n
    return [u for u, n in last_purge.items() if last_done.get(u, -1) < n]


def _delete_logins(log: str, ids, delete_login) -> None:
    """Delete each login; record the ones confirmed gone. Raises after trying all if any failed."""
    failed = []
    for i in ids:
        try:
            delete_login(UUID(str(i)))
        except Exception as e:          # retried on the next run
            failed.append((i, e))
            continue
        _append(log, [{"user_id": str(i), "login_deleted_at": datetime.now(timezone.utc).isoformat()}])
    if failed:
        raise RuntimeError(f"{len(failed)} login(s) not deleted yet, retried next run: {failed}")


def run_purge(engine, delete_login=delete_auth_user, purge_log: str | None = None) -> list[UUID]:
    log = _log_path(purge_log)
    # Ids are logged before the purge commits. If the commit then fails, the
    # logged accounts are past their 30 days, can't be restored, and the next
    # run purges them anyway; a repurge of them is harmless.
    with engine.begin() as conn:
        ids = [r[0] for r in conn.execute(text("select * from purge_deleted_accounts()"))]
        now = datetime.now(timezone.utc).isoformat()
        _append(log, [{"user_id": str(i), "purged_at": now} for i in ids])
    _delete_logins(log, _pending_logins(_read(log)), delete_login)
    return ids


def repurge(engine, purge_log: str, delete_login=delete_auth_user) -> int:
    ids = list(dict.fromkeys(r["user_id"] for r in _read(purge_log) if "purged_at" in r))
    with engine.begin() as conn:
        n = conn.execute(text("select repurge_accounts(cast(:ids as uuid[]))"), {"ids": ids}).scalar_one()
        # The restore brought their logins back too: mark them all pending again,
        # so a deletion that fails now is retried by the daily run.
        now = datetime.now(timezone.utc).isoformat()
        _append(purge_log, [{"user_id": i, "purged_at": now, "repurge": True} for i in ids])
    _delete_logins(purge_log, _pending_logins(_read(purge_log)), delete_login)
    return n


if __name__ == "__main__":
    eng = create_engine(os.environ["PURGE_DATABASE_URL"])
    if "--repurge" in sys.argv:
        print(f"re-deleted {repurge(eng, _log_path(None))} accounts restored from backup")
    else:
        errors = []
        for name, step in (("purged {} accounts", lambda: run_purge(eng)),
                           ("deleted {} unconfirmed sign-ups", purge_unconfirmed_signups)):
            try:                    # one step failing doesn't skip the other
                print(name.format(len(step())))
            except Exception as e:
                errors.append(e)
        if errors:
            raise SystemExit(f"failed: {errors}")
