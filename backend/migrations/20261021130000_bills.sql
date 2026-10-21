-- Monthly bills for credit cards and loans (msaving#37). A bill is worked out
-- from the transactions when asked for (app/domain/bills.py), never stored; a
-- loan only needs what its contract says:
--   installment       loan: the monthly payment, in minor units of the account's currency
--   installment_fee   loan: a one-off fee (0 % installment contracts often have one),
--                     charged with the first payment
--   payment_due_day   now a loan's payment day too, not only a credit card's
alter table accounts
  add column if not exists installment     bigint check (installment > 0),
  add column if not exists installment_fee bigint check (installment_fee >= 0),
  drop constraint if exists account_card_details,
  add constraint account_card_details check (kind = 'credit_card'
    or (credit_limit is null and annual_fee is null and statement_day is null)),
  drop constraint if exists account_due_day,
  add constraint account_due_day check (payment_due_day is null or kind in ('credit_card', 'loan')),
  drop constraint if exists account_installment,
  add constraint account_installment check (kind = 'loan' or (installment is null and installment_fee is null));
