-- Every transaction has a time of day, in the book's timezone like its date. Older ones get 00:00.
alter table transactions add column if not exists occurred_time time(0) not null default '00:00:00';
grant insert (occurred_time), update (occurred_time) on transactions to app_user;
