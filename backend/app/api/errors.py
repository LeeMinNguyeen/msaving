"""The database starts every error a user can cause with a code ("owner_required: ..."): the API returns the
code as `detail` for the apps to translate, and the English text after it stays in the logs."""
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg import errors as pg
from sqlalchemy.exc import DBAPIError

from app.domain.transactions import Conflict

log = logging.getLogger(__name__)

CODES = {
    "owner_required": 409, "currency_locked": 409, "txn_shape": 422, "category_kind": 422,
    "budget_expense_only": 422, "no_rate": 409, "setup_invalid": 403, "invite_invalid": 403,
    "invite_required": 403, "reset_invalid": 403, "admin_only": 403, "admin_self": 409, "not_found": 404, "invalid_timezone": 422,
}
UNIQUE = {
    "users_username_key": "username_taken",
    "accounts_book_id_name_key": "name_taken",
    "budgets_category_id_period_key": "budget_exists",
    "contacts_book_id_name_key": "name_taken",
    "books_pkey": "conflict",              # a client id already used for someone else's book
    "accounts_pkey": "conflict",
    "installment_plans_transaction_id_key": "installment_exists",
}


def error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"detail": code}, status_code=status)


def _from_db(exc: DBAPIError) -> JSONResponse:
    orig = exc.orig
    if isinstance(orig, pg.RaiseException):
        code = str(orig.diag.message_primary or "").split(":", 1)[0]
        if code in CODES:
            return error(CODES[code], code)
    if isinstance(orig, pg.UniqueViolation) and orig.diag.constraint_name in UNIQUE:
        return error(409, UNIQUE[orig.diag.constraint_name])
    if isinstance(orig, pg.InsufficientPrivilege):          # includes row-level security refusals
        return error(403, "forbidden")
    if isinstance(orig, (pg.ForeignKeyViolation, pg.CheckViolation, pg.NotNullViolation,
                         pg.InvalidTextRepresentation, pg.StringDataRightTruncation)):
        return error(422, "invalid")
    log.exception("unexpected database error", exc_info=exc)
    return error(500, "unexpected_error")


def install(app: FastAPI) -> None:
    @app.exception_handler(DBAPIError)
    async def db_error(request: Request, exc: DBAPIError):
        return _from_db(exc)

    @app.exception_handler(RequestValidationError)
    async def invalid(request: Request, exc: RequestValidationError):
        # Same shape as every other error; the details are for developers.
        log.info("invalid request: %s", exc.errors())
        return error(422, "invalid")

    @app.exception_handler(Conflict)
    async def conflict(request: Request, exc: Conflict):
        return error(409, "conflict")
