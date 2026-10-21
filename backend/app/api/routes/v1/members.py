"""The database keeps at least one owner (409 owner_required) and allows each step only to the right people; these
routes repeat the checks to give clearer errors. An invite shows the invitee nothing of the book until accepted."""
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.routes.v1.books import get_book, require_role
from app.core import sign_in as si
from app.core.auth import current_user

router = APIRouter()

Role = Literal["owner", "editor", "viewer"]


class Member(BaseModel):
    user_id: UUID
    name: str                    # the username, or "Deleted user"
    display_name: str | None
    role: Role
    pending: bool
    me: bool


@router.get("/books/{book_id}/members")
def list_members(book_id: UUID, user_id: UUID = Depends(current_user), db: Session = Depends(get_db)) -> list[Member]:
    get_book(db, book_id)
    rows = db.execute(text(
        "select m.user_id, p.name, p.display_name, m.role::text as role, m.accepted_at is null as pending,"
        "       m.user_id = :me as me"
        "  from book_members m join book_people p on p.book_id = m.book_id and p.user_id = m.user_id"
        " where m.book_id = :b"
        " order by m.accepted_at is null, m.role, p.name"), {"b": book_id, "me": user_id}).mappings()
    return [Member(**r) for r in rows]


class Invite(BaseModel):
    username: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=30)]
    role: Role = "editor"


@router.post("/books/{book_id}/members", status_code=201)
def invite(book_id: UUID, body: Invite, user_id: UUID = Depends(current_user),
           db: Session = Depends(get_db)) -> list[Member]:
    """409 cannot_invite alike for a username not on this server and for someone already in the book. Rate limited
    because a found username becomes an invite: this caps how fast an owner can find out which usernames exist."""
    require_role(get_book(db, book_id), "owner")
    if not si.per_user_action.allow(f"book-invite:{user_id}"):
        raise HTTPException(429, "rate_limited")
    invitee = db.execute(text("select find_user_by_username(:u)"), {"u": body.username}).scalar()
    taken = invitee is not None and db.execute(
        text("select 1 from book_members where book_id = :b and user_id = :u"), {"b": book_id, "u": invitee}).first()
    if invitee is None or taken:
        raise HTTPException(409, "cannot_invite")
    db.execute(text("insert into book_members (book_id, user_id, role, invited_by) values (:b, :u, :r, :me)"),
               {"b": book_id, "u": invitee, "r": body.role, "me": user_id})
    db.commit()
    return list_members(book_id, user_id, db)


class RoleChange(BaseModel):
    role: Role


@router.patch("/books/{book_id}/members/{member_id}")
def change_role(book_id: UUID, member_id: UUID, body: RoleChange, user_id: UUID = Depends(current_user),
                db: Session = Depends(get_db)) -> list[Member]:
    """Owners only, their own role included (409 owner_required for the last owner)."""
    require_role(get_book(db, book_id), "owner")
    n = db.execute(text("update book_members set role = :r where book_id = :b and user_id = :u"),
                   {"b": book_id, "u": member_id, "r": body.role}).rowcount
    if n == 0:
        raise HTTPException(404, "not_found")
    db.commit()
    return list_members(book_id, user_id, db)


@router.delete("/books/{book_id}/members/{member_id}", status_code=204)
def remove_member(book_id: UUID, member_id: UUID, user_id: UUID = Depends(current_user),
                  db: Session = Depends(get_db)) -> Response:
    """An owner removes anyone (or cancels an invite); anyone leaves with their own id. The last owner can't leave."""
    book = get_book(db, book_id)
    if member_id != user_id:
        require_role(book, "owner")
    n = db.execute(text("delete from book_members where book_id = :b and user_id = :u"),
                   {"b": book_id, "u": member_id}).rowcount
    if n == 0:
        raise HTTPException(404, "not_found")
    db.commit()
    return Response(status_code=204)


class BookInvite(BaseModel):
    book_id: UUID
    book_name: str
    role: Role
    invited_by: str              # a username, or "Deleted user"
    invited_at: datetime


@router.get("/me/book-invites")
def my_book_invites(db: Session = Depends(get_db)) -> list[BookInvite]:
    rows = db.execute(text("select book_id, book_name, role::text as role, invited_by_username as invited_by, invited_at"
                           "  from my_pending_invites() order by invited_at")).mappings()
    return [BookInvite(**r) for r in rows]


def _pending(db: Session, book_id: UUID) -> None:
    if db.execute(text("select 1 from my_pending_invites() where book_id = :b"), {"b": book_id}).first() is None:
        raise HTTPException(404, "not_found")


@router.post("/me/book-invites/{book_id}/accept", status_code=204)
def accept(book_id: UUID, db: Session = Depends(get_db)) -> Response:
    _pending(db, book_id)
    db.execute(text("select accept_invite(:b)"), {"b": book_id})
    db.commit()
    return Response(status_code=204)


@router.delete("/me/book-invites/{book_id}", status_code=204)
def decline(book_id: UUID, user_id: UUID = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    """Nobody is told: the owner sees the invite gone from the list."""
    _pending(db, book_id)
    db.execute(text("delete from book_members where book_id = :b and user_id = :u and accepted_at is null"),
               {"b": book_id, "u": user_id})
    db.commit()
    return Response(status_code=204)
