-- Every person is also an account, with the person's id: positive means they owe you, negative that you owe them.
-- Lending, repaying, borrowing and "paid for me" are ordinary transactions on it. It follows the person's name and
-- archiving, can't change kind, and doesn't take an account's name (people have their own unique names).
alter table accounts drop constraint if exists accounts_check;
alter table accounts drop constraint if exists account_contact;
alter table accounts add constraint account_contact check (contact_id is null or kind in ('loan', 'lent', 'person'));
alter table accounts drop constraint if exists account_person;
alter table accounts add constraint account_person check (kind <> 'person' or contact_id = id);

alter table accounts drop constraint if exists accounts_book_id_name_key;
drop index if exists accounts_book_id_name_key;
create unique index accounts_book_id_name_key on accounts (book_id, name) where kind <> 'person';

create or replace function person_account_kind() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (old.kind = 'person') <> (new.kind = 'person') then
    raise exception 'person_account: a person''s account stays one';
  end if;
  return new;
end $$;
drop trigger if exists accounts_person_kind on accounts;
create trigger accounts_person_kind before update of kind on accounts for each row execute function person_account_kind();

create or replace function person_account_add() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into accounts (id, book_id, name, kind, contact_id, archived_at)
  values (new.id, new.book_id, new.name, 'person', new.id, new.archived_at) on conflict (id) do nothing;
  return null;
end $$;
drop trigger if exists contacts_person_account on contacts;
create trigger contacts_person_account after insert on contacts for each row execute function person_account_add();

create or replace function person_account_follow() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  update accounts set name = new.name, archived_at = new.archived_at
   where id = new.id and kind = 'person' and (name, archived_at) is distinct from (new.name, new.archived_at);
  return null;
end $$;
drop trigger if exists contacts_person_follow on contacts;
create trigger contacts_person_follow after update of name, archived_at on contacts
  for each row execute function person_account_follow();

create or replace view contact_balances with (security_invoker = true) as
select c.id as contact_id, c.book_id, c.name, ab.currency,
       (coalesce(sum(ab.balance) filter (where ab.kind = 'lent'), 0)
        + coalesce(sum(greatest(ab.balance, 0)) filter (where ab.kind = 'person'), 0))::bigint as owed_to_you,
       (coalesce(-sum(ab.balance) filter (where ab.kind = 'loan'), 0)
        + coalesce(sum(greatest(-ab.balance, 0)) filter (where ab.kind = 'person'), 0))::bigint as you_owe
  from contacts c
  join accounts a on a.contact_id = c.id
  join account_balances ab on ab.account_id = a.id
 group by c.id, c.book_id, c.name, ab.currency;

insert into accounts (id, book_id, name, kind, currency, contact_id, archived_at)
select c.id, c.book_id, c.name, 'person', b.base_currency, c.id, c.archived_at
  from contacts c join books b on b.id = c.book_id
on conflict (id) do nothing;
