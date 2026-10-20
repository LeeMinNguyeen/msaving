-- Details that depend on the account's kind (msaving#17). All optional; the
-- app shows each only for the kinds it belongs to, and the API clears the
-- ones that stop applying when an account's kind changes.
--   note              any kind: what the account is for, where the card is kept
--   credit_limit      credit card: the bank's limit, in minor units of the account's currency
--   annual_fee        credit card: the yearly fee, in the same units
--   statement_day     credit card: the day of the month the statement closes (billing day)
--   payment_due_day   credit card: the day of the month payment is due
--   interest_rate_bp  savings, credit card, loan, money lent: the yearly rate in hundredths
--                     of a percent (5.5 % = 550). Information only: it never changes a
--                     balance. Interest is a transaction like any other (the old app's
--                     interest that changed balances without one was rejected).
alter table accounts
  add column if not exists note             text check (length(note) between 1 and 500),
  add column if not exists credit_limit     bigint check (credit_limit >= 0),
  add column if not exists annual_fee       bigint check (annual_fee >= 0),
  add column if not exists statement_day    smallint check (statement_day between 1 and 31),
  add column if not exists payment_due_day  smallint check (payment_due_day between 1 and 31),
  add column if not exists interest_rate_bp integer check (interest_rate_bp between 0 and 100000),
  drop constraint if exists account_card_details,
  add constraint account_card_details check (kind = 'credit_card'
    or (credit_limit is null and annual_fee is null and statement_day is null and payment_due_day is null)),
  drop constraint if exists account_interest,
  add constraint account_interest check (interest_rate_bp is null
    or kind in ('savings', 'credit_card', 'loan', 'lent'));
