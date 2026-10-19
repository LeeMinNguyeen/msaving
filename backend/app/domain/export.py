"""Download my data: a ZIP of readable CSV files.

GET /v1/me/export -> build_export(db) inside user_session(). Row-level security
already limits every query to the books this user is a member of.

Covers everything the user entered, everything recorded about them (profile,
memberships, plan, consents, their own activity) and what was derived from it
(balances, AI advice). Written for people, not as a schema dump: named columns, amounts as
decimals in their currency, usernames instead of ids ("Deleted user" for
purged accounts), no internal ids. In the user's language (users.language):
Vietnamese by default, or English. Only the labels are translated; what users
typed (names, payees, notes) is exported as typed.
Not included: secrets (the AI key itself; only that one exists) and other
members' emails.
"""
import csv
import io
import os
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

profile.csv          Your account: username, name, email, timezone, language, plan
books.csv            Your books, your role in each, and who else is in them
accounts.csv         Accounts in each book with their current balance
transactions.csv     Every transaction. Transfers show both accounts
categories.csv       Your categories (archived ones included and marked)
budgets.csv          Your budgets
people.csv           People you lend to or borrow from, and who owes what
exchange_rates.csv   Your books' own exchange rates
edit_history.csv     Every saved version of every transaction, and who saved it
ai_settings.csv      Whether AI advice is on in each book, and who turned it on
ai_advice.csv        AI advice you received, with exactly what was sent to the AI
ai_keys.csv          AI keys you added (only the last 4 characters; the key itself is never exported)
subscription.csv     Your paid plan, if you have one
my_activity.csv      Changes you made, with the time and book
consents.csv         What you agreed to (privacy policy version), when, and any withdrawal

Amounts are in the currency shown next to them. Negative = money out.
""", "vi": """Dữ liệu của bạn
===============

Tạo lúc: {created}

Mỗi tệp là một bảng tính (CSV, UTF-8). Bao gồm mọi sổ bạn là thành viên,
kể cả sổ người khác chia sẻ với bạn.

profile.csv          Tài khoản của bạn: tên người dùng, tên hiển thị, email, múi giờ, ngôn ngữ, gói
books.csv            Các sổ của bạn, vai trò của bạn trong từng sổ và những người khác trong sổ
accounts.csv         Các tài khoản trong từng sổ và số dư hiện tại
transactions.csv     Mọi giao dịch. Chuyển khoản hiển thị cả hai tài khoản
categories.csv       Các danh mục của bạn (kể cả danh mục đã lưu trữ, có đánh dấu)
budgets.csv          Các ngân sách của bạn
people.csv           Những người bạn cho vay hoặc vay, và ai nợ ai
exchange_rates.csv   Tỷ giá riêng của các sổ
edit_history.csv     Mọi phiên bản đã lưu của từng giao dịch, và người đã lưu
ai_settings.csv      Tư vấn AI có bật trong từng sổ không, và ai đã bật
ai_advice.csv        Lời khuyên AI bạn đã nhận, kèm chính xác dữ liệu đã gửi cho AI
ai_keys.csv          Khóa AI bạn đã thêm (chỉ 4 ký tự cuối; khóa đầy đủ không bao giờ được xuất)
subscription.csv     Gói trả phí của bạn, nếu có
my_activity.csv      Những thay đổi bạn đã thực hiện, kèm thời gian và sổ
consents.csv         Những gì bạn đã đồng ý (phiên bản chính sách quyền riêng tư), khi nào, và lần rút lại nếu có

Số tiền tính theo loại tiền ghi bên cạnh. Số âm = tiền ra.
"""}

# English label -> Vietnamese. Column headers and fixed values (types, roles,
# periods...). Anything not listed is exported as is.
VI = {
    # headers
    "Username": "Tên người dùng", "Name": "Tên", "Email": "Email", "Timezone": "Múi giờ", "Language": "Ngôn ngữ",
    "Account created": "Ngày tạo tài khoản", "Plan": "Gói", "Deletion requested": "Yêu cầu xóa lúc",
    "Book": "Sổ", "Your role": "Vai trò của bạn", "Main currency": "Tiền tệ chính", "Created": "Ngày tạo",
    "Members": "Thành viên", "Account": "Tài khoản", "Type": "Loại", "Currency": "Tiền tệ",
    "Last 4 digits": "4 số cuối", "Person": "Người liên quan", "Balance": "Số dư", "Closed": "Đã đóng",
    "Counted in net worth": "Tính vào tài sản ròng", "Color": "Màu",
    "Date": "Ngày", "Category": "Danh mục", "Payee": "Người nhận", "Note": "Ghi chú", "Amount": "Số tiền",
    "To account": "Đến tài khoản", "Amount received": "Số tiền nhận", "Received currency": "Tiền tệ nhận",
    "Added by": "Người thêm", "Added at": "Thêm lúc", "Last edited by": "Người sửa gần nhất",
    "Last edited at": "Sửa gần nhất lúc", "Parent category": "Danh mục cha", "Kind": "Loại",
    "Archived": "Đã lưu trữ", "Period": "Kỳ", "Starts": "Bắt đầu", "Ends": "Kết thúc",
    "They owe you": "Họ nợ bạn", "You owe them": "Bạn nợ họ", "From": "Từ", "To": "Sang", "Rate": "Tỷ giá",
    "From date": "Áp dụng từ ngày", "Transaction date": "Ngày giao dịch", "Version": "Phiên bản",
    "Action": "Thao tác", "Changed by": "Người thay đổi", "Changed at": "Thay đổi lúc", "Amounts": "Số tiền",
    "AI advice on": "Bật tư vấn AI", "Payee names shared": "Chia sẻ tên người nhận", "Turned on by": "Người bật",
    "Turned on at": "Bật lúc", "Paid by": "Trả phí qua", "Period start": "Đầu kỳ", "Period end": "Cuối kỳ",
    "AI model": "Mô hình AI", "Advice": "Lời khuyên", "What was sent to the AI": "Dữ liệu đã gửi cho AI",
    "Dismissed": "Đã ẩn", "Provider": "Nhà cung cấp", "Key ending": "Đuôi khóa", "Added": "Thêm lúc",
    "Status": "Trạng thái", "Paid through": "Thanh toán qua", "Renews or ends": "Gia hạn hoặc kết thúc",
    "Time": "Thời gian", "What": "Mục", "Change": "Thay đổi", "Agreed to": "Đã đồng ý",
    "Policy version": "Phiên bản chính sách", "Policy text": "Nội dung chính sách", "Agreed at": "Đồng ý lúc",
    "Withdrawn at": "Rút lại lúc",
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
    "Yes": "Có", "No": "Không", "plan": "gói", "own key": "khóa riêng", "free": "miễn phí",
    "premium": "Premium", "active": "đang hoạt động", "trialing": "dùng thử", "past due": "quá hạn",
    "canceled": "đã hủy", "Privacy policy (to use the app)": "Chính sách quyền riêng tư (để dùng ứng dụng)",
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


def build_export(db: Session, site_url: str | None = None) -> bytes:
    """site_url: the landing site, where policy texts live. Defaults to the SITE_URL setting,
    so moving to another domain changes no code or data."""
    files: dict[str, bytes] = {}
    site = (site_url if site_url is not None else os.environ.get("SITE_URL", "")).rstrip("/")

    profile = _rows(db, "select * from my_profile()")
    lang = profile[0]["language"] if profile else "vi"

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

    def yes_no(b):
        return None if b is None else t("Yes" if b else "No")

    def out(name, rows, headers):
        files[name] = _csv(rows, headers, t)

    out("profile.csv", [{
        "Username": p["username"], "Name": p["display_name"], "Email": p["email"], "Timezone": p["timezone"],
        "Language": LANGUAGE_NAMES[lang][p["language"]], "Account created": p["created_at"],
        "Plan": word(p["plan"]), "Deletion requested": p["deletion_requested_at"]} for p in profile],
        ["Username", "Name", "Email", "Timezone", "Language", "Account created", "Plan", "Deletion requested"])

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
               ab.balance, cur.minor_unit, a.in_net_worth, a.archived_at
          from accounts a join books b on b.id = a.book_id
          join account_balances ab on ab.account_id = a.id
          join currencies cur on cur.code = a.currency
          left join contacts c on c.id = a.contact_id
         order by b.name, a.name""")
    out("accounts.csv", [{
        "Book": a["book"], "Account": a["name"], "Type": word(a["kind"]), "Currency": a["currency"],
        "Last 4 digits": a["last4"], "Person": a["person"], "Balance": _money(a["balance"], a["minor_unit"]),
        "Counted in net worth": word("Yes" if a["in_net_worth"] else "No"), "Closed": a["archived_at"]} for a in accounts],
        ["Book", "Account", "Type", "Currency", "Last 4 digits", "Person", "Balance", "Counted in net worth", "Closed"])

    txns = _rows(db, """
        select b.name as book, t.occurred_on, t.type::text as type, c.name as category, t.payee, t.note,
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
         order by b.name, t.occurred_on, t.created_at""")
    rows = []
    for x in txns:
        es = x["entries"] or []
        first, second = es[0] if es else {}, es[1] if len(es) > 1 else None
        rows.append({
            "Book": x["book"], "Date": x["occurred_on"], "Type": word(x["type"]),
            "Category": x["category"], "Payee": x["payee"], "Note": x["note"],
            "Account": first.get("account"), "Amount": _money(first.get("amount"), first.get("mu", 2)),
            "Currency": first.get("currency"),
            "To account": second and second["account"],
            "Amount received": second and _money(second["amount"], second["mu"]),
            "Received currency": second and second["currency"],
            "Added by": who(x["added_by"]), "Added at": x["created_at"],
            "Last edited by": who(x["edited_by"]) if x["version"] > 1 else None,
            "Last edited at": x["modified_at"] if x["version"] > 1 else None})
    out("transactions.csv", rows, ["Book", "Date", "Type", "Category", "Payee", "Note", "Account", "Amount",
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
        select b.name as book, h.snapshot->>'occurred_on' as occurred_on, h.snapshot->>'type' as type,
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
        "Book": h["book"], "Transaction date": h["occurred_on"], "Type": word(h["type"]), "Category": h["category"],
        "Payee": h["payee"], "Note": h["note"], "Version": h["version"], "Action": word(h["action"]),
        "Changed by": who(h["changed_by"]), "Changed at": h["changed_at"], "Amounts": amounts(h["entries"])}
        for h in history],
        ["Book", "Transaction date", "Type", "Category", "Payee", "Note", "Version", "Action", "Changed by",
         "Changed at", "Amounts"])

    ai_settings = _rows(db, """
        select b.name as book, s.enabled, s.include_payees, u.name as turned_on_by, s.consented_at,
               ai_entitlement(s.book_id) as paid_by
          from ai_settings s join books b on b.id = s.book_id
          left join book_people u on u.book_id = s.book_id and u.user_id = s.consented_by
         order by 1""")
    out("ai_settings.csv", [{
        "Book": s["book"], "AI advice on": yes_no(s["enabled"]), "Payee names shared": yes_no(s["include_payees"]),
        "Turned on by": who(s["turned_on_by"]), "Turned on at": s["consented_at"], "Paid by": word(s["paid_by"])}
        for s in ai_settings], ["Book", "AI advice on", "Payee names shared", "Turned on by", "Turned on at", "Paid by"])

    out("ai_advice.csv", _rows(db, """
        select b.name as "Book", i.period_start as "Period start", i.period_end as "Period end",
               i.model as "AI model", i.advice as "Advice", i.input::text as "What was sent to the AI",
               i.created_at as "Created", i.dismissed_at as "Dismissed"
          from ai_insights i join books b on b.id = i.book_id order by 1, i.created_at"""),
        ["Book", "Period start", "Period end", "AI model", "Advice", "What was sent to the AI", "Created", "Dismissed"])

    out("ai_keys.csv", _rows(db, """
        select provider as "Provider", '...' || key_hint as "Key ending", created_at as "Added"
          from user_ai_keys order by 1"""), ["Provider", "Key ending", "Added"])

    out("subscription.csv", [{
        "Plan": word(r["plan"]), "Status": word(r["status"]), "Paid through": r["store"].replace("_", " "),
        "Renews or ends": r["current_period_end"]}
        for r in _rows(db, "select plan, status, store, current_period_end from subscriptions")],
        ["Plan", "Status", "Paid through", "Renews or ends"])

    out("my_activity.csv", [{
        "Time": a["at"], "Book": a["book_name"], "What": word(a["table_name"]), "Change": t(a["action"].lower())}
        for a in _rows(db, "select at, book_name, table_name, action from my_activity()")],
        ["Time", "Book", "What", "Change"])

    out("consents.csv", [{
        "Agreed to": t("Privacy policy (to use the app)") if c["purpose"] == "use_app" else c["purpose"],
        "Policy version": c["policy_version"], "Policy text": site + c["path"], "Agreed at": c["agreed_at"],
        "Withdrawn at": c["withdrawn_at"]}
        for c in _rows(db, """
            select c.purpose, c.policy_version, p.path, c.agreed_at, c.withdrawn_at
              from consents c join policy_versions p on p.version = c.policy_version
             order by c.agreed_at""")],
        ["Agreed to", "Policy version", "Policy text", "Agreed at", "Withdrawn at"])

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", README[lang].format(created=datetime.now(timezone.utc).isoformat(timespec="seconds")))
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()
