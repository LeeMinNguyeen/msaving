-- Two-factor sign-in, enforced by the API (design.md, Security): a user who
-- has a verified TOTP factor must come with an aal2 token; a password alone
-- (aal1) gets nothing. The token says how the user signed in, not whether
-- they have a factor, so the API asks here. Reads Supabase Auth's own table;
-- the app's login can't read the auth schema, so this runs as its owner and
-- answers only for the signed-in user.
create function my_mfa_required() returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if to_regclass('auth.mfa_factors') is null then
    return false;                 -- a plain Postgres without Supabase Auth
  end if;
  return exists (select 1 from auth.mfa_factors f
                  where f.user_id = current_app_user() and f.status::text = 'verified');
end $$;
revoke execute on function my_mfa_required() from public;
grant execute on function my_mfa_required() to app_user;
