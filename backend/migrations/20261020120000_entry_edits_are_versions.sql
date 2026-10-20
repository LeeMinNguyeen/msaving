-- An edit that changes only amounts or accounts (the entries) is a new
-- version with its own line in the edit history, like any other edit
-- (msaving#18, #19). The entries live in their own table, so bump_version()
-- on the header never saw such an edit: the version stayed, a second device
-- could overwrite it without a 409, and the history skipped it.
--
-- The API now sets modified_at in that case (app/domain/transactions.py),
-- which bump_version() counts as a change. bump_version() then sets
-- modified_at to now() itself, so this grant can't store any other value.
grant update (modified_at) on transactions to app_user;
