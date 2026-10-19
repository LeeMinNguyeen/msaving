"""The account event log, kept outside the database (msaving-docs, Deleting an
account, point 3): every account closure, restore and consent withdrawal, as
one JSON line on stdout. Cloud Run sends stdout to Cloud Logging, which keeps
it longer than the backups, so a backup restore can re-apply what happened
after the backup was taken. Only ids and times: no email, no name.

Call it after the change is committed, never before: a line for something
that was rolled back would be re-applied by mistake.
"""
import json
import sys
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

Action = Literal["account_closed", "account_restored", "consent_withdrawn"]


def account_event(action: Action, user_id: UUID) -> None:
    line = {
        "severity": "NOTICE",
        "message": f"{action} {user_id}",
        "account_event": action,
        "user_id": str(user_id),
        "at": datetime.now(timezone.utc).isoformat(),
        "logging.googleapis.com/labels": {"log": "account_events"},
    }
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()
