"""The account event log, kept outside the database (docs: Deleting an
account): every account closure and restore, as one JSON line on stdout,
which Docker keeps (`docker compose logs msaving`). After restoring an older
backup, these lines say which accounts were closed or restored since. Only
ids and times: no name.

Call it after the change is committed, never before: a line for something
that was rolled back would be re-applied by mistake.
"""
import json
import sys
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

Action = Literal["account_closed", "account_restored"]


def account_event(action: Action, user_id: UUID) -> None:
    line = {"account_event": action, "user_id": str(user_id), "at": datetime.now(timezone.utc).isoformat()}
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()
