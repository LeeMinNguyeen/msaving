"""Restoring a backup from the web app: the admin on Server admin, or whoever installed the server at setup (with
the setup code). The API never has the database owner's login, so it only checks the file, leaves it in
BACKUP_DIR/restore/ and stops the server; the launcher restores it as the server starts again
(app/jobs/restore.py). Everyone is signed out: the restored database has the sessions of the backup's day."""
import json
import os
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db, get_public_db
from app.api.routes.v1.sign_in import _client_ip, _limit
from app.core import sign_in as si
from app.core.auth import Caller, current_caller
from app.jobs import restore

router = APIRouter()

MAX_DUMP = 100 * 2**20
MAX_PURGED = 10 * 2**20


def stop_server() -> None:
    """The launcher stops its children and exits; Docker, or Cloud Run, starts the server again."""
    os.kill(int(os.environ.get("LAUNCHER_PID") or os.getpid()), signal.SIGTERM)


def _backup_dir() -> str:
    return os.environ.get("BACKUP_DIR", "/backups")


def _copy(upload: UploadFile, to: Path, limit: int) -> None:
    """Owner-only, like the nightly backups: a backup holds password hashes."""
    size = 0
    fd = os.open(to, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as out:
        while chunk := upload.file.read(2**20):
            size += len(chunk)
            if size > limit:
                break
            out.write(chunk)
    if size > limit:
        to.unlink()
        raise HTTPException(413, "restore_too_large")


def _leave_request(dump: UploadFile, purged: UploadFile | None, background: BackgroundTasks) -> Response:
    where = restore.folder(_backup_dir())
    where.mkdir(parents=True, exist_ok=True)
    partial = where / "upload.partial"
    _copy(dump, partial, MAX_DUMP)
    try:
        restore.check(partial)
    except restore.TooNew:
        partial.unlink()
        raise HTTPException(409, "restore_too_new") from None
    except restore.RestoreError:
        partial.unlink()
        raise HTTPException(422, "restore_invalid") from None
    (where / restore.PURGED).unlink(missing_ok=True)
    if purged is not None:
        _copy(purged, where / restore.PURGED, MAX_PURGED)
    os.replace(partial, where / restore.REQUEST)
    (where / restore.STATUS).write_text(json.dumps({"status": "requested", "at": datetime.now(timezone.utc).isoformat(),
                                                    "detail": None}))
    background.add_task(stop_server)
    return Response(status_code=202)


@router.post("/admin/restore", status_code=202)
def admin_restore(background: BackgroundTasks, file: UploadFile, password: Annotated[str, Form(max_length=256)],
                  confirm: Annotated[bool, Form()], code: Annotated[str | None, Form(max_length=20)] = None,
                  purged: UploadFile | None = None, caller: Caller = Depends(current_caller),
                  db: Session = Depends(get_db)) -> Response:
    """Asks for the password again, and the two-factor code when it's on: a stolen session can't replace the server."""
    if not db.execute(text("select am_admin()")).scalar():
        raise HTTPException(403, "admin_only")
    _limit((si.per_user_action, str(caller.id)))
    if not confirm:
        raise HTTPException(422, "invalid")
    row = db.execute(text("select password_hash, totp_secret from local_credentials where user_id = :u"),
                     {"u": caller.id}).mappings().one()
    if not si.password_matches(row["password_hash"], password):
        raise HTTPException(401, "invalid_credentials")
    if row["totp_secret"]:
        if not code:
            raise HTTPException(401, "code_required")
        if not si.totp_matches(row["totp_secret"], code):
            raise HTTPException(401, "invalid_code")
    return _leave_request(file, purged, background)


@router.post("/setup/restore", status_code=202)
def setup_restore(request: Request, background: BackgroundTasks, file: UploadFile,
                  setup_code: Annotated[str, Form(max_length=40)], purged: UploadFile | None = None,
                  db: Session = Depends(get_public_db)) -> Response:
    """Instead of creating the admin: the setup code from the log proves whoever asks installed the server."""
    _limit((si.per_ip, f"setup:{_client_ip(request)}"))
    if not db.execute(text("select setup_code_matches(:c)"), {"c": si.code_hash(setup_code)}).scalar():
        raise HTTPException(403, "setup_invalid")
    return _leave_request(file, purged, background)


class RestoreStatus(BaseModel):
    status: str                 # requested, running, done or failed
    at: datetime
    detail: str | None          # why it failed


@router.get("/admin/restore")
def restore_status(db: Session = Depends(get_db)) -> RestoreStatus | None:
    """The last restore from the web app, or null."""
    if not db.execute(text("select am_admin()")).scalar():
        raise HTTPException(403, "admin_only")
    status = restore.folder(_backup_dir()) / restore.STATUS
    return RestoreStatus(**json.loads(status.read_text())) if status.exists() else None
