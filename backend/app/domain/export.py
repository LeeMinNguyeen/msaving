"""Download my data: a ZIP of readable CSV files.

GET /v1/me/export -> build_export(db) inside user_session(). Row-level security
already limits every query to the books this user is a member of.

Covers everything the user entered, everything recorded about them (profile,
memberships, their own activity) and what was derived from it
(balances). Written for people, not as a schema dump: named columns, amounts as
decimals in their currency, usernames instead of ids ("Deleted user" for
purged accounts), no internal ids. In the user's language (users.language):
English by default, or Vietnamese. Only the labels are translated; what users
typed (names, payees, notes) is exported as typed.
Not included: secrets (password hash, two-factor secret, recovery codes,
sessions).
"""
import csv
import io
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.orm import Session

README = {"en": """Your data export
================

Created: {created}

Each file is a spreadsheet (CSV, UTF-8). It includes every book you are a
member of, including books shared with you.

profile.csv          Your account: username, name, timezone, language
books.csv            Your books, your role in each, and who else is in them
accounts.csv         Accounts in each book with their current balance
transactions.csv     Every transaction. Transfers show both accounts
categories.csv       Your categories (archived ones included and marked)
budgets.csv          Your budgets
installments.csv     Credit card purchases paid in installments
people.csv           People you lend to or borrow from, and who owes what
exchange_rates.csv   Your books' own exchange rates
edit_history.csv     Every saved version of every transaction, and who saved it
my_activity.csv      Changes you made, with the time and book

Amounts are in the currency shown next to them. Negative = money out.
""", "vi": """Dữ liệu của bạn
===============

Tạo lúc: {created}

Mỗi tệp là một bảng tính (CSV, UTF-8). Bao gồm mọi sổ bạn là thành viên,
kể cả sổ người khác chia sẻ với bạn.

profile.csv          Tài khoản của bạn: tên người dùng, tên hiển thị, múi giờ, ngôn ngữ
books.csv            Các sổ của bạn, vai trò của bạn trong từng sổ và những người khác trong sổ
accounts.csv         Các tài khoản trong từng sổ và số dư hiện tại
transactions.csv     Mọi giao dịch. Chuyển khoản hiển thị cả hai tài khoản
categories.csv       Các danh mục của bạn (kể cả danh mục đã lưu trữ, có đánh dấu)
budgets.csv          Các ngân sách của bạn
installments.csv     Các khoản mua bằng thẻ tín dụng trả góp
people.csv           Những người bạn cho vay hoặc vay, và ai nợ ai
exchange_rates.csv   Tỷ giá riêng của các sổ
edit_history.csv     Mọi phiên bản đã lưu của từng giao dịch, và người đã lưu
my_activity.csv      Những thay đổi bạn đã thực hiện, kèm thời gian và sổ

Số tiền tính theo loại tiền ghi bên cạnh. Số âm = tiền ra.
"""}

# English label -> Vietnamese. Column headers and fixed values (types, roles,
# periods...). Anything not listed is exported as is.
VI = {
    # headers
    "Username": "Tên người dùng", "Name": "Tên", "Timezone": "Múi giờ", "Language": "Ngôn ngữ",
    "Account created": "Ngày tạo tài khoản", "Deletion requested": "Yêu cầu xóa lúc",
    "Book": "Sổ", "Your role": "Vai trò của bạn", "Main currency": "Tiền tệ chính", "Created": "Ngày tạo",
    "Members": "Thành viên", "Account": "Tài khoản", "Type": "Loại", "Currency": "Tiền tệ",
    "Last 4 digits": "4 số cuối", "Person": "Người liên quan", "Balance": "Số dư", "Closed": "Đã đóng",
    "Counted in net worth": "Tính vào tài sản ròng", "Color": "Màu", "Credit limit": "Hạn mức tín dụng",
    "Annual fee": "Phí thường niên", "Statement day": "Ngày sao kê", "Payment due day": "Ngày đến hạn thanh toán",
    "Interest rate (% a year)": "Lãi suất (%/năm)", "Monthly installment": "Trả góp hằng tháng",
    "Installment fee": "Phí trả góp",
    "Date": "Ngày", "Category": "Danh mục", "Payee": "Người nhận", "Note": "Ghi chú", "Amount": "Số tiền",
    "To account": "Đến tài khoản", "Amount received": "Số tiền nhận", "Received currency": "Tiền tệ nhận",
    "Added by": "Người thêm", "Added at": "Thêm lúc", "Last edited by": "Người sửa gần nhất",
    "Last edited at": "Sửa gần nhất lúc", "Parent category": "Danh mục cha", "Kind": "Loại",
    "Archived": "Đã lưu trữ", "Period": "Kỳ", "Starts": "Bắt đầu", "Ends": "Kết thúc",
    "They owe you": "Họ nợ bạn", "You owe them": "Bạn nợ họ", "From": "Từ", "To": "Sang", "Rate": "Tỷ giá",
    "From date": "Áp dụng từ ngày", "Transaction date": "Ngày giao dịch", "Transaction time": "Giờ giao dịch",
    "Version": "Phiên bản",
    "Card": "Thẻ", "Purchase": "Khoản mua", "Months": "Số tháng", "Converted on": "Ngày chuyển trả góp",
    "First statement": "Kỳ sao kê đầu tiên", "Fee": "Phí", "Fee split into installments": "Phí chia vào từng kỳ",
    "Counts toward the limit": "Tính vào hạn mức", "Paid off early": "Tất toán sớm",
    "Action": "Thao tác", "Changed by": "Người thay đổi", "Changed at": "Thay đổi lúc", "Amounts": "Số tiền",
    "Time": "Thời gian", "What": "Mục", "Change": "Thay đổi",
    # values
    "expense": "chi tiêu", "income": "thu nhập", "refund": "hoàn tiền", "transfer": "chuyển khoản",
    "opening balance": "số dư đầu kỳ", "adjustment": "điều chỉnh",
    "cash": "tiền mặt", "checking": "tài khoản thanh toán", "savings": "tiết kiệm", "investment": "đầu tư",
    "credit card": "thẻ tín dụng", "loan": "khoản vay", "lent": "cho vay", "other asset": "tài sản khác",
    "other liability": "khoản nợ khác",
    "owner": "chủ sở hữu", "editor": "người chỉnh sửa", "viewer": "người xem", "invited": "chưa chấp nhận",
    "daily": "hằng ngày", "weekly": "hằng tuần", "monthly": "hằng tháng", "quarterly": "hằng quý",
    "yearly": "hằng năm",
    "created": "tạo", "edited": "sửa", "deleted": "xóa", "insert": "thêm", "update": "sửa", "delete": "xóa",
    "books": "sổ", "book members": "thành viên sổ", "contacts": "người liên quan", "accounts": "tài khoản",
    "categories": "danh mục", "transactions": "giao dịch", "entries": "bút toán", "budgets": "ngân sách",
    "book fx rates": "tỷ giá riêng",
    "Yes": "Có", "No": "Không",
}
LANGUAGE_NAMES = {"en": {"vi": "Vietnamese", "en": "English"}, "vi": {"vi": "Tiếng Việt", "en": "Tiếng Anh"}}


def _money(minor: int | None, minor_unit: int) -> str:
    if minor is None:
        return ""
    return str(Decimal(minor).scaleb(-minor_unit).quantize(Decimal(1).scaleb(-minor_unit)))


def _csv(rows: list[dict], headers: list[str], t=lambda s: s) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([t(h) for h in headers])
    for r in rows:
        w.writerow(["" if r.get(h) is None else r.get(h) for h in headers])
    return buf.getvalue().encode("utf-8-sig")       # BOM so Excel shows accents correctly


def _rows(db: Session, sql: str) -> list[dict]:
    return [dict(r) for r in db.execute(text(sql)).mappings()]


def build_export(db: Session) -> bytes:
    files: dict[str, bytes] = {}

    profile = _rows(db, "select * from my_profile()")
    lang = profile[0]["language"] if profile else "en"

    def t(s):
        """Translate a fixed label or value into the user's language."""
        if lang != "vi" or s is None:
            return s
        return VI.get(s, s)

    def word(s):
        """A database value like 'credit_card' or 'past_due', readable and translated."""
        return t(s.replace("_", " ")) if s else s

    def who(name):
        """book_people's 'Deleted user' / 'Deleted user 2' label, translated."""
        if lang == "vi" and name and name.startswith("Deleted user"):
            return "Người dùng đã xóa" + name[len("Deleted user"):]
        return name

    def out(name, rows, headers):
        files[name] = _csv(rows, headers, t)

    out("profile.csv", [{
        "Username": p["username"], "Name": p["display_name"], "Timezone": p["timezone"],
        "Language": LANGUAGE_NAMES[lang][p["language"]], "Account created": p["created_at"],
        "Deletion requested": p["deletion_requested_at"]} for p in profile],
        ["Username", "Name", "Timezone", "Language", "Account created", "Deletion requested"])

    members = defaultdict(list)
    for m in _rows(db, "select book_id, username, role::text as role, accepted from book_member_list order by username"):
        members[m["book_id"]].append(f"{who(m['username'])} ({word(m['role'])}"
                                     + ("" if m["accepted"] else f", {t('invited')}") + ")")
    books = _rows(db, """
        select b.id, b.name, my_book_role(b.id)::text as role, b.base_currency, b.timezone, b.created_at
          from books b order by b.name""")
    out("books.csv", [{
        "Book": b["name"], "Your role": word(b["role"]), "Main currency": b["base_currency"], "Timezone": b["timezone"],
        "Created": b["created_at"], "Members": ", ".join(members[b["id"]])} for b in books],
        ["Book", "Your role", "Main currency", "Timezone", "Created", "Members"])

    accounts = _rows(db, """
        select b.name as book, a.name, a.kind::text as kind, a.currency, a.last4, c.name as person,
               ab.balance, cur.minor_unit, a.in_net_worth, a.archived_at, a.note, a.credit_limit, a.annual_fee,
               a.statement_day, a.payment_due_day, a.interest_rate_bp, a.installment, a.installment_fee
          from accounts a join books b on b.id = a.book_id
          join account_balances ab on ab.account_id = a.id
          join currencies cur on cur.code = a.currency
          left join contacts c on c.id = a.contact_id
         order by b.name, a.name""")
    out("accounts.csv", [{
        "Book": a["book"], "Account": a["name"], "Type": word(a["kind"]), "Currency": a["currency"],
        "Last 4 digits": a["last4"], "Person": a["person"], "Balance": _money(a["balance"], a["minor_unit"]),
        "Counted in net worth": word("Yes" if a["in_net_worth"] else "No"), "Closed": a["archived_at"], "Note": a["note"],
        "Credit limit": _money(a["credit_limit"], a["minor_unit"]), "Annual fee": _money(a["annual_fee"], a["minor_unit"]),
        "Statement day": a["statement_day"], "Payment due day": a["payment_due_day"],
        "Interest rate (% a year)": _money(a["interest_rate_bp"], 2),
        "Monthly installment": _money(a["installment"], a["minor_unit"]),
        "Installment fee": _money(a["installment_fee"], a["minor_unit"])} for a in accounts],
        ["Book", "Account", "Type", "Currency", "Last 4 digits", "Person", "Balance", "Counted in net worth", "Closed", "Note",
         "Credit limit", "Annual fee", "Statement day", "Payment due day", "Interest rate (% a year)", "Monthly installment",
         "Installment fee"])

    txns = _rows(db, """
        select b.name as book, t.occurred_on, to_char(t.occurred_time, 'HH24:MI') as occurred_time, t.type::text as type,
               c.name as category, t.payee, t.note,
               uc.name as added_by, t.created_at, um.name as edited_by, t.modified_at, t.version,
               (select json_agg(json_build_object('account', a.name, 'amount', e.amount,
                                                  'currency', a.currency, 'mu', cur.minor_unit) order by e.amount)
                  from entries e join accounts a on a.id = e.account_id
                  join currencies cur on cur.code = a.currency
                 where e.transaction_id = t.id) as entries
          from transactions t join books b on b.id = t.book_id
          left join categories c on c.id = t.category_id
          left join book_people uc on uc.book_id = t.book_id and uc.user_id = t.created_by
          left join book_people um on um.book_id = t.book_id and um.user_id = t.modified_by
         order by b.name, t.occurred_on, t.occurred_time, t.created_at""")
    rows = []
    for x in txns:
        es = x["entries"] or []
        first, second = es[0] if es else {}, es[1] if len(es) > 1 else None
        rows.append({
            "Book": x["book"], "Date": x["occurred_on"], "Time": x["occurred_time"], "Type": word(x["type"]),
            "Category": x["category"], "Payee": x["payee"], "Note": x["note"],
            "Account": first.get("account"), "Amount": _money(first.get("amount"), first.get("mu", 2)),
            "Currency": first.get("currency"),
            "To account": second and second["account"],
            "Amount received": second and _money(second["amount"], second["mu"]),
            "Received currency": second and second["currency"],
            "Added by": who(x["added_by"]), "Added at": x["created_at"],
            "Last edited by": who(x["edited_by"]) if x["version"] > 1 else None,
            "Last edited at": x["modified_at"] if x["version"] > 1 else None})
    out("transactions.csv", rows, ["Book", "Date", "Time", "Type", "Category", "Payee", "Note", "Account", "Amount",
                                   "Currency", "To account", "Amount received", "Received currency",
                                   "Added by", "Added at", "Last edited by", "Last edited at"])

    categories = _rows(db, """
        select b.name as book, c.name, p.name as parent, c.kind, c.color, c.archived_at
          from categories c join books b on b.id = c.book_id left join categories p on p.id = c.parent_id
         order by 1, 3 nulls first, 2""")
    out("categories.csv", [{
        "Book": c["book"], "Category": c["name"], "Parent category": c["parent"], "Kind": word(c["kind"]),
        "Color": c["color"], "Archived": c["archived_at"]} for c in categories],
        ["Book", "Category", "Parent category", "Kind", "Color", "Archived"])

    budgets = _rows(db, """
        select b.name as book, c.name as category, bu.period::text as period, bu.amount, b.base_currency,
               cur.minor_unit, bu.starts_on, bu.ends_on
          from budgets bu join books b on b.id = bu.book_id join categories c on c.id = bu.category_id
          join currencies cur on cur.code = b.base_currency order by 1, 2""")
    out("budgets.csv", [{
        "Book": r["book"], "Category": r["category"], "Period": word(r["period"]),
        "Amount": _money(r["amount"], r["minor_unit"]), "Currency": r["base_currency"],
        "Starts": r["starts_on"], "Ends": r["ends_on"]} for r in budgets],
        ["Book", "Category", "Period", "Amount", "Currency", "Starts", "Ends"])

    plans = _rows(db, """
        select b.name as book, a.name as card, t.payee, t.occurred_on, -e.amount as amount, a.currency, cur.minor_unit,
               p.months, p.converted_on, p.first_statement, p.fee, p.fee_split, p.counts_toward_limit, p.ended_on
          from installment_plans p join books b on b.id = p.book_id join accounts a on a.id = p.account_id
          join transactions t on t.id = p.transaction_id join entries e on e.transaction_id = t.id
          join currencies cur on cur.code = a.currency order by 1, 2, t.occurred_on""")
    out("installments.csv", [{
        "Book": r["book"], "Card": r["card"], "Purchase": r["payee"], "Date": r["occurred_on"],
        "Amount": _money(r["amount"], r["minor_unit"]), "Months": r["months"], "Converted on": r["converted_on"],
        "First statement": r["first_statement"], "Fee": _money(r["fee"], r["minor_unit"]),
        "Fee split into installments": word("Yes" if r["fee_split"] else "No"),
        "Counts toward the limit": word("Yes" if r["counts_toward_limit"] else "No"), "Paid off early": r["ended_on"],
        "Currency": r["currency"]} for r in plans],
        ["Book", "Card", "Purchase", "Date", "Amount", "Months", "Converted on", "First statement", "Fee",
         "Fee split into installments", "Counts toward the limit", "Paid off early", "Currency"])

    people = _rows(db, """
        select b.name as book, c.name, c.note, cb.currency, cb.owed_to_you, cb.you_owe, cur.minor_unit
          from contacts c join books b on b.id = c.book_id
          left join contact_balances cb on cb.contact_id = c.id
          left join currencies cur on cur.code = cb.currency order by 1, 2""")
    out("people.csv", [{
        "Book": r["book"], "Name": r["name"], "Note": r["note"], "Currency": r["currency"],
        "They owe you": _money(r["owed_to_you"], r["minor_unit"] or 0) if r["currency"] else "",
        "You owe them": _money(r["you_owe"], r["minor_unit"] or 0) if r["currency"] else ""} for r in people],
        ["Book", "Name", "Note", "They owe you", "You owe them", "Currency"])

    out("exchange_rates.csv", _rows(db, """
        select b.name as "Book", r.from_currency as "From", r.to_currency as "To", r.rate as "Rate",
               r.effective_from as "From date"
          from book_fx_rates r join books b on b.id = r.book_id order by 1, 2, 3, 5"""),
        ["Book", "From", "To", "Rate", "From date"])

    history = _rows(db, """
        select b.name as book, h.snapshot->>'occurred_on' as occurred_on, left(h.snapshot->>'occurred_time', 5) as occurred_time,
               h.snapshot->>'type' as type,
               c.name as category, h.snapshot->>'payee' as payee, h.snapshot->>'note' as note,
               h.version, h.action, u.name as changed_by, h.changed_at,
               (select json_agg(json_build_object('account', a.name, 'amount', (e->>'amount')::bigint,
                                                  'currency', cur.code, 'mu', cur.minor_unit)
                                order by (e->>'amount')::bigint)
                  from jsonb_array_elements(h.snapshot->'entries') e
                  left join accounts a on a.id = (e->>'account_id')::uuid
                  left join currencies cur on cur.code = coalesce(a.currency, e->>'currency')) as entries
          from transaction_history h join books b on b.id = h.book_id
          left join categories c on c.id = (h.snapshot->>'category_id')::uuid
          left join book_people u on u.book_id = h.book_id and u.user_id = h.changed_by
         order by b.name, h.transaction_id, h.id""")

    def amounts(es):
        gone = "account since deleted" if lang != "vi" else "tài khoản đã xóa"
        return " / ".join(f"{x['account'] or gone}: {_money(x['amount'], x['mu'])} {x['currency']}" if x["currency"]
                          else str(x["amount"]) for x in es or [])
    out("edit_history.csv", [{
        "Book": h["book"], "Transaction date": h["occurred_on"], "Transaction time": h["occurred_time"],
        "Type": word(h["type"]), "Category": h["category"],
        "Payee": h["payee"], "Note": h["note"], "Version": h["version"], "Action": word(h["action"]),
        "Changed by": who(h["changed_by"]), "Changed at": h["changed_at"], "Amounts": amounts(h["entries"])}
        for h in history],
        ["Book", "Transaction date", "Transaction time", "Type", "Category", "Payee", "Note", "Version", "Action", "Changed by",
         "Changed at", "Amounts"])

    out("my_activity.csv", [{
        "Time": a["at"], "Book": a["book_name"], "What": word(a["table_name"]), "Change": t(a["action"].lower())}
        for a in _rows(db, "select at, book_name, table_name, action from my_activity()")],
        ["Time", "Book", "What", "Change"])

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", README[lang].format(created=datetime.now(timezone.utc).isoformat(timespec="seconds")))
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()
