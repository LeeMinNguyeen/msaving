"""Starter categories for a new book, from the old BudgetTracking app (src/db/seed.ts). Once created they're
ordinary categories: their names are never translated later."""
import uuid
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

# (parent, kind, colour, children). Colours are from the app's preset grid.
STARTER_CATEGORIES: dict[str, list[tuple[str, str, str, list[str]]]] = {
    "en": [
        ("Needs", "expense", "#2563eb", ["Rent", "Groceries", "Utilities", "Transportation"]),
        ("Wants", "expense", "#9333ea", ["Dining out", "Entertainment", "Shopping"]),
        ("Income", "income", "#16a34a", ["Salary", "Bonus", "Gifts", "Investments"]),
        ("Transfers", "transfer", "#64748b", ["Savings", "Debt repayment", "Investment move"]),
    ],
    "vi": [
        ("Thiết yếu", "expense", "#2563eb", ["Tiền nhà", "Ăn uống/Đi chợ", "Điện nước/Internet", "Di chuyển"]),
        ("Cá nhân", "expense", "#9333ea", ["Ăn ngoài", "Giải trí", "Mua sắm"]),
        ("Thu nhập", "income", "#16a34a", ["Lương", "Thưởng", "Quà tặng", "Đầu tư"]),
        ("Chuyển khoản", "transfer", "#64748b", ["Tiết kiệm", "Trả nợ", "Đầu tư"]),
    ],
}


def add_starter_categories(db: Session, book_id: UUID, language: str = "en") -> int:
    """Insert the starter tree into a book the signed-in user can edit. Returns how many were added."""
    added = 0
    for parent, kind, color, children in STARTER_CATEGORIES.get(language, STARTER_CATEGORIES["en"]):
        parent_id = uuid.uuid4()
        rows = [{"i": parent_id, "p": None, "n": parent}] + [{"i": uuid.uuid4(), "p": parent_id, "n": c} for c in children]
        for r in rows:
            db.execute(text("insert into categories (id, book_id, parent_id, name, kind, color)"
                            " values (:i, :b, :p, :n, :k, :c)"), {**r, "b": book_id, "k": kind, "c": color})
        added += len(rows)
    return added
