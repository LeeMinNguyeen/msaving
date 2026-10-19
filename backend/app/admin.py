"""Commands for whoever runs the server, for when the web app can't help:

    docker compose exec msaving python -m app.admin reset-password <username>
        A one-time reset link (24 hours) for anyone, the admin included. Like
        the admin's reset link: also turns their two-factor off.
    docker compose exec msaving python -m app.admin make-admin <username>
        Makes that account the admin (for example after the admin left).
    docker compose exec msaving python -m app.admin repurge
        After restoring a backup: purges again the accounts purged since it.

Runs as the database owner, so it needs no admin account.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import psycopg
from sqlalchemy import create_engine

from app.core.sign_in import new_token
from app.jobs import account_deletion
from app.launch import admin_url, login_passwords, login_url

USAGE = __doc__


def _user(conn: psycopg.Connection, username: str):
    row = conn.execute("select id from users where username = lower(%s) and deleted_at is null", (username,)).fetchone()
    if not row:
        raise SystemExit(f"no account named {username!r}")
    return row[0]


def reset_password(username: str) -> None:
    token, digest = new_token()
    with psycopg.connect(admin_url()) as conn:
        user_id = _user(conn, username)
        conn.execute("insert into password_resets (token_sha256, user_id, expires_at) values (%s, %s, %s)",
                     (digest, user_id, datetime.now(timezone.utc) + timedelta(hours=24)))
    print("Open this path on the server's address within 24 hours (for example https://money.example.com"
          f"/reset?token=...):\n\n    /reset?token={token}\n")


def make_admin(username: str) -> None:
    with psycopg.connect(admin_url()) as conn:
        user_id = _user(conn, username)
        conn.execute("update users set is_admin = true, disabled_at = null where id = %s", (user_id,))
    print(f"{username} is now an admin")


def repurge() -> None:
    passwords = login_passwords()
    engine = create_engine(login_url(admin_url(), "purge_login", passwords["purge_login"]))
    log = os.environ.get("PURGE_LOG", os.path.join(os.environ.get("BACKUP_DIR", "/backups"), "purged_accounts.jsonl"))
    print(f"re-deleted {account_deletion.repurge(engine, log)} accounts restored from backup")


if __name__ == "__main__":
    match sys.argv[1:]:
        case ["reset-password", username]:
            reset_password(username)
        case ["make-admin", username]:
            make_admin(username)
        case ["repurge"]:
            repurge()
        case _:
            raise SystemExit(USAGE)
