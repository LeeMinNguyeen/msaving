-- Restoring a backup at first setup proves who is asking with the setup code, like creating the admin, without using
-- the code up: the restore replaces the settings it lives in.
create or replace function setup_code_matches(p_code_sha256 bytea) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select not exists (select 1 from users where is_admin and deleted_at is null)
     and s.setup_code_sha256 is not null and s.setup_code_sha256 = p_code_sha256
    from instance_settings s
$$;
revoke execute on function setup_code_matches(bytea) from public;
grant execute on function setup_code_matches(bytea) to app_user;
