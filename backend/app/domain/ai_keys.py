"""Bring-your-own AI key: encrypt before it reaches the database.

The encryption key (AI_KEY_ENCRYPTION_KEY, 32 random bytes, base64) lives in
the backend's secret store, never in the database, so a database leak or a
backup only exposes ciphertext. In production prefer a cloud KMS to hold it;
this module is the minimal version. Each ciphertext is bound to its user and
provider, so it can't be copied onto another user's row and decrypted there.

Format: 1 byte key version | 12 byte nonce | AES-256-GCM ciphertext+tag.
The version byte allows rotating the encryption key later.
"""
import base64
import os
from uuid import UUID

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text
from sqlalchemy.orm import Session

KEY_VERSION = 1


def _aead() -> AESGCM:
    return AESGCM(base64.b64decode(os.environ["AI_KEY_ENCRYPTION_KEY"]))


def _context(user_id: UUID, provider: str) -> bytes:
    return f"{user_id}:{provider}".encode()


def encrypt(api_key: str, user_id: UUID, provider: str) -> bytes:
    nonce = os.urandom(12)
    return bytes([KEY_VERSION]) + nonce + _aead().encrypt(nonce, api_key.encode(), _context(user_id, provider))


def decrypt(blob: bytes, user_id: UUID, provider: str) -> str:
    if blob[0] != KEY_VERSION:
        raise ValueError("unknown key version")
    return _aead().decrypt(blob[1:13], blob[13:], _context(user_id, provider)).decode()


def save_key(db: Session, user_id: UUID, provider: str, api_key: str) -> str:
    """API: PUT /v1/me/ai-keys/{provider}. Returns the hint shown in settings."""
    hint = api_key[-4:]
    # Replace = delete + insert: the app may not read key_ciphertext, which an
    # upsert's "do update" would need.
    db.execute(text("delete from user_ai_keys where user_id = :u and provider = :p"), {"u": user_id, "p": provider})
    db.execute(
        text("insert into user_ai_keys (user_id, provider, key_ciphertext, key_hint) values (:u, :p, :c, :h)"),
        {"u": user_id, "p": provider, "c": encrypt(api_key, user_id, provider), "h": hint},
    )
    return hint


def key_for_book(ai_db, book_id: UUID) -> tuple[str, str] | None:
    """AI job, as ai_reader with app.user_id set: (provider, plaintext key) for a
    book using its owner's own key, or None when the book runs on the plan."""
    row = ai_db.execute(text("select * from ai_key_for_book(:b)"), {"b": book_id}).first()
    if row is None:
        return None
    return row.provider, decrypt(bytes(row.key_ciphertext), row.key_user, row.provider)
