-- The accounts each member pins to their own Overview. A pin is a view, not book data: viewers pin too, and it never
-- touches the account's version. Tied to the membership, so leaving a book or being purged drops the pins.
create table if not exists account_pins (
  user_id    uuid not null default current_app_user(),
  account_id uuid not null,
  book_id    uuid not null,
  pinned_at  timestamptz not null default now(),
  primary key (user_id, account_id),
  foreign key (account_id, book_id) references accounts(id, book_id) on delete cascade,
  foreign key (book_id, user_id) references book_members(book_id, user_id) on delete cascade
);

alter table account_pins enable row level security;
drop policy if exists own on account_pins;
create policy own on account_pins for all
  using (user_id = current_app_user() and can_read_book(book_id))
  with check (user_id = current_app_user() and can_read_book(book_id));
grant select, insert, delete on account_pins to app_user;
