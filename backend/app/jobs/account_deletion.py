"""The daily purge, as purge_login, which can run the purge and nothing else: accounts closed more than 30 days ago,
then expired sessions, invites and reset links.

Purged ids go to PURGE_LOG, outside the database, so that after restoring an older backup `--repurge` deletes those
accounts again. Keep PURGE_LOG at least as long as your oldest backup.
"""
import json
import os
import sys
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session


def request_deletion(db: Session) -> datetime:
    return db.execute(text("select request_account_deletion()")).scalar_one()


def restore(db: Session) -> bool:
    return bool(db.execute(text("select restore_account()")).scalar())


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


def run_purge(engine, purge_log: str | None = None) -> list[UUID]:
    log = _log_path(purge_log)
    # Ids are logged before the purge commits. If the commit then fails, the
    # logged accounts are past their 30 days, can't be restored, and the next
    # run purges them anyway; a repurge of them is harmless.
    with engine.begin() as conn:
        ids = [r[0] for r in conn.execute(text("select * from purge_deleted_accounts()"))]
        now = datetime.now(timezone.utc).isoformat()
        _append(log, [{"user_id": str(i), "purged_at": now} for i in ids])
    return ids


def purge_expired_sign_in(engine) -> int:
    with engine.begin() as conn:
        return conn.execute(text("select purge_expired_sign_in()")).scalar_one()


def repurge(engine, purge_log: str) -> int:
    ids = list(dict.fromkeys(r["user_id"] for r in _read(purge_log) if "purged_at" in r))
    with engine.begin() as conn:
        return conn.execute(text("select repurge_accounts(cast(:ids as uuid[]))"), {"ids": ids}).scalar_one()


if __name__ == "__main__":
    eng = create_engine(os.environ["PURGE_DATABASE_URL"])
    if "--repurge" in sys.argv:
        print(f"re-deleted {repurge(eng, _log_path(None))} accounts restored from backup")
    else:
        errors = []
        for name, step in (("purged {} accounts", lambda: len(run_purge(eng))),
                           ("deleted {} expired sessions", lambda: purge_expired_sign_in(eng))):
            try:                    # one step failing doesn't skip the other
                print(name.format(step()))
            except Exception as e:
                errors.append(e)
        if errors:
            raise SystemExit(f"failed: {errors}")
