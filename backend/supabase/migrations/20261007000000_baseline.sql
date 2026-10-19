-- Baseline: the whole schema as designed on 2026-10-07 (PostgreSQL 15+, Supabase).
-- Until the first push to dev this file is edited directly. Once it has
-- reached dev or prod, never edit it again; add a new migration instead.
-- Balances are never stored: an account's balance is SUM(entries.amount).
-- Amounts are signed integers in minor units (cents). Never use float.
--
-- Access model: everything lives in a book, and a book has members. What a
-- user can see or change is decided by their role in that book (owner,
-- editor, viewer), enforced by row-level security in the database itself.
--
-- Errors the user can cause start with a code ('plan_limit: ...'). The API
-- shows a message in the user's language for the code; the English text after
-- it is for developers.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Users
-- The profile, keyed by the Supabase Auth user id. No password lives here.
-- ---------------------------------------------------------------------------
create table users (
  id            uuid primary key default gen_random_uuid(),
  -- Unique handle used to add someone to a book. Stored lowercase so "Nguyin"
  -- and "nguyin" can't both exist; the app lowercases input before saving.
  -- Null only once the account is purged, which frees it for someone new.
  username      text unique
                check (username ~ '^[a-z0-9][a-z0-9_.]{2,29}$'),
  display_name  text,
  email         text unique,                          -- private: never shown to other users
  timezone      text not null default 'UTC',          -- IANA name; the app sends it as a new book's timezone
  -- App, email and export language. Vietnamese first, English second (Nguyin).
  language      text not null default 'vi' check (language in ('vi', 'en')),
  created_at    timestamptz not null default now(),
  deletion_requested_at timestamptz,                  -- set = account closed, restorable for 30 days (see end of file)
  -- Set = purged for good. The row stays as a bare id so shared books can show
  -- "Deleted user" against what they did, and tell two deleted users apart.
  deleted_at    timestamptz,
  check ((deleted_at is null and username is not null and email is not null)
      or (deleted_at is not null and username is null and email is null and display_name is null))
);

-- ---------------------------------------------------------------------------
-- Currencies (ISO 4217). minor_unit is the number of decimals: USD 2, JPY 0,
-- KWD 3. Needed to convert amounts stored in minor units between currencies.
-- The baseline loads these 9; 20261008043413_iso_4217_currencies.sql adds the
-- rest of the ISO 4217 list.
-- ---------------------------------------------------------------------------
create table currencies (
  code        char(3) primary key,
  minor_unit  smallint not null check (minor_unit between 0 and 4),
  name        text not null
);
insert into currencies values
  ('USD', 2, 'US dollar'), ('EUR', 2, 'Euro'), ('GBP', 2, 'Pound sterling'),
  ('JPY', 0, 'Yen'), ('VND', 0, 'Dong'), ('AUD', 2, 'Australian dollar'),
  ('CAD', 2, 'Canadian dollar'), ('SGD', 2, 'Singapore dollar'), ('KWD', 3, 'Kuwaiti dinar');

-- ---------------------------------------------------------------------------
-- Books: separate sets of accounts ("Personal", "Household", "Side business").
-- Accounts, categories and transactions all live in exactly one book, and
-- nothing can reference across books.
-- ---------------------------------------------------------------------------
create table books (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid not null references users(id),   -- whose plan the book counts against; moves to another owner if they leave
  name          text not null,
  base_currency char(3) not null references currencies(code),  -- chosen at setup; default for new accounts and the currency totals are reported in
  auto_fx       boolean not null default true,       -- use the automatically updated market rates
  timezone      text not null default 'UTC',         -- when a day/week/month starts for this book's budgets
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  version       int not null default 1
);

-- ---------------------------------------------------------------------------
-- Book members
--   owner:  everything, including members, settings and deleting the book
--   editor: add, edit and delete accounts, categories, people, transactions,
--           budgets and the book's own exchange rates; dismiss or delete AI advice
--   viewer: read only
-- A member added by an owner is pending (accepted_at null) and sees nothing
-- of the book until they accept. A book always keeps at least one owner.
-- ---------------------------------------------------------------------------
create type book_role as enum ('owner', 'editor', 'viewer');

create table book_members (
  book_id      uuid not null references books(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         book_role not null,
  invited_by   uuid references users(id) on delete set null,
  invited_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  primary key (book_id, user_id)
);
create index book_members_user_idx on book_members (user_id);

-- The current request's user, set per DB transaction by the API (app/core/db.py).
create function current_app_user() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- The current user's role in a book, or null if they aren't an accepted
-- member. security definer so policies can call it without recursing into
-- book_members' own policies.
create function my_book_role(p_book uuid) returns book_role
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select m.role from book_members m
    join users u on u.id = m.user_id
   where m.book_id = p_book and m.user_id = current_app_user() and m.accepted_at is not null
     and u.deletion_requested_at is null      -- a closed account sees no book data
$$;

create function can_read_book(p_book uuid) returns boolean
language sql stable as $$ select my_book_role(p_book) is not null $$;

create function can_write_book(p_book uuid) returns boolean
language sql stable as $$ select coalesce(my_book_role(p_book) in ('owner', 'editor'), false) $$;

create function is_book_owner(p_book uuid) returns boolean
language sql stable as $$ select coalesce(my_book_role(p_book) = 'owner', false) $$;

-- The creator becomes the first owner automatically.
create function add_creator_as_owner() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into book_members (book_id, user_id, role, invited_by, accepted_at)
  values (new.id, new.created_by, 'owner', new.created_by, now());
  return null;
end $$;

create trigger books_add_owner after insert on books
  for each row execute function add_creator_as_owner();

-- Never leave a book without an accepted owner (unless the book itself is
-- being deleted).
create function keep_an_owner() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.role = 'owner' and old.accepted_at is not null
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from books where id = old.book_id)
     and not exists (select 1 from book_members
                      where book_id = old.book_id and user_id <> old.user_id
                        and role = 'owner' and accepted_at is not null) then
    raise exception 'owner_required: a book needs at least one owner; make someone else owner first';
  end if;
  return coalesce(new, old);
end $$;

create trigger book_members_keep_owner before update or delete on book_members
  for each row execute function keep_an_owner();

-- When the creator leaves or stops being an owner, the book moves to the
-- longest-standing remaining owner (open accounts first): plan limits and the
-- shared-book count follow the book to them. keep_an_owner() guarantees one.
create function move_book_creator() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from books where id = old.book_id and created_by = old.user_id) then
    update books set created_by = (
      select m.user_id from book_members m join users u on u.id = m.user_id
       where m.book_id = old.book_id and m.user_id <> old.user_id
         and m.role = 'owner' and m.accepted_at is not null
       order by (u.deletion_requested_at is null) desc, m.accepted_at, m.user_id
       limit 1)
     where id = old.book_id;
  end if;
  return null;
end $$;

create trigger book_members_move_creator after update of role or delete on book_members
  for each row execute function move_book_creator();

-- Invitations, without exposing anything else about other users or books.
-- Find a user to invite by exact username. Returns only the id.
create function find_user_by_username(p_username text) returns uuid
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select id from users where username = lower(p_username)
$$;

-- Books I've been invited to and haven't answered yet.
create function my_pending_invites()
returns table (book_id uuid, book_name text, role book_role, invited_by_username text, invited_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select m.book_id, b.name, m.role,
         case when u.deleted_at is null then u.username else 'Deleted user' end, m.invited_at
    from book_members m
    join books b on b.id = m.book_id
    left join users u on u.id = m.invited_by
   where m.user_id = current_app_user() and m.accepted_at is null
$$;

create function accept_invite(p_book uuid) returns void
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  update book_members set accepted_at = now()
   where book_id = p_book and user_id = current_app_user() and accepted_at is null
$$;

-- Users I share at least one book with (to show "added by tuan" etc.).
create function shares_a_book_with(p_user uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from book_members a
    join book_members b on b.book_id = a.book_id
   where a.user_id = current_app_user() and a.accepted_at is not null
     and b.user_id = p_user)
$$;

-- ---------------------------------------------------------------------------
-- Accounts
-- Asset kinds hold money you own (positive balance).
-- Liability kinds (credit_card, loan, other_liability) hold money you owe (negative balance).
-- Net worth = SUM of all balances, no special casing needed.
--   loan  = money you borrowed (liability, negative balance), from a bank or a person
--   lent  = money you lent to someone (asset, positive balance: they owe you)
-- ---------------------------------------------------------------------------
create type account_kind as enum
  ('cash', 'checking', 'savings', 'investment', 'credit_card', 'loan', 'lent', 'other_asset', 'other_liability');

-- ---------------------------------------------------------------------------
-- Contacts: people (or lenders) the book lends to or borrows from.
-- Kept deliberately minimal: a name and an optional note. These are third
-- parties who never agreed to be in the app, so store no phone, email or
-- ID numbers unless you have a feature that needs them.
-- ---------------------------------------------------------------------------
create table contacts (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references books(id) on delete cascade,
  name         text not null,
  note         text,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  version      int not null default 1,
  unique (id, book_id),
  unique (book_id, name)
);

create table accounts (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references books(id) on delete cascade,
  name         text not null,
  kind         account_kind not null,
  currency     char(3) not null references currencies(code),  -- omitted on insert => the book's base_currency; locked once used
  last4        char(4),                              -- never store full account/card numbers
  contact_id   uuid,                                 -- who you borrowed from / lent to (loan and lent only)
  archived_at  timestamptz,                          -- hide closed accounts, keep history
  -- Off = left out of the book's net worth (shown greyed out), e.g. money held
  -- for someone else. Its transactions still count as spending and income.
  -- From the old BudgetTracking app ("include in dashboard", V0.1.1).
  in_net_worth boolean not null default true,
  created_at   timestamptz not null default now(),
  version      int not null default 1,
  unique (id, book_id),                              -- target for same-book FKs
  unique (book_id, name),
  foreign key (contact_id, book_id) references contacts(id, book_id),
  check (contact_id is null or kind in ('loan', 'lent'))
);
create index accounts_contact_idx on accounts (contact_id);

-- New accounts take the book's currency unless one is given. An account's
-- currency can't change once it has entries: its amounts are stored in that
-- currency, so relabelling them would silently change their value.
create function account_currency() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.currency is null then
    select base_currency into new.currency from books where id = new.book_id;
  elsif tg_op = 'UPDATE' and new.currency is distinct from old.currency
        and exists (select 1 from entries where account_id = old.id) then
    raise exception 'currency_locked: account % already has transactions; its currency can''t change', old.id;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Categories (per book, optional nesting: "Food" > "Groceries")
--   expense, income: what money was spent on or came from
--   transfer:        a label for a transfer only ("Savings", "Debt repayment");
--                    never spending or income, never budgeted (Nguyin 18:29)
-- ---------------------------------------------------------------------------
create table categories (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references books(id) on delete cascade,
  parent_id  uuid,
  name       text not null,
  kind       text not null check (kind in ('expense', 'income', 'transfer')),
  -- Archived = hidden from pickers and lists. Its transactions keep it and
  -- still count in reports; unarchive to use it again. Same as accounts.
  archived_at timestamptz,
  -- Display colour from a preset grid, lowercase #rrggbb; null = the app's default.
  color      text check (color ~ '^#[0-9a-f]{6}$'),
  version    int not null default 1,
  unique (id, book_id),
  unique nulls not distinct (book_id, parent_id, name),
  foreign key (parent_id, book_id) references categories(id, book_id)
);

-- ---------------------------------------------------------------------------
-- Transactions (the header) and entries (the money movement)
--
--   expense          1 entry, amount < 0         e.g. -1250 on Checking
--   income           1 entry, amount > 0         e.g. +500000 on Checking
--   refund           1 entry, amount > 0; the app gives it an expense category
--                    (expense and income kinds aren't enforced per type;
--                    opening balances can't have a category at all, and a
--                    transfer can only have a transfer category)
--   transfer         2 entries on different accounts, one < 0 and one > 0;
--                    same currency => they must sum to 0
--                    (paying a credit card = transfer Checking -> Credit card)
--   opening_balance  1 entry, any sign: the starting balance of an account,
--                    so balances stay purely derived from history
--   adjustment       1 entry, any sign: reconcile to a bank statement
-- ---------------------------------------------------------------------------
create type txn_type as enum
  ('expense', 'income', 'refund', 'transfer', 'opening_balance', 'adjustment');

create table transactions (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references books(id) on delete cascade,
  type         txn_type not null,
  occurred_on  date not null,
  category_id  uuid,
  payee        text,
  note         text,
  created_by   uuid references users(id) on delete set null default current_app_user(),
  modified_by  uuid references users(id) on delete set null default current_app_user(),
  created_at   timestamptz not null default now(),
  modified_at  timestamptz not null default now(),  -- last edit; set by bump_version()
  version      int not null default 1,              -- optimistic concurrency, see bump_version()
  unique (id, book_id),
  foreign key (category_id, book_id) references categories(id, book_id),
  check (type <> 'opening_balance' or category_id is null)
);

create table entries (
  id              uuid primary key default gen_random_uuid(),
  book_id         uuid not null,
  transaction_id  uuid not null,
  account_id      uuid not null,
  amount          bigint not null check (amount <> 0),   -- minor units, signed
  -- Composite FKs: an entry can only point at a transaction and an account
  -- in the same book. A bug in app code cannot cross books.
  foreign key (transaction_id, book_id) references transactions(id, book_id) on delete cascade,
  -- Deferred so deleting a whole book (which cascades through transactions)
  -- succeeds, while deleting one account that still has entries is refused.
  -- Close accounts with archived_at instead.
  foreign key (account_id, book_id)     references accounts(id, book_id)
    deferrable initially deferred
);

create index entries_account_idx     on entries (account_id);
create index entries_transaction_idx on entries (transaction_id);
create index transactions_book_date_idx on transactions (book_id, occurred_on desc);
create index transactions_category_idx on transactions (book_id, category_id, occurred_on desc);   -- list filtered by category

-- Transfer categories go on transfers and nothing else, so a label like
-- "Savings" can never turn into spending, and an expense category can't hide
-- a transfer. A used category can't switch to or from the transfer kind.
create function transaction_category_kind() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.category_id is not null
     and ((select kind from categories where id = new.category_id) = 'transfer') <> (new.type = 'transfer') then
    raise exception 'category_kind: a transfer needs a transfer category, and only a transfer can have one';
  end if;
  return new;
end $$;

create trigger transactions_category_kind before insert or update of type, category_id on transactions
  for each row execute function transaction_category_kind();

create function category_kind_locked() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.kind = 'transfer') <> (old.kind = 'transfer')
     and exists (select 1 from transactions where category_id = old.id) then
    raise exception 'category_kind: category % is used by transactions; it can''t switch to or from the transfer kind', old.id;
  end if;
  return new;
end $$;

create trigger categories_kind_locked before update of kind on categories
  for each row execute function category_kind_locked();
create index accounts_book_idx on accounts (book_id);

create trigger accounts_currency
  before insert or update of currency on accounts
  for each row execute function account_currency();

-- ---------------------------------------------------------------------------
-- Shape rules per transaction type, checked at COMMIT so the app can insert
-- the header and its entries in one DB transaction in any order.
-- ---------------------------------------------------------------------------
-- security definer: it only validates, and it must also run at commit inside
-- jobs (like the account purge) whose login has no table access.
create function check_transaction_shape(t_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  t_type txn_type;
  n int; n_neg int; n_pos int; n_accts int; n_ccy int; total bigint;
begin
  select type into t_type from transactions where id = t_id;
  if t_type is null then return; end if;                -- header deleted (cascade)

  select count(*),
         count(*) filter (where e.amount < 0),
         count(*) filter (where e.amount > 0),
         count(distinct e.account_id),
         count(distinct a.currency),
         sum(e.amount)
    into n, n_neg, n_pos, n_accts, n_ccy, total
    from entries e join accounts a on a.id = e.account_id
   where e.transaction_id = t_id;

  if t_type = 'transfer' then
    if n <> 2 or n_neg <> 1 or n_pos <> 1 or n_accts <> 2 then
      raise exception 'txn_shape: transfer % needs one outflow and one inflow on two different accounts', t_id;
    end if;
    if n_ccy = 1 and total <> 0 then
      raise exception 'txn_shape: same-currency transfer % must sum to 0 (got %)', t_id, total;
    end if;
  elsif n <> 1 then
    raise exception 'txn_shape: % transaction % needs exactly 1 entry (got %)', t_type, t_id, n;
  elsif t_type = 'expense' and n_neg <> 1 then
    raise exception 'txn_shape: expense % must be negative', t_id;
  elsif t_type in ('income', 'refund') and n_pos <> 1 then
    raise exception 'txn_shape: % % must be positive', t_type, t_id;
  end if;
end $$;

create function entries_shape_trg() returns trigger
language plpgsql as $$
begin
  perform check_transaction_shape(coalesce(new.transaction_id, old.transaction_id));
  if tg_op = 'UPDATE' and new.transaction_id <> old.transaction_id then
    perform check_transaction_shape(old.transaction_id);
  end if;
  return null;
end $$;

create function transactions_shape_trg() returns trigger
language plpgsql as $$
begin
  perform check_transaction_shape(new.id);
  return null;
end $$;

create constraint trigger entries_shape
  after insert or update or delete on entries
  deferrable initially deferred
  for each row execute function entries_shape_trg();

-- Also fires for a header with no entries at all, and when a header's type changes.
create constraint trigger transactions_shape
  after insert or update of type on transactions
  deferrable initially deferred
  for each row execute function transactions_shape_trg();

-- ---------------------------------------------------------------------------
-- Several devices or members at once: optimistic concurrency.
-- Books, accounts, people, categories, transactions, budgets and the book's
-- own exchange rates have a version (profile, member roles and AI settings
-- are last-write-wins). The API updates them with
--     ... where id = :id and version = :version_the_client_saw
-- and returns 409 Conflict when 0 rows match (someone else changed it first).
-- The trigger bumps the version on every update so no code path can forget.
-- Editing a transaction's entries always goes through an update of its header
-- in the same DB transaction, so the header's version guards the entries too.
-- ---------------------------------------------------------------------------
create function bump_version() returns trigger
language plpgsql as $$
begin
  -- Changing only created_by/modified_by isn't an edit.
  if tg_table_name = 'transactions'
     and (to_jsonb(new) - 'created_by' - 'modified_by') = (to_jsonb(old) - 'created_by' - 'modified_by') then
    return new;
  end if;
  new.version := old.version + 1;
  if tg_table_name = 'transactions' then
    new.modified_at := now();
    new.modified_by := current_app_user();
  end if;
  return new;
end $$;

create trigger books_version        before update on books        for each row execute function bump_version();
create trigger accounts_version     before update on accounts     for each row execute function bump_version();
create trigger contacts_version     before update on contacts     for each row execute function bump_version();
create trigger categories_version   before update on categories   for each row execute function bump_version();
create trigger transactions_version before update on transactions for each row execute function bump_version();

-- ---------------------------------------------------------------------------
-- Transaction edit history: one full snapshot (header + entries) per version,
-- written when the DB transaction commits, so it shows the transaction exactly
-- as saved, and who saved it. A delete adds a final 'deleted' row. History
-- rows have no foreign key to transactions, so they survive the transaction's
-- deletion; they go away only with the whole book. Members can read history;
-- nobody can write it except this trigger.
-- ---------------------------------------------------------------------------
create table transaction_history (
  id              bigint generated always as identity primary key,
  book_id         uuid not null references books(id) on delete cascade,
  transaction_id  uuid not null,
  version         int not null,
  action          text not null check (action in ('created', 'edited', 'deleted')),
  snapshot        jsonb not null,          -- header fields + entries [{account_id, amount, currency}]
  changed_by      uuid,                    -- the member who made this change
  changed_at      timestamptz not null default now(),
  unique (transaction_id, version, action)
);
create index transaction_history_txn_idx on transaction_history (transaction_id, version);

create function record_transaction_history() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  t transactions;
begin
  if tg_op = 'DELETE' then
    -- The whole book is being deleted: nothing to keep.
    if not exists (select 1 from books where id = old.book_id) then return null; end if;
    insert into transaction_history (book_id, transaction_id, version, action, snapshot, changed_by)
    values (old.book_id, old.id, old.version, 'deleted', to_jsonb(old), current_app_user())
    on conflict do nothing;
    return null;
  end if;

  -- Deferred to commit: read the row as finally saved, with its entries.
  select * into t from transactions where id = new.id;
  if not found then return null; end if;   -- created and deleted in the same DB transaction
  insert into transaction_history (book_id, transaction_id, version, action, snapshot, changed_by)
  values (t.book_id, t.id, t.version,
          case when t.version = 1 then 'created' else 'edited' end,
          to_jsonb(t) || jsonb_build_object('entries',
            (select coalesce(jsonb_agg(jsonb_build_object('account_id', e.account_id, 'amount', e.amount,
                                                          'currency', a.currency)
                                       order by e.amount), '[]'::jsonb)
               from entries e join accounts a on a.id = e.account_id where e.transaction_id = t.id)),
          t.modified_by)
  on conflict do nothing;                  -- one snapshot per version
  return null;
end $$;

create constraint trigger transactions_history
  after insert or update on transactions
  deferrable initially deferred
  for each row execute function record_transaction_history();

create trigger transactions_history_delete
  after delete on transactions
  for each row execute function record_transaction_history();

-- ---------------------------------------------------------------------------
-- Balances: always derived. A view, not a column.
-- ---------------------------------------------------------------------------
create view account_balances with (security_invoker = true) as
select a.id as account_id, a.book_id, a.name, a.kind, a.currency, a.in_net_worth,
       coalesce(sum(e.amount), 0)::bigint as balance  -- bigint so Python gets int, not Decimal
  from accounts a
  left join entries e on e.account_id = a.id
 group by a.id;

-- Who owes what, per person, in each account's own currency.
--   owed_to_you: what they still owe the book (sum of 'lent' balances)
--   you_owe:     what the book still owes them (sum of 'loan' balances, as a positive number)
create view contact_balances with (security_invoker = true) as
select c.id as contact_id, c.book_id, c.name, ab.currency,
       coalesce(sum(ab.balance) filter (where ab.kind = 'lent'), 0)::bigint  as owed_to_you,
       coalesce(-sum(ab.balance) filter (where ab.kind = 'loan'), 0)::bigint as you_owe
  from contacts c
  join accounts a on a.contact_id = c.id
  join account_balances ab on ab.account_id = a.id
 group by c.id, c.book_id, c.name, ab.currency;

-- Members of the books I'm in, with usernames (never emails).
create view book_member_list with (security_invoker = true) as
select m.book_id, m.user_id, u.username, u.display_name, m.role,
       m.accepted_at is not null as accepted, m.invited_at
  from book_members m
  join users u on u.id = m.user_id;

-- ---------------------------------------------------------------------------
-- Audit log: who changed what, written by trigger, readable by the book's
-- owners, never editable by the app role.
-- ---------------------------------------------------------------------------
create table audit_log (
  id          bigint generated always as identity primary key,
  book_id     uuid,                       -- no FK: rows written while a book is deleted mustn't block it
  actor_id    uuid,                       -- the user whose request made the change
  table_name  text not null,
  row_id      text not null,
  action      text not null,              -- INSERT / UPDATE / DELETE
  old_row     jsonb,
  new_row     jsonb,
  at          timestamptz not null default now()
);
create index audit_log_book_idx on audit_log (book_id, at);

create function write_audit() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  j jsonb := coalesce(to_jsonb(new), to_jsonb(old));
begin
  insert into audit_log (book_id, actor_id, table_name, row_id, action, old_row, new_row)
  values (coalesce(j->>'book_id', case when tg_table_name = 'books' then j->>'id' end)::uuid,
          current_app_user(), tg_table_name,
          coalesce(j->>'id', (j->>'book_id') || '/' || (j->>'user_id')),
          tg_op, to_jsonb(old), to_jsonb(new));
  return null;
end $$;

create trigger audit_books        after insert or update or delete on books        for each row execute function write_audit();
create trigger audit_book_members after insert or update or delete on book_members for each row execute function write_audit();
create trigger audit_contacts     after insert or update or delete on contacts     for each row execute function write_audit();
create trigger audit_accounts     after insert or update or delete on accounts     for each row execute function write_audit();
create trigger audit_categories   after insert or update or delete on categories   for each row execute function write_audit();
create trigger audit_transactions after insert or update or delete on transactions for each row execute function write_audit();
create trigger audit_entries      after insert or update or delete on entries      for each row execute function write_audit();

-- Deleting a book deletes everything in it, its audit rows included. Runs at
-- commit, once the cascades have written their own audit rows.
create function delete_book_audit() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from audit_log where book_id = old.id;
  return null;
end $$;
create constraint trigger books_delete_audit after delete on books
  deferrable initially deferred for each row execute function delete_book_audit();

-- ---------------------------------------------------------------------------
-- Row-level security: the database itself refuses access outside your books.
-- The app connects as app_user (not the table owner, no BYPASSRLS) and sets
-- the current user per request inside the DB transaction (app/core/db.py).
-- ---------------------------------------------------------------------------
alter table users        enable row level security;
alter table books        enable row level security;
alter table book_members enable row level security;
alter table contacts     enable row level security;
alter table accounts     enable row level security;
alter table categories   enable row level security;
alter table transactions enable row level security;
alter table entries      enable row level security;
alter table audit_log    enable row level security;
alter table transaction_history enable row level security;

-- Users: yourself, plus people you share a book with (username only is
-- exposed to them through book_member_list; the API never returns email).
create policy self_read   on users for select using (id = current_app_user() or shares_a_book_with(id));
create policy self_insert on users for insert with check (id = current_app_user());
create policy self_update on users for update using (id = current_app_user()) with check (id = current_app_user());

-- Books
-- No RETURNING on insert: the creator only becomes a member when the
-- statement ends. The API makes book ids itself.
create policy members_read  on books for select using (can_read_book(id));
create policy create_own    on books for insert with check (created_by = current_app_user());
create policy owners_update on books for update using (is_book_owner(id)) with check (is_book_owner(id));
create policy owners_delete on books for delete using (is_book_owner(id));

-- Members: members see the member list; you see your own pending invite;
-- owners invite, change roles and remove; anyone can leave or decline.
-- (Accepting goes through accept_invite() so nobody can edit their own role.
-- Owners may change only the role column, so nobody can be made a member
-- without accepting.)
create policy members_read   on book_members for select using (can_read_book(book_id) or user_id = current_app_user());
create policy owners_invite  on book_members for insert
  with check (is_book_owner(book_id) and accepted_at is null and invited_by = current_app_user());
create policy owners_update  on book_members for update using (is_book_owner(book_id)) with check (is_book_owner(book_id));
create policy owners_or_self_remove on book_members for delete using (is_book_owner(book_id) or user_id = current_app_user());

-- Everything inside a book: members read, owners and editors write.
do $$
declare t text;
begin
  foreach t in array array['contacts', 'accounts', 'categories', 'transactions', 'entries'] loop
    execute format('create policy members_read on %I for select using (can_read_book(book_id))', t);
    execute format('create policy editors_insert on %I for insert with check (can_write_book(book_id))', t);
    execute format('create policy editors_update on %I for update using (can_write_book(book_id)) with check (can_write_book(book_id))', t);
    execute format('create policy editors_delete on %I for delete using (can_write_book(book_id))', t);
  end loop;
end $$;

create policy owners_read  on audit_log for select using (book_id is not null and is_book_owner(book_id));
create policy members_read on transaction_history for select using (can_read_book(book_id));

-- Least-privilege application role.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;   -- grant to a login role, or set a password, at deploy time
  end if;
end $$;

grant usage on schema public to app_user;
-- Column grants: email is write-only for the app, so a co-member's email can't
-- be read even though their row is visible. The API takes the user's own
-- email from the verified login token.
grant select (id, username, display_name, timezone, language, created_at) on users to app_user;
grant insert (id, username, display_name, email, timezone, language) on users to app_user;
grant update (username, display_name, email, timezone, language) on users to app_user;
-- Columns the database sets itself (who created or edited something, versions,
-- the book's plan holder) are left out of the insert and update grants, so the
-- app can't forge them.
grant select, insert, update, delete on contacts, accounts, categories, entries to app_user;
grant select, delete on books, transactions to app_user;
grant insert (id, created_by, name, base_currency, auto_fx, timezone) on books to app_user;   -- created_by: checked = the user
grant update (name, base_currency, auto_fx, timezone, archived_at) on books to app_user;
grant insert (id, book_id, type, occurred_on, category_id, payee, note) on transactions to app_user;
grant update (type, occurred_on, category_id, payee, note) on transactions to app_user;
grant select, insert, delete on book_members to app_user;
grant update (role) on book_members to app_user;
grant select on currencies to app_user;
grant select on account_balances, contact_balances, book_member_list, audit_log, transaction_history to app_user;
grant execute on function find_user_by_username(text), my_pending_invites(), accept_invite(uuid) to app_user;
-- No insert/update/delete on audit_log or transaction_history: only triggers write them.

-- ---------------------------------------------------------------------------
-- Plans and subscriptions
--
-- Every user is on 'free' unless they have a current paid subscription.
-- subscriptions is written only by the payment webhook (billing_webhook role),
-- never by the app, so nobody can grant themselves a plan from the app.
-- Limits live in the plans table and are enforced by triggers, so changing
-- what's free is an UPDATE, not a code change:
--   ai_included           AI advice with the app's own AI key
--   max_books             books a user can create (null = unlimited)
--   max_members_per_book  people per book, owner included (null = unlimited)
--   max_shared_books      books the user created that have other people in
--                         them (null = unlimited). Free: 1. Joining someone
--                         else's book is always free and never counts.
-- Books and sharing count against the plan of books.created_by: the creator,
-- or the owner the book moved to when the creator left.
-- Exchange rates are free for everyone and not gated.
-- ---------------------------------------------------------------------------
create table plans (
  code                  text primary key,
  ai_included           boolean not null,
  max_books             int check (max_books > 0),
  max_members_per_book  int check (max_members_per_book > 0),
  max_shared_books      int check (max_shared_books >= 0)
);
insert into plans values ('free', false, null, null, 1), ('premium', true, null, null, null);

create table subscriptions (
  user_id                 uuid primary key references users(id) on delete cascade,
  plan                    text not null references plans(code),
  status                  text not null check (status in ('active', 'trialing', 'past_due', 'canceled')),
  store                   text not null check (store in ('stripe', 'app_store', 'google_play')),
  store_subscription_id   text not null unique,
  current_period_end      timestamptz not null,
  updated_at              timestamptz not null default now()
);

-- The plan a user is on right now.
create function user_plan(p_user uuid) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(
    (select plan from subscriptions
      where user_id = p_user and status in ('active', 'trialing') and current_period_end > now()),
    'free')
$$;

create function plan_limits_for(p_user uuid) returns plans
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select * from plans where code = user_plan(p_user)
$$;

create function enforce_book_limit() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare lim int := (plan_limits_for(new.created_by)).max_books;
begin
  if lim is not null and (select count(*) from books where created_by = new.created_by) >= lim then
    raise exception 'plan_limit: your plan allows % books', lim;
  end if;
  return new;
end $$;

create function enforce_member_limit() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  creator uuid := (select created_by from books where id = new.book_id);
  lim plans := plan_limits_for(creator);
  members int := (select count(*) from book_members where book_id = new.book_id);
begin
  if lim.max_members_per_book is not null and members >= lim.max_members_per_book then
    raise exception 'plan_limit: this book''s plan allows % people', lim.max_members_per_book;
  end if;
  -- Inviting the first other person turns a private book into a shared one.
  -- (members = 0 is the creator's own owner row being added.)
  if members >= 1 and lim.max_shared_books is not null
     and not exists (select 1 from book_members where book_id = new.book_id and user_id <> creator)
     and (select count(*) from books b
           where b.created_by = creator and b.id <> new.book_id
             and exists (select 1 from book_members m where m.book_id = b.id and m.user_id <> creator))
         >= lim.max_shared_books then
    raise exception 'plan_limit: your plan includes % shared book(s); upgrade to share more', lim.max_shared_books;
  end if;
  return new;
end $$;

create trigger books_plan_limit before insert on books
  for each row execute function enforce_book_limit();
create trigger book_members_plan_limit before insert on book_members
  for each row execute function enforce_member_limit();

alter table subscriptions enable row level security;
create policy own_read on subscriptions for select to app_user using (user_id = current_app_user());

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'billing_webhook') then
    create role billing_webhook nologin;
  end if;
end $$;
create policy webhook_all on subscriptions for all to billing_webhook using (true) with check (true);
grant usage on schema public to billing_webhook;
grant select, insert, update, delete on subscriptions to billing_webhook;
-- An unknown user id in the payment metadata fails the foreign key, and a
-- purged one fails this check (a renewal arriving after the purge).
create function subscription_user_exists() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from users where id = new.user_id and deleted_at is not null) then
    raise exception 'account_deleted: no subscription for a deleted account';
  end if;
  return new;
end $$;
create trigger subscriptions_user_exists before insert or update on subscriptions
  for each row execute function subscription_user_exists();

grant select on plans, subscriptions to app_user;

-- ---------------------------------------------------------------------------
-- Bring your own AI key (free plan)
-- A user can store their own key for an AI provider. It is encrypted by the
-- backend (app/domain/ai_keys.py) with a key that never enters the database, so
-- the database, its backups and anyone with SQL access only see ciphertext.
-- The app can store, replace and delete a key and see its last 4 characters,
-- but never read it back. Only the AI job can fetch the ciphertext, for a book
-- that has AI turned on with that key.
-- ---------------------------------------------------------------------------
create table user_ai_keys (
  user_id         uuid not null references users(id) on delete cascade,
  provider        text not null check (provider ~ '^[a-z0-9_-]{2,30}$'),   -- e.g. 'anthropic', 'openai'
  key_ciphertext  bytea not null,
  key_hint        text not null,              -- last 4 characters, for "sk-...a1b2"
  created_at      timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table user_ai_keys enable row level security;
create policy own_rows on user_ai_keys using (user_id = current_app_user()) with check (user_id = current_app_user());
grant select (user_id, provider, key_hint, created_at) on user_ai_keys to app_user;
grant insert (user_id, provider, key_ciphertext, key_hint) on user_ai_keys to app_user;
grant update (key_ciphertext, key_hint) on user_ai_keys to app_user;
grant delete on user_ai_keys to app_user;

-- ---------------------------------------------------------------------------
-- AI spending advice
--
-- The model never touches these tables. A backend job, connected as
-- ai_reader, reads the summary views below for one book (with app.user_id set
-- to a member), sends that summary to the model, and stores the advice in
-- ai_insights. ai_reader has no access to any base table, so it cannot see
-- raw transactions, notes, account names or last4, and cannot write money data.
-- In a shared book only an owner can turn AI on, since it covers everyone's
-- entries.
-- AI is a paid feature: it runs on the plan of the owner who turned it on
-- (the app's key is used), or else with that owner's own AI key. Checked when
-- it's turned on and on every run, so it stops if the subscription lapses, the
-- key is deleted, or that owner leaves the book, stops being an owner or
-- closes their account.
-- ---------------------------------------------------------------------------
create table ai_settings (
  book_id         uuid primary key references books(id) on delete cascade,
  enabled         boolean not null default false,  -- opt-in per book
  include_payees  boolean not null default false,  -- payee names are more identifying than categories
  consented_by    uuid references users(id) on delete set null default current_app_user(),
  consented_at    timestamptz,
  key_provider    text                             -- with own key: which of consented_by's keys to use
);

-- How AI is paid for in a book right now: 'plan', 'own_key', or null (off).
-- The owner who turned AI on pays for it: through their plan, or their own key.
create function ai_entitlement(p_book uuid) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case
    when not s.enabled then null
    when not exists (select 1 from book_members m join users u on u.id = m.user_id
                      where m.book_id = s.book_id and m.user_id = s.consented_by and m.role = 'owner'
                        and m.accepted_at is not null and u.deletion_requested_at is null) then null
    when (plan_limits_for(s.consented_by)).ai_included then 'plan'
    when exists (select 1 from user_ai_keys k
                  where k.user_id = s.consented_by and k.provider = s.key_provider) then 'own_key'
  end
  from ai_settings s
  where s.book_id = p_book
$$;

create function enforce_ai_entitlement() returns trigger
language plpgsql as $$
begin
  -- Whoever turns AI on, or switches which key it uses, is the one consenting
  -- and paying. Nobody can name someone else as the payer.
  if new.enabled and (tg_op = 'INSERT' or not old.enabled or new.key_provider is distinct from old.key_provider) then
    new.consented_by := current_app_user();
    new.consented_at := now();
  elsif tg_op = 'UPDATE' then
    new.consented_by := old.consented_by;
    new.consented_at := old.consented_at;
  end if;
  return new;
end $$;

create function check_ai_entitlement() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  -- Checked when AI is turned on or its key changes. Later lapses (plan ended,
  -- key deleted, account purged) just make ai_entitlement() null: AI stops.
  if new.enabled and (tg_op = 'INSERT' or not old.enabled or new.key_provider is distinct from old.key_provider)
     and ai_entitlement(new.book_id) is null then
    raise exception 'plan_limit: AI needs Premium or your own AI key';
  end if;
  return null;
end $$;

create trigger ai_settings_consent before insert or update on ai_settings
  for each row execute function enforce_ai_entitlement();
create trigger ai_settings_entitled after insert or update on ai_settings
  for each row execute function check_ai_entitlement();

-- For the AI job (ai_reader): the encrypted key to use for a book with
-- own-key AI, only if the job's current user can read that book.
create function ai_key_for_book(p_book uuid) returns table (provider text, key_ciphertext bytea, key_user uuid)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select k.provider, k.key_ciphertext, k.user_id
    from ai_settings s
    join user_ai_keys k on k.user_id = s.consented_by and k.provider = s.key_provider
   where s.book_id = p_book and can_read_book(p_book) and ai_entitlement(p_book) = 'own_key'
$$;

create table ai_insights (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references books(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  model         text not null,                     -- which model / version produced it
  input         jsonb not null,                    -- exactly what was sent, for members to inspect
  advice        text not null,
  dismissed_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- These views run with the owner's rights (no security_invoker) so ai_reader
-- needs no base-table grants. Each one filters to books the current user is a
-- member of and returns nothing for a book that hasn't opted in.
create view ai_monthly_category_spend with (security_barrier = true) as
select t.book_id,
       date_trunc('month', t.occurred_on)::date as month,
       coalesce(c.name, 'Uncategorized')        as category,
       a.currency,
       (-sum(e.amount))::bigint                 as spent,   -- positive = money out
       count(*)                                 as txn_count
  from transactions t
  join entries e  on e.transaction_id = t.id
  join accounts a on a.id = e.account_id
  join ai_settings s on s.book_id = t.book_id and s.enabled and ai_entitlement(s.book_id) is not null
  left join categories c on c.id = t.category_id
 where can_read_book(t.book_id)
   and t.type in ('expense', 'refund')
 group by 1, 2, 3, 4;

create view ai_monthly_income with (security_barrier = true) as
select t.book_id,
       date_trunc('month', t.occurred_on)::date as month,
       a.currency,
       sum(e.amount)::bigint                    as earned
  from transactions t
  join entries e  on e.transaction_id = t.id
  join accounts a on a.id = e.account_id
  join ai_settings s on s.book_id = t.book_id and s.enabled and ai_entitlement(s.book_id) is not null
 where can_read_book(t.book_id)
   and t.type = 'income'
 group by 1, 2, 3;

create view ai_monthly_payee_spend with (security_barrier = true) as
select t.book_id,
       date_trunc('month', t.occurred_on)::date as month,
       t.payee,
       a.currency,
       (-sum(e.amount))::bigint                 as spent,
       count(*)                                 as txn_count
  from transactions t
  join entries e  on e.transaction_id = t.id
  join accounts a on a.id = e.account_id
  join ai_settings s on s.book_id = t.book_id and s.enabled and s.include_payees and ai_entitlement(s.book_id) is not null
 where can_read_book(t.book_id)
   and t.type = 'expense' and t.payee is not null
 group by 1, 2, 3, 4;

alter table ai_settings enable row level security;
alter table ai_insights enable row level security;
create policy members_read  on ai_settings for select using (can_read_book(book_id));
create policy owners_write  on ai_settings for all using (is_book_owner(book_id)) with check (is_book_owner(book_id));
create policy members_read  on ai_insights for select using (can_read_book(book_id));
create policy editors_manage on ai_insights for update using (can_write_book(book_id)) with check (can_write_book(book_id));
create policy editors_delete on ai_insights for delete using (can_write_book(book_id));
create policy job_insert    on ai_insights for insert with check (can_read_book(book_id) and ai_entitlement(book_id) is not null);

grant select, insert, update, delete on ai_settings to app_user;
grant select, delete on ai_insights to app_user;            -- members read, owners and editors delete
grant update (dismissed_at) on ai_insights to app_user;      -- and dismiss; the advice itself can't be changed

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ai_reader') then
    create role ai_reader nologin;
  end if;
end $$;
grant usage on schema public to ai_reader;
grant select on ai_monthly_category_spend, ai_monthly_income, ai_monthly_payee_spend to ai_reader;
grant insert on ai_insights to ai_reader;
revoke execute on function ai_key_for_book(uuid) from public;
grant execute on function ai_key_for_book(uuid), ai_entitlement(uuid) to ai_reader;
grant execute on function ai_entitlement(uuid) to app_user;

-- ---------------------------------------------------------------------------
-- Exchange rates
--
-- Stored money never changes with rates: each entry stays in its account's
-- currency, and a cross-currency transfer stores both sides as they happened.
-- Rates are only used to report a book's totals in its base currency.
--
-- fx_rates: market rates, shared by everyone, one row per currency per day,
--   all quoted against USD ("1 USD = rate units of quote"). Any pair is
--   derived through USD. Written only by the updater job (fx_updater role).
-- book_fx_rates: the book's own rate for one pair, from a date on.
--   Always wins over the market rate for that book.
-- books.auto_fx: whether market rates are used at all for that book. If it is
--   off, only the book's own rates apply, and a pair without one has no
--   conversion (null).
-- ---------------------------------------------------------------------------
create table fx_rates (
  quote       char(3) not null references currencies(code),
  as_of       date not null,
  rate        numeric(24, 10) not null check (rate > 0),  -- units of quote per 1 USD
  source      text not null,                              -- e.g. 'openexchangerates'
  fetched_at  timestamptz not null default now(),
  primary key (quote, as_of)
);

create table book_fx_rates (
  id              uuid primary key default gen_random_uuid(),
  book_id         uuid not null references books(id) on delete cascade,
  from_currency   char(3) not null references currencies(code),
  to_currency     char(3) not null references currencies(code),
  rate            numeric(24, 10) not null check (rate > 0),  -- units of to_currency per 1 from_currency
  effective_from  date not null,
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  check (from_currency <> to_currency),
  unique (book_id, from_currency, to_currency, effective_from)
);

create trigger book_fx_rates_version before update on book_fx_rates for each row execute function bump_version();
create trigger audit_book_fx_rates after insert or update or delete on book_fx_rates for each row execute function write_audit();

-- Rate to convert 1 unit of p_from into p_to for a book on a date.
-- Order: same currency -> the book's own rate (either direction) -> market rate
-- through USD if the book uses auto rates -> null (unknown).
-- Uses the latest rate on or before the date, so weekends and holidays work.
create function book_rate(p_book uuid, p_from char(3), p_to char(3), p_on date)
returns numeric
language sql stable as $$
  select case when p_from = p_to then 1::numeric else coalesce(
    (select r.rate from book_fx_rates r
      where r.book_id = p_book and r.from_currency = p_from and r.to_currency = p_to
        and r.effective_from <= p_on
      order by r.effective_from desc limit 1),
    (select 1 / r.rate from book_fx_rates r
      where r.book_id = p_book and r.from_currency = p_to and r.to_currency = p_from
        and r.effective_from <= p_on
      order by r.effective_from desc limit 1),
    (select
        (case when p_to = 'USD' then 1 else
          (select rate from fx_rates where quote = p_to and as_of <= p_on order by as_of desc limit 1) end)
      / (case when p_from = 'USD' then 1 else
          (select rate from fx_rates where quote = p_from and as_of <= p_on order by as_of desc limit 1) end)
      from books b where b.id = p_book and b.auto_fx)
  ) end
$$;

-- Convert an amount in minor units of p_from to minor units of p_to.
create function convert_minor(p_book uuid, p_amount bigint, p_from char(3), p_to char(3), p_on date)
returns bigint
language sql stable as $$
  select round(p_amount * book_rate(p_book, p_from, p_to, p_on)
               * power(10::numeric, ct.minor_unit - cf.minor_unit))::bigint
    from currencies cf, currencies ct
   where cf.code = p_from and ct.code = p_to
$$;

-- Each account's balance converted to its book's base currency at today's
-- rate. converted_balance is null when no rate is known for that currency.
create view book_balances_converted with (security_invoker = true) as
select ab.account_id, ab.book_id, ab.name, ab.kind, ab.currency, ab.in_net_worth, ab.balance,
       b.base_currency,
       convert_minor(ab.book_id, ab.balance, ab.currency, b.base_currency, current_date) as converted_balance
  from account_balances ab
  join books b on b.id = ab.book_id;

-- A book's net worth in its base currency, over accounts counted in net worth
-- (accounts.in_net_worth). missing_rates > 0 means some of those accounts
-- could not be converted and are left out of the total.
create view book_net_worth with (security_invoker = true) as
select b.id as book_id, b.base_currency,
       coalesce(sum(bc.converted_balance), 0)::bigint as net_worth,
       count(bc.account_id) filter (where bc.converted_balance is null) as missing_rates
  from books b
  left join book_balances_converted bc on bc.book_id = b.id and bc.in_net_worth
 group by b.id, b.base_currency;

alter table book_fx_rates enable row level security;
create policy members_read   on book_fx_rates for select using (can_read_book(book_id));
create policy editors_write  on book_fx_rates for all using (can_write_book(book_id)) with check (can_write_book(book_id));
-- fx_rates is public market data: no per-user rows, so no RLS. Read-only to the app.

grant select on fx_rates to app_user;
grant select, insert, update, delete on book_fx_rates to app_user;
grant select on book_balances_converted, book_net_worth to app_user;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fx_updater') then
    create role fx_updater nologin;
  end if;
end $$;
grant usage on schema public to fx_updater;
grant select, insert, update on fx_rates to fx_updater;   -- nothing else: it never sees user data
grant select on currencies to fx_updater;

-- ---------------------------------------------------------------------------
-- Dashboard views (home screen). Amounts are converted to the book's base
-- currency at the rate on each transaction's date, so a total mixes
-- currencies correctly. not_converted counts transactions with no known rate
-- (left out of the total), so the screen can say so instead of under-reporting.
-- ---------------------------------------------------------------------------
create view book_txn_amounts with (security_invoker = true) as
select t.id as transaction_id, t.book_id, t.type, t.occurred_on,
       date_trunc('month', t.occurred_on)::date as month,
       t.category_id, e.amount, a.currency,
       convert_minor(t.book_id, e.amount, a.currency, b.base_currency, t.occurred_on) as base_amount
  from transactions t
  join entries e  on e.transaction_id = t.id
  join accounts a on a.id = e.account_id
  join books b    on b.id = t.book_id
 where t.type in ('expense', 'refund', 'income');

-- Spending and income per month. spent = expenses minus refunds.
create view book_monthly_cashflow with (security_invoker = true) as
select book_id, month,
       coalesce(-sum(base_amount) filter (where type in ('expense', 'refund')), 0)::bigint as spent,
       coalesce(sum(base_amount)  filter (where type = 'income'), 0)::bigint              as income,
       count(*) filter (where base_amount is null)                                       as not_converted
  from book_txn_amounts
 group by book_id, month;

-- Spending per category per month (sub-categories roll up to their parent
-- via category_parent_id, so the app can show either level).
create view book_monthly_category_spend with (security_invoker = true) as
select x.book_id, x.month, x.category_id,
       coalesce(c.name, 'Uncategorized') as category,
       c.parent_id as category_parent_id,
       coalesce(-sum(x.base_amount), 0)::bigint as spent,
       count(*) filter (where x.base_amount is null) as not_converted
  from book_txn_amounts x
  left join categories c on c.id = x.category_id
 where x.type in ('expense', 'refund')
 group by x.book_id, x.month, x.category_id, c.name, c.parent_id;

grant select on book_txn_amounts, book_monthly_cashflow, book_monthly_category_spend to app_user;

-- ---------------------------------------------------------------------------
-- Budgets: a spending limit for an expense category per period.
-- A budget on a parent category covers its sub-categories too.
-- The amount is in the book's base currency; spending in other currencies is
-- converted at each transaction's date (same as the dashboard).
-- Periods follow the book's timezone, so every member sees the same day;
-- weeks start on Monday.
-- ---------------------------------------------------------------------------
create type budget_period as enum ('daily', 'weekly', 'monthly', 'quarterly', 'yearly');

create table budgets (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references books(id) on delete cascade,
  category_id  uuid not null,
  period       budget_period not null,
  amount       bigint not null check (amount > 0),   -- minor units of the book's base currency
  starts_on    date not null default current_date,
  ends_on      date,                                  -- null = ongoing
  version      int not null default 1,
  created_at   timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  unique (category_id, period),                       -- one daily, one monthly... per category
  foreign key (category_id, book_id) references categories(id, book_id) on delete cascade
);

create function budget_category_is_expense() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (select kind from categories where id = new.category_id) <> 'expense' then
    raise exception 'budget_expense_only: budgets can only be set on expense categories';
  end if;
  return new;
end $$;

create trigger budgets_expense_only before insert or update of category_id on budgets
  for each row execute function budget_category_is_expense();

-- Changing a book's currency converts its budgets at today's rate, so a
-- US$150 budget doesn't silently become 150 of the new currency. Refused when
-- no rate is known; the book can add its own rate first.
create function convert_budgets_on_currency_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare today date := (now() at time zone new.timezone)::date;
begin
  if exists (select 1 from budgets where book_id = new.id
              and convert_minor(new.id, amount, old.base_currency, new.base_currency, today) is null) then
    raise exception 'no_rate: no % to % rate to convert this book''s budgets', old.base_currency, new.base_currency;
  end if;
  update budgets
     set amount = greatest(1, convert_minor(new.id, amount, old.base_currency, new.base_currency, today))
   where book_id = new.id;
  return null;
end $$;
create trigger books_currency_budgets after update of base_currency on books
  for each row when (new.base_currency is distinct from old.base_currency)
  execute function convert_budgets_on_currency_change();
create trigger budgets_version before update on budgets for each row execute function bump_version();
create trigger audit_budgets after insert or update or delete on budgets for each row execute function write_audit();

-- Every category paired with itself and all its ancestors, so spending in
-- Groceries also counts toward a budget on Food.
create view category_ancestors with (security_invoker = true) as
with recursive up as (
  select id as category_id, id as ancestor_id, parent_id from categories
  union all
  select up.category_id, c.id, c.parent_id
    from up join categories c on c.id = up.parent_id
)
select category_id, ancestor_id from up;

-- Each active budget with its current period and how much is spent in it.
create view budget_progress with (security_invoker = true) as
with b as (
  select bu.*, (now() at time zone bk.timezone)::date as today
    from budgets bu join books bk on bk.id = bu.book_id
), p as (
  select b.*,
         date_trunc(case b.period when 'daily' then 'day' when 'weekly' then 'week'
                                  when 'monthly' then 'month' when 'quarterly' then 'quarter'
                                  else 'year' end, b.today::timestamp)::date as period_start
    from b
   where b.starts_on <= b.today and (b.ends_on is null or b.ends_on >= b.today)
), q as (
  select p.*,
         (period_start + case period when 'daily' then interval '1 day' when 'weekly' then interval '1 week'
                                     when 'monthly' then interval '1 month' when 'quarterly' then interval '3 months'
                                     else interval '1 year' end)::date - 1 as period_end
    from p
)
select q.id as budget_id, q.book_id, q.category_id, c.name as category, q.period,
       q.period_start, q.period_end, q.amount as budget,
       coalesce(s.spent, 0)::bigint as spent,
       (q.amount - coalesce(s.spent, 0))::bigint as remaining,
       round(100.0 * coalesce(s.spent, 0) / q.amount, 1) as percent_used,
       coalesce(s.not_converted, 0) as not_converted
  from q
  join categories c on c.id = q.category_id and c.archived_at is null   -- archiving a category hides its budgets
  left join lateral (
    select -sum(x.base_amount) as spent,
           count(*) filter (where x.base_amount is null) as not_converted
      from book_txn_amounts x
      join category_ancestors ca on ca.category_id = x.category_id and ca.ancestor_id = q.category_id
     where x.book_id = q.book_id
       and x.type in ('expense', 'refund')
       and x.occurred_on between greatest(q.period_start, q.starts_on) and q.period_end
  ) s on true;

alter table budgets enable row level security;
create policy members_read  on budgets for select using (can_read_book(book_id));
create policy editors_write on budgets for all using (can_write_book(book_id)) with check (can_write_book(book_id));
grant select, insert, update, delete on budgets to app_user;
grant select on category_ancestors, budget_progress to app_user;

-- ---------------------------------------------------------------------------
-- Consent
--
-- Vietnam's personal data protection law treats financial data as sensitive
-- and needs explicit, verifiable consent to process it. Sign-up records the
-- user's agreement to the current privacy policy, with its version and time,
-- in the same transaction that creates the users row; a users row without it
-- can't be committed. Records are never edited or deleted, only marked
-- withdrawn. Withdrawing the sign-up consent ('use_app') closes the account,
-- as if the user had asked to delete it; restoring needs a new consent.
-- ---------------------------------------------------------------------------
-- Each published privacy policy. Publishing one is a migration that inserts a
-- row; a row is never changed once users have agreed to it.
create table policy_versions (
  version       text primary key,                     -- e.g. '2026-11-01'
  published_at  timestamptz not null default now(),
  -- Where that exact text stays published: a path on the landing site, e.g.
  -- '/privacy/2026-11-01'. The domain is configuration (SITE_URL), never
  -- stored, so moving to another domain changes no data.
  path          text not null check (path ~ '^/[a-z0-9/_.-]+$'),
  -- SHA-256 of the exact text, so anyone can check later which text a
  -- version was, even if the page changes.
  text_sha256   text not null check (text_sha256 ~ '^[0-9a-f]{64}$')
);

-- The policy in force: the latest published (ties broken by version).
create function current_policy_version() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select version from policy_versions where published_at <= now()
   order by published_at desc, version desc limit 1
$$;

create table consents (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references users(id),
  -- What was agreed to. 'use_app' is the sign-up consent to process the
  -- user's data as the privacy policy describes. Add purposes here if the
  -- law or a feature needs its own consent.
  purpose         text not null check (purpose in ('use_app')),
  policy_version  text not null references policy_versions(version),
  agreed_at       timestamptz not null default now(),
  withdrawn_at    timestamptz check (withdrawn_at >= agreed_at)
);
-- Agreeing to a newer policy adds a row. One active row per user, purpose
-- and version.
create unique index consents_active_idx on consents (user_id, purpose, policy_version) where withdrawn_at is null;
create index consents_user_idx on consents (user_id, purpose, agreed_at desc);

-- Consent is only accepted for the policy in force, so a stale screen can't
-- record agreement to an older text. If a new version was published while
-- the user was reading, the insert fails and the app shows the new one.
create function consent_to_current_policy() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.policy_version is distinct from current_policy_version() then
    raise exception 'consent_outdated: agree to the current privacy policy (%)', current_policy_version();
  end if;
  return new;
end $$;
create trigger consents_current_policy before insert on consents
  for each row execute function consent_to_current_policy();

-- No account without the sign-up consent, checked when the transaction commits.
create function require_signup_consent() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.deleted_at is null and not exists (
       select 1 from consents c where c.user_id = new.id and c.purpose = 'use_app') then
    raise exception 'consent_required: agree to the privacy policy to create an account';
  end if;
  return null;
end $$;
create constraint trigger users_need_consent after insert on users
  deferrable initially deferred for each row execute function require_signup_consent();

alter table policy_versions enable row level security;
alter table consents enable row level security;
create policy anyone_read on policy_versions for select using (true);
create policy own_read   on consents for select using (user_id = current_app_user());
create policy own_insert on consents for insert with check (user_id = current_app_user());
grant select on policy_versions to app_user;
grant select on consents to app_user;
-- No agreed_at: the database stamps the time, so it can't be backdated. No
-- update or delete: withdrawal goes through withdraw_consent().
grant insert (user_id, purpose, policy_version) on consents to app_user;

-- Withdraw a consent. Withdrawing 'use_app' also closes the account (the
-- usual 30 days to restore, then purge). Returns what was withdrawn.
create function withdraw_consent(p_purpose text) returns int
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  update consents set withdrawn_at = now()
   where user_id = current_app_user() and purpose = p_purpose and withdrawn_at is null;
  get diagnostics n = row_count;
  if p_purpose = 'use_app' and n > 0 then
    update users set deletion_requested_at = now()
     where id = current_app_user() and deletion_requested_at is null;
  end if;
  return n;
end $$;

-- For the app: the policy in force, and whether this user has agreed to it.
-- Always one row. needs_consent is true after a withdrawal, or when a newer
-- policy is published. The API then shows only the new policy until the user
-- agrees or withdraws (which closes the account); the database itself
-- doesn't lock anyone out, so background jobs keep working.
create function my_consent_status()
returns table (purpose text, current_version text, current_path text, agreed_version text, agreed_at timestamptz,
               needs_consent boolean)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with cur as (select p.version, p.path from policy_versions p where p.version = current_policy_version()),
       mine as (select c.policy_version, c.agreed_at from consents c
                 where c.user_id = current_app_user() and c.purpose = 'use_app' and c.withdrawn_at is null
                 order by c.agreed_at desc, c.id desc limit 1)
  select 'use_app', cur.version, cur.path, mine.policy_version, mine.agreed_at,
         cur.version is null or not exists (
           select 1 from consents c
            where c.user_id = current_app_user() and c.purpose = 'use_app' and c.withdrawn_at is null
              and c.policy_version = cur.version)
    from (values (1)) one(x)
    left join cur on true
    left join mine on true
$$;

-- ---------------------------------------------------------------------------
-- Account deletion
--
-- 1. request_account_deletion(): the account closes at once. The user can
--    still sign in, but sees no book data (my_book_role returns null), only
--    the option to restore.
-- 2. restore_account(): within 30 days, everything comes back as it was.
-- 3. purge_deleted_accounts(): a daily job deletes accounts closed more than
--    30 days ago, for good:
--    - books where they are the only member: deleted with everything in them,
--      including edit history, AI advice and the books' audit log;
--    - shared books: kept for the other members. If the user was the only
--      owner, the longest-standing editor (else viewer) whose account is open
--      becomes owner. If nobody like that is left (only pending invites or
--      closed accounts), the book is deleted like a private one. If the user
--      created the book, it moves to an owner who stays (books.created_by);
--    - in shared books their entries stay (they're the book's money) and show
--      as "Deleted user" (see book_people);
--    - their users row is reduced to a bare id, its sign-up time and the purge
--      time: username (now free for someone new), name, email, memberships,
--      subscription and AI keys are deleted;
--    - their consent records stay, marked ended, as an anonymous record of
--      the consent flow, tied only to that bare id.
--    The job then logs the ids outside the database and deletes the logins at
--    the auth provider, retrying until confirmed (app/jobs/account_deletion.py).
-- ---------------------------------------------------------------------------
create function request_account_deletion() returns timestamptz
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  update users set deletion_requested_at = now()
   where id = current_app_user() and deletion_requested_at is null;
  select deletion_requested_at + interval '30 days' from users where id = current_app_user();
$$;

-- Needs an active sign-up consent to the policy in force: after a withdrawal,
-- or if the policy changed while the account was closed, the app asks the
-- user to agree first.
create function restore_account() returns boolean
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  update users set deletion_requested_at = null
   where id = current_app_user()
     and deletion_requested_at > now() - interval '30 days'
     and exists (select 1 from consents c
                  where c.user_id = users.id and c.purpose = 'use_app' and c.withdrawn_at is null
                    and c.policy_version = current_policy_version())
  returning true;
$$;

-- Deletes one account for good. Called by purge_deleted_accounts() and
-- repurge_accounts(); not callable by the app.
create function purge_account(u uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  solo uuid[];
  b record;
  successor uuid;
begin
  -- Books nobody else uses: delete them (their audit rows go with them).
  select coalesce(array_agg(m.book_id), '{}') into solo
    from book_members m
   where m.user_id = u
     and not exists (select 1 from book_members o where o.book_id = m.book_id and o.user_id <> u);
  delete from books where id = any(solo);

  -- Shared books where they were the only owner: hand over.
  -- (A co-owner whose own account is closed doesn't count.)
  for b in select m.book_id from book_members m
            where m.user_id = u and m.role = 'owner' and m.accepted_at is not null
              and not exists (select 1 from book_members o join users ou on ou.id = o.user_id
                               where o.book_id = m.book_id and o.user_id <> u
                                 and o.role = 'owner' and o.accepted_at is not null
                                 and ou.deletion_requested_at is null)
  loop
    select o.user_id into successor from book_members o
      join users ou on ou.id = o.user_id
     where o.book_id = b.book_id and o.user_id <> u and o.accepted_at is not null
       and ou.deletion_requested_at is null
     order by o.role, o.accepted_at          -- owner, then editor, then viewer
     limit 1;
    if successor is null then          -- only pending invites or closing accounts left
      delete from books where id = b.book_id;
    else
      update book_members set role = 'owner' where book_id = b.book_id and user_id = successor;
    end if;
  end loop;

  -- Everything personal goes. The id stays as a bare row, so what they did in
  -- shared books shows as "Deleted user" (see book_people) and two deleted
  -- users stay distinct. With the login deleted too, nothing links the id to
  -- a person. The username is freed: someone new can take it, with a new id.
  delete from book_members where user_id = u;          -- books they created move to another owner (move_book_creator)
  delete from subscriptions where user_id = u;
  update consents set withdrawn_at = now() where user_id = u and withdrawn_at is null;   -- ended with the account
  delete from user_ai_keys where user_id = u;
  update users set username = null, display_name = null, email = null, timezone = 'UTC', language = 'vi',
                   deletion_requested_at = null, deleted_at = now()
   where id = u;
end $$;

-- Daily job: purge accounts closed more than 30 days ago. Returns their ids so
-- the job can delete the matching logins at the auth provider, and record the
-- ids outside this database (see repurge_accounts).
create function purge_deleted_accounts() returns setof uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  u uuid;
begin
  for u in select id from users
            where deletion_requested_at <= now() - interval '30 days'
            for update skip locked
  loop
    perform purge_account(u);
    return next u;
  end loop;
end $$;

-- After restoring a backup taken before some purges, those accounts are back.
-- The job keeps the purged ids outside the database (a backup restore would
-- roll back any list kept inside it) and passes them here to delete them again.
create function repurge_accounts(p_ids uuid[]) returns int
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  u uuid;
  n int := 0;
begin
  for u in select id from users where id = any(p_ids) and deleted_at is null loop
    perform purge_account(u);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The user's own profile, including email, for the data export.
create function my_profile()
returns table (username text, display_name text, email text, timezone text, language text, created_at timestamptz,
               deletion_requested_at timestamptz, plan text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select username, display_name, email, timezone, language, created_at, deletion_requested_at, user_plan(id)
    from users where id = current_app_user()
$$;
grant execute on function my_profile() to app_user;

-- Changes the user made themselves, for the data export (the full audit log
-- is owner-only; this is just the user's own actions, in any book).
create function my_activity()
returns table (at timestamptz, book_name text, table_name text, action text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select a.at, case when can_read_book(a.book_id) then b.name end, a.table_name, a.action
    from audit_log a left join books b on b.id = a.book_id
   where a.actor_id = current_app_user()
   order by a.at
$$;
grant execute on function my_activity() to app_user;

-- The user's own account status (for the "restore your account" screen).
create function my_account_status()
returns table (deletion_requested_at timestamptz, deletes_on timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select deletion_requested_at, deletion_requested_at + interval '30 days'
    from users where id = current_app_user()
$$;

revoke execute on function purge_account(uuid), purge_deleted_accounts(), repurge_accounts(uuid[]) from public;

-- Everyone who appears in a book: members, and anyone who added, edited,
-- invited or turned on AI there, including people who left and purged
-- accounts. Use it for every "added by" / "edited by" label. Purged accounts
-- show as "Deleted user", numbered when a book has several, so two deleted
-- users stay distinct. Runs as its owner because users' own policy only shows
-- current co-members; can_read_book limits it to books the caller is in.
create view book_people with (security_barrier = true) as
with seen as (
  select book_id, user_id from book_members
  union select book_id, invited_by from book_members where invited_by is not null
  union select book_id, created_by from transactions where created_by is not null
  union select book_id, modified_by from transactions where modified_by is not null
  union select book_id, changed_by from transaction_history where changed_by is not null
  union select book_id, consented_by from ai_settings where consented_by is not null
), labelled as (
  select s.book_id, s.user_id, u.username, u.display_name, u.deleted_at,
         rank() over (partition by s.book_id, u.deleted_at is null order by u.deleted_at, u.id) as n,
         count(*) over (partition by s.book_id, u.deleted_at is null) as of_kind
    from seen s join users u on u.id = s.user_id
   where can_read_book(s.book_id)
)
select book_id, user_id,
       case when deleted_at is null then username
            when of_kind = 1 then 'Deleted user'
            else 'Deleted user ' || n end as name,
       display_name,
       deleted_at is not null as deleted
  from labelled;
grant select on book_people to app_user;
grant execute on function request_account_deletion(), restore_account(), my_account_status() to app_user;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'account_purger') then
    create role account_purger nologin;
  end if;
end $$;
grant usage on schema public to account_purger;
grant execute on function purge_deleted_accounts(), repurge_accounts(uuid[]) to account_purger;   -- and nothing else
