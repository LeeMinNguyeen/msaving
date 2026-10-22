-- A credit card purchase paid in installments. The purchase stays one expense on the card for its full amount; the
-- plan only changes what each bill asks for (app/domain/bills.py) and how much of the card's limit counts as used.
create table if not exists installment_plans (
  id                  uuid primary key,
  book_id             uuid not null references books(id) on delete cascade,
  account_id          uuid not null,
  transaction_id      uuid not null unique,
  months              int not null check (months between 2 and 60),
  converted_on        date not null,
  first_statement     date not null check (first_statement >= converted_on),   -- its month bills the first installment
  fee                 bigint not null default 0 check (fee >= 0),              -- minor units of the card's currency
  fee_split           boolean not null default false,                         -- false: all on the first installment's bill
  counts_toward_limit boolean not null default true,
  ended_on            date check (ended_on >= converted_on),                   -- paid off early: the rest on the next bill
  version             int not null default 1,
  created_at          timestamptz not null default now(),
  foreign key (account_id, book_id) references accounts(id, book_id),
  foreign key (transaction_id, book_id) references transactions(id, book_id) on delete cascade
);
create index if not exists installment_plans_account on installment_plans (account_id);

-- Only an expense on one credit card that has a statement day (the schedule follows its statements), converted on or
-- after the purchase. The card is the purchase's.
create or replace function installment_plan_fits() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  t record;
begin
  select tx.type, tx.occurred_on, a.id as account_id, a.kind, a.statement_day,
         (select count(*) from entries x where x.transaction_id = tx.id) as entry_count
    into t
    from transactions tx join entries e on e.transaction_id = tx.id join accounts a on a.id = e.account_id
   where tx.id = new.transaction_id
   limit 1;
  if not found or t.type <> 'expense' or t.entry_count <> 1 or t.kind <> 'credit_card' or t.statement_day is null then
    raise exception 'an installment plan needs an expense on a credit card with a statement day' using errcode = 'check_violation';
  end if;
  if new.converted_on < t.occurred_on then
    raise exception 'a purchase is converted on or after its date' using errcode = 'check_violation';
  end if;
  new.account_id := t.account_id;
  return new;
end $$;

drop trigger if exists installment_plans_fit on installment_plans;
create trigger installment_plans_fit before insert or update on installment_plans
  for each row execute function installment_plan_fits();
drop trigger if exists installment_plans_version on installment_plans;
create trigger installment_plans_version before update on installment_plans for each row execute function bump_version();
drop trigger if exists audit_installment_plans on installment_plans;
create trigger audit_installment_plans after insert or update or delete on installment_plans
  for each row execute function write_audit();

alter table installment_plans enable row level security;
drop policy if exists members_read on installment_plans;
create policy members_read on installment_plans for select using (can_read_book(book_id));
drop policy if exists editors_write on installment_plans;
create policy editors_write on installment_plans for all using (can_write_book(book_id)) with check (can_write_book(book_id));
grant select, insert, update, delete on installment_plans to app_user;
grant execute on function installment_plan_fits() to app_user;
