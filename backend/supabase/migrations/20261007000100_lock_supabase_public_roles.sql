-- Supabase grants its built-in API roles (anon, authenticated) access to every
-- new table and function in the public schema, and serves them over its Data
-- API. This app never uses that path: the browser talks only to the Python
-- API. Row-level security would still hide user data from those roles, but
-- tables without RLS (plans, currencies, fx_rates) would be readable and, for
-- fx_rates, writable. So take all access away, now and for future objects.
-- Also turn the Data API off in the Supabase dashboard; this is the second lock.
-- Safe on plain Postgres (local tests): skipped when the roles don't exist.
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

-- Functions are executable by PUBLIC by default in Postgres, which includes
-- anon. Only the app's own roles get the ones they need (granted in the
-- baseline); the rest are reachable only from inside policies and triggers.
-- The second line covers functions later migrations create. It has to be the
-- global form: a per-schema default can add to the global one but never
-- take away from it.
revoke execute on all functions in schema public from public;
alter default privileges revoke execute on functions from public;

-- Restore what the app roles need after the blanket revoke above.
grant execute on function current_app_user(), my_book_role(uuid), can_read_book(uuid), can_write_book(uuid),
  is_book_owner(uuid), shares_a_book_with(uuid), book_rate(uuid, char, char, date),
  convert_minor(uuid, bigint, char, char, date), ai_entitlement(uuid),
  find_user_by_username(text), my_pending_invites(), accept_invite(uuid), request_account_deletion(),
  restore_account(), my_account_status(), my_profile(), my_activity(), withdraw_consent(text), my_consent_status(),
  current_policy_version()
  to app_user;
grant execute on function current_app_user(), can_read_book(uuid), my_book_role(uuid), ai_entitlement(uuid),
  ai_key_for_book(uuid)
  to ai_reader;
grant execute on function purge_deleted_accounts(), repurge_accounts(uuid[]) to account_purger;
-- Called from triggers that run as whoever writes the row: app edits, and the
-- purge job deleting a closed account's books.
grant execute on function check_transaction_shape(uuid) to app_user, account_purger;
