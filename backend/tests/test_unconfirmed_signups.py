"""The purge job's deletion of sign-ups that never confirmed their email
(app/jobs/account_deletion.py). No database: Supabase Auth's admin API is
replaced by a list of logins and a recorder.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.jobs.account_deletion import purge_unconfirmed_signups

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


def login(age_days, **fields):
    created = (NOW - timedelta(days=age_days)).isoformat().replace("+00:00", "Z")
    return {"id": str(uuid.uuid4()), "created_at": created, "email_confirmed_at": None,
            "phone_confirmed_at": None, "last_sign_in_at": None, **fields}


def test_only_old_unconfirmed_sign_ups_are_deleted():
    old = login(8)
    keep = [
        login(6),                                                    # still inside the 7 days
        login(7, created_at=(NOW - timedelta(days=7)).isoformat()),  # exactly 7 days: not yet
        login(30, email_confirmed_at="2026-09-21T00:00:00Z"),        # confirmed
        login(30, phone_confirmed_at="2026-09-21T00:00:00Z"),
        login(30, last_sign_in_at="2026-09-21T00:00:00Z"),           # signed in once: never touched
        login(30, created_at=None),
    ]
    deleted = []
    assert purge_unconfirmed_signups(lambda: iter([old, *keep]), deleted.append, now=NOW) == [uuid.UUID(old["id"])]
    assert deleted == [uuid.UUID(old["id"])]


def test_a_failed_deletion_is_reported_after_trying_the_rest():
    a, b = login(10), login(10)
    deleted = []

    def delete(i):
        if str(i) == a["id"]:
            raise OSError("auth down")
        deleted.append(i)

    with pytest.raises(RuntimeError, match="1 unconfirmed sign-up"):
        purge_unconfirmed_signups(lambda: iter([a, b]), delete, now=NOW)
    assert deleted == [uuid.UUID(b["id"])]
