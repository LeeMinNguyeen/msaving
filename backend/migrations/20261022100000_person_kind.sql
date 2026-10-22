-- A person's own account (see the next migration). Alone in its file: Postgres can't use an enum value in the
-- transaction that adds it.
alter type account_kind add value if not exists 'person';
