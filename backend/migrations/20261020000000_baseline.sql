-- Baseline for self-hosted MSaving (PostgreSQL 15+), 2026-10-20. Replaces the
-- hosted design's migrations (Supabase Auth, plans, consent), which no
-- instance ever ran. Until the first release this file is edited directly;
-- after that, never edit it again; add a new migration instead.
-- Balances are never stored: an account's balance is SUM(entries.amount).
-- Amounts are signed integers in minor units (cents). Never use float.
--
-- Access model: everything lives in a book, and a book has members. What a
-- user can see or change is decided by their role in that book (owner,
-- editor, viewer), enforced by row-level security in the database itself.
--
-- Errors the user can cause start with a code ('owner_required: ...'). The API
-- shows a message in the user's language for the code; the English text after
-- it is for developers.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Users
-- The profile. Passwords, two-factor secrets and sessions live in their own
-- tables (end of file), which the API reads only through functions.
-- ---------------------------------------------------------------------------
create table users (
  id            uuid primary key default gen_random_uuid(),
  -- Unique handle for signing in and for adding someone to a book. Stored
  -- lowercase so "Nguyin" and "nguyin" can't both exist; the app lowercases
  -- input before saving. Null only once the account is purged, which frees it
  -- for someone new.
  username      text unique
                check (username ~ '^[a-z0-9][a-z0-9_.]{2,29}$'),
  display_name  text,
  timezone      text not null default 'UTC',          -- IANA name; the app sends it as a new book's timezone
  -- App and export language. Vietnamese first, English second (Nguyin).
  language      text not null default 'vi' check (language in ('vi', 'en')),
  -- The instance's admin: the first account (the setup screen). Set only by the
  -- database (users_first_is_admin), never by the app.
  is_admin      boolean not null default false,
  disabled_at   timestamptz,                          -- set by the admin: can't sign in, sessions ended
  created_at    timestamptz not null default now(),
  deletion_requested_at timestamptz,                  -- set = account closed, restorable for 30 days (see end of file)
  -- Set = purged for good. The row stays as a bare id so shared books can show
  -- "Deleted user" against what they did, and tell two deleted users apart.
  deleted_at    timestamptz,
  check ((deleted_at is null and username is not null)
      or (deleted_at is not null and username is null and display_name is null and not is_admin))
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
  created_by    uuid not null references users(id),   -- the creator; moves to another owner if they leave
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
-- longest-standing remaining owner (open accounts first). keep_an_owner()
-- guarantees one.
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

-- Members of the books I'm in, with usernames.
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
-- exposed to them through book_member_list).
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
-- Column grants: is_admin and disabled_at are set only through the admin
-- functions (end of file), so nobody can make themselves admin.
grant select (id, username, display_name, timezone, language, created_at) on users to app_user;
grant insert (id, username, display_name, timezone, language) on users to app_user;
grant update (username, display_name, timezone, language) on users to app_user;
-- Columns the database sets itself (who created or edited something,
-- versions) are left out of the insert and update grants, so the app can't
-- forge them.
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
  source      text not null,                              -- e.g. 'open.er-api.com', 'openexchangerates'
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
-- Account deletion
--
-- 1. request_account_deletion(): the account closes at once. The user can
--    still sign in, but sees no book data (my_book_role returns null), only
--    the option to restore.
-- 2. restore_account(): within 30 days, everything comes back as it was.
-- 3. purge_deleted_accounts(): a daily job deletes accounts closed more than
--    30 days ago, for good:
--    - books where they are the only member: deleted with everything in them,
--      including edit history and the books' audit log;
--    - shared books: kept for the other members. If the user was the only
--      owner, the longest-standing editor (else viewer) whose account is open
--      becomes owner. If nobody like that is left (only pending invites or
--      closed accounts), the book is deleted like a private one. If the user
--      created the book, it moves to an owner who stays (books.created_by);
--    - in shared books their entries stay (they're the book's money) and show
--      as "Deleted user" (see book_people);
--    - their users row is reduced to a bare id, its sign-up time and the purge
--      time: username (now free for someone new), name, memberships, password,
--      two-factor secret, recovery codes and sessions are deleted.
--    The job then logs the ids outside the database (app/jobs/account_deletion.py).
-- ---------------------------------------------------------------------------
create function request_account_deletion() returns timestamptz
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  update users set deletion_requested_at = now()
   where id = current_app_user() and deletion_requested_at is null;
  select deletion_requested_at + interval '30 days' from users where id = current_app_user();
$$;

create function restore_account() returns boolean
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  update users set deletion_requested_at = null
   where id = current_app_user()
     and deletion_requested_at > now() - interval '30 days'
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
  delete from local_credentials where user_id = u;
  delete from recovery_codes where user_id = u;
  delete from sessions where user_id = u;
  update users set username = null, display_name = null, timezone = 'UTC', language = 'vi', is_admin = false,
                   disabled_at = null, deletion_requested_at = null, deleted_at = now()
   where id = u;
end $$;

-- Daily job: purge accounts closed more than 30 days ago. Returns their ids so
-- the job can record them outside this database (see repurge_accounts).
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

-- The user's own profile, for the app and the data export.
create function my_profile()
returns table (username text, display_name text, timezone text, language text, created_at timestamptz,
               deletion_requested_at timestamptz, is_admin boolean)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select username, display_name, timezone, language, created_at, deletion_requested_at, is_admin
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
-- or invited there, including people who left and purged
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

-- ---------------------------------------------------------------------------
-- The instance
--
-- One row: the server's name (shown on the sign-in screen and to the mobile
-- app), whether sign-up is by invite or open, and the setup code while no
-- admin exists. The setup code is made and printed in the server's log by
-- app/jobs/migrate.py on every start until the admin exists, so whoever
-- installed the server, and only they, can create the admin account.
-- ---------------------------------------------------------------------------
create table instance_settings (
  id                  boolean primary key default true check (id),     -- one row only
  name                text not null default 'MSaving' check (length(name) between 1 and 60),
  signup              text not null default 'invite' check (signup in ('invite', 'open')),
  setup_code_sha256   bytea check (length(setup_code_sha256) = 32),
  setup_claimed_by    uuid          -- the admin's id, set by claim_setup() in the transaction that creates them
);
insert into instance_settings default values;
-- No policies and no grants: read and changed only through functions.
alter table instance_settings enable row level security;

-- For anyone, before signing in: what the sign-in screen and the mobile app
-- need to know about this server.
create function instance_info()
returns table (name text, signup text, setup_needed boolean)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select s.name, s.signup, not exists (select 1 from users where is_admin and deleted_at is null)
    from instance_settings s
$$;

-- The first account. The API calls this, with app.user_id set to the new
-- account's id, before inserting the users row. Fails unless no admin exists
-- and the code is the one in the log. Locks the row, so two people setting up
-- at once can't both succeed.
create function claim_setup(p_code_sha256 bytea) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare s instance_settings;
begin
  select * into s from instance_settings for update;
  if exists (select 1 from users where is_admin and deleted_at is null)
     or s.setup_code_sha256 is null or s.setup_code_sha256 <> p_code_sha256 then
    raise exception 'setup_invalid: wrong setup code, or this server is already set up';
  end if;
  update instance_settings set setup_code_sha256 = null, setup_claimed_by = current_app_user();
end $$;

-- ---------------------------------------------------------------------------
-- Invites
--
-- Made by the admin: a short code, shown as a link and a QR code. The
-- database keeps only its SHA-256. One use each, with an expiry.
-- ---------------------------------------------------------------------------
create table invites (
  id            uuid primary key default gen_random_uuid(),
  code_sha256   bytea not null unique check (length(code_sha256) = 32),
  note          text check (length(note) <= 100),          -- who it's for, for the admin's list
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_by       uuid references users(id) on delete set null,
  used_at       timestamptz,
  revoked_at    timestamptz
);
alter table invites enable row level security;   -- no policies: functions only

-- For the join screen: is this code good right now?
create function invite_is_valid(p_code_sha256 bytea) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from invites
                  where code_sha256 = p_code_sha256 and used_at is null and revoked_at is null and expires_at > now())
$$;

-- Joining: called with app.user_id set to the new account, after its users
-- row is inserted, in the same transaction.
create function claim_invite(p_code_sha256 bytea) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  update invites set used_by = current_app_user(), used_at = now()
   where code_sha256 = p_code_sha256 and used_at is null and revoked_at is null and expires_at > now();
  if not found then
    raise exception 'invite_invalid: this invite is wrong, used, revoked or expired';
  end if;
end $$;

-- The first account is the admin, and only if setup was claimed for it.
create function users_first_is_admin() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  new.is_admin := coalesce((select setup_claimed_by = new.id from instance_settings), false);
  return new;
end $$;
create trigger users_first_is_admin before insert on users
  for each row execute function users_first_is_admin();

-- Nobody gets an account without a way in: the setup code (the admin), an
-- invite, or open sign-up. Checked when the transaction commits, so the
-- invite can be claimed after the users row exists.
create function users_need_a_way_in() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not (new.is_admin
          or exists (select 1 from invites where used_by = new.id)
          or (select signup = 'open' from instance_settings)) then
    raise exception 'invite_required: this server takes new accounts by invite only';
  end if;
  return null;
end $$;
create constraint trigger users_need_a_way_in after insert on users
  deferrable initially deferred for each row execute function users_need_a_way_in();

-- ---------------------------------------------------------------------------
-- Sign-in (app/core/sign_in.py)
--
-- Passwords: argon2id hashes made by the API, never the password. Two-factor:
-- a TOTP secret (set = on) and ten one-time recovery codes, hashed. Sessions:
-- a random token kept only by the client; this keeps its SHA-256, so a
-- database dump can't be used to sign in. Unused for 30 days = expired.
-- ---------------------------------------------------------------------------
create table local_credentials (
  user_id        uuid primary key references users(id) on delete cascade,
  password_hash  text not null,
  totp_secret    text,
  updated_at     timestamptz not null default now()
);

create table recovery_codes (
  user_id      uuid not null references users(id) on delete cascade,
  code_sha256  bytea not null check (length(code_sha256) = 32),
  used_at      timestamptz,
  primary key (user_id, code_sha256)
);

create table sessions (
  token_sha256   bytea primary key check (length(token_sha256) = 32),
  user_id        uuid not null references users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

-- A password reset link the admin makes for one user. One use, short expiry.
create table password_resets (
  token_sha256  bytea primary key check (length(token_sha256) = 32),
  user_id       uuid not null references users(id) on delete cascade,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);

alter table local_credentials enable row level security;
alter table recovery_codes enable row level security;
alter table sessions enable row level security;
alter table password_resets enable row level security;   -- no policies: functions only
create policy own on local_credentials for all using (user_id = current_app_user()) with check (user_id = current_app_user());
create policy own on recovery_codes for all using (user_id = current_app_user()) with check (user_id = current_app_user());
create policy own on sessions for all using (user_id = current_app_user()) with check (user_id = current_app_user());

-- Signing in, before anyone is signed in: the hash and two-factor secret for
-- a username, so the API can check the password. Open and closed accounts
-- (closed ones sign in to restore); never disabled or purged ones.
create function sign_in_lookup(p_username text)
returns table (user_id uuid, password_hash text, totp_secret text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.user_id, c.password_hash, c.totp_secret
    from users u join local_credentials c on c.user_id = u.id
   where u.username = lower(p_username) and u.deleted_at is null and u.disabled_at is null
$$;

-- A recovery code instead of the two-factor code: used once.
create function use_recovery_code(p_user uuid, p_code_sha256 bytea) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  update recovery_codes set used_at = now()
   where user_id = p_user and code_sha256 = p_code_sha256 and used_at is null;
  return found;
end $$;

-- Every request: whose token this is, or null. Marks it used (at most once a
-- minute) and deletes it once expired.
create function session_user_id(p_token_sha256 bytea) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare s sessions;
begin
  select * into s from sessions where token_sha256 = p_token_sha256;
  if not found then
    return null;
  end if;
  if s.last_used_at < now() - interval '30 days'
     or exists (select 1 from users where id = s.user_id and (disabled_at is not null or deleted_at is not null)) then
    delete from sessions where token_sha256 = p_token_sha256;
    return null;
  end if;
  if s.last_used_at < now() - interval '1 minute' then
    update sessions set last_used_at = now() where token_sha256 = p_token_sha256;
  end if;
  return s.user_id;
end $$;

-- Using a reset link: marks it used and returns the user, who then sets a new
-- password (the API, as that user). Two-factor is turned off and every session
-- ends: the admin vouched for the person, who may have lost their phone too.
create function use_password_reset(p_token_sha256 bytea) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare u uuid;
begin
  update password_resets set used_at = now()
   where token_sha256 = p_token_sha256 and used_at is null and expires_at > now()
  returning user_id into u;
  if u is null or exists (select 1 from users where id = u and (disabled_at is not null or deleted_at is not null)) then
    raise exception 'reset_invalid: this reset link is wrong, used or expired';
  end if;
  update local_credentials set totp_secret = null, updated_at = now() where user_id = u;
  delete from recovery_codes where user_id = u;
  delete from sessions where user_id = u;
  return u;
end $$;

-- Daily, from the purge job: sessions unused for 30 days, and old invites and
-- reset links.
create function purge_expired_sign_in() returns int
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  delete from sessions where last_used_at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from password_resets where expires_at < now() - interval '30 days';
  delete from invites where expires_at < now() - interval '30 days' and used_at is null;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- The admin's tools. Each checks the caller is the admin; the app has no
-- direct access to the tables behind them.
-- ---------------------------------------------------------------------------
create function am_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select is_admin from users
                    where id = current_app_user() and deleted_at is null and disabled_at is null
                      and deletion_requested_at is null), false)
$$;

create function require_admin() returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not am_admin() then
    raise exception 'admin_only: only the server''s admin can do this';
  end if;
end $$;

create function admin_set_instance(p_name text, p_signup text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  update instance_settings set name = coalesce(p_name, name), signup = coalesce(p_signup, signup);
end $$;

create function admin_users()
returns table (id uuid, username text, display_name text, is_admin boolean, created_at timestamptz,
               disabled_at timestamptz, deletion_requested_at timestamptz, last_seen_at timestamptz,
               two_factor boolean)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  return query
    select u.id, u.username, u.display_name, u.is_admin, u.created_at, u.disabled_at, u.deletion_requested_at,
           (select max(s.last_used_at) from sessions s where s.user_id = u.id),
           coalesce((select c.totp_secret is not null from local_credentials c where c.user_id = u.id), false)
      from users u
     where u.deleted_at is null
     order by u.created_at;
end $$;

-- Disabling ends the user's sessions at once. The admin can't disable themself.
create function admin_set_disabled(p_user uuid, p_disabled boolean) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  if p_user = current_app_user() then
    raise exception 'admin_self: the admin can''t disable their own account';
  end if;
  update users set disabled_at = case when p_disabled then coalesce(disabled_at, now()) end
   where id = p_user and deleted_at is null;
  if not found then
    raise exception 'not_found: no such user';
  end if;
  if p_disabled then
    delete from sessions where user_id = p_user;
  end if;
end $$;

create function admin_create_invite(p_code_sha256 bytea, p_expires_at timestamptz, p_note text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare i uuid;
begin
  perform require_admin();
  insert into invites (code_sha256, note, created_by, expires_at)
  values (p_code_sha256, p_note, current_app_user(), p_expires_at)
  returning id into i;
  return i;
end $$;

create function admin_invites()
returns table (id uuid, note text, created_at timestamptz, expires_at timestamptz, used_by_username text,
               used_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  return query
    select i.id, i.note, i.created_at, i.expires_at,
           case when u.deleted_at is null then u.username else 'Deleted user' end, i.used_at, i.revoked_at
      from invites i left join users u on u.id = i.used_by
     order by i.created_at desc;
end $$;

create function admin_revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  update invites set revoked_at = now() where id = p_invite and used_at is null and revoked_at is null;
end $$;

create function admin_create_password_reset(p_user uuid, p_token_sha256 bytea, p_expires_at timestamptz) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  if not exists (select 1 from users where id = p_user and deleted_at is null) then
    raise exception 'not_found: no such user';
  end if;
  insert into password_resets (token_sha256, user_id, created_by, expires_at)
  values (p_token_sha256, p_user, current_app_user(), p_expires_at);
end $$;

-- ---------------------------------------------------------------------------
-- Lock-down and grants
--
-- Postgres lets PUBLIC execute every function by default. Only the app's
-- roles get the ones they need; the rest run only inside policies and
-- triggers. The second line covers functions later migrations create.
--
-- On a database that comes with Supabase's API roles (an operator's own
-- Supabase project), those roles get nothing either: this app never uses
-- Supabase's Data API, and tables without row-level security (currencies,
-- fx_rates) would otherwise be readable, and fx_rates writable, through it.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
alter default privileges revoke execute on functions from public;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;

grant execute on function current_app_user(), my_book_role(uuid), can_read_book(uuid), can_write_book(uuid),
  is_book_owner(uuid), shares_a_book_with(uuid), book_rate(uuid, char, char, date),
  convert_minor(uuid, bigint, char, char, date),
  find_user_by_username(text), my_pending_invites(), accept_invite(uuid), request_account_deletion(),
  restore_account(), my_account_status(), my_profile(), my_activity(),
  instance_info(), claim_setup(bytea), invite_is_valid(bytea), claim_invite(bytea), sign_in_lookup(text),
  use_recovery_code(uuid, bytea), session_user_id(bytea), use_password_reset(bytea),
  am_admin(), admin_set_instance(text, text), admin_users(), admin_set_disabled(uuid, boolean),
  admin_create_invite(bytea, timestamptz, text), admin_invites(), admin_revoke_invite(uuid),
  admin_create_password_reset(uuid, bytea, timestamptz)
  to app_user;
grant select, insert on local_credentials to app_user;
grant update (password_hash, totp_secret, updated_at) on local_credentials to app_user;
grant select (user_id, used_at), insert (user_id, code_sha256), delete on recovery_codes to app_user;
grant select (token_sha256, user_id, created_at, last_used_at), insert (token_sha256, user_id), delete on sessions to app_user;

grant execute on function purge_deleted_accounts(), repurge_accounts(uuid[]), purge_expired_sign_in() to account_purger;
-- Called from triggers that run as whoever writes the row: app edits, and the
-- purge job deleting a closed account's books.
grant execute on function check_transaction_shape(uuid) to app_user, account_purger;
