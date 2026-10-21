-- Signing out after inactivity (msaving#26): the admin can set, for everyone on
-- the server, how many minutes a session may go unused before it ends. Off
-- (null) by default: sessions then last 30 days unused, as before.
--
-- The server ends a session unused that long, plus a minute, since
-- last_used_at is kept to the minute (session_user_id()): it covers tabs that
-- are closed or hidden and devices that sleep. A tab left open on screen keeps
-- its session in use with its background refreshes, so the web app also signs
-- out after that long with no click, key or touch.
alter table instance_settings
  add column if not exists idle_sign_out_minutes int check (idle_sign_out_minutes between 1 and 1440);

-- How long a session may go unused before it ends.
create or replace function session_lifetime() returns interval
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(least(interval '30 days', make_interval(mins => s.idle_sign_out_minutes + 1)), interval '30 days')
    from instance_settings s
$$;

-- As before (the baseline), with session_lifetime() for the 30 days.
create or replace function session_user_id(p_token_sha256 bytea) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare s sessions;
begin
  select * into s from sessions where token_sha256 = p_token_sha256;
  if not found then
    return null;
  end if;
  if s.last_used_at < now() - session_lifetime()
     or exists (select 1 from users where id = s.user_id and (disabled_at is not null or deleted_at is not null)) then
    delete from sessions where token_sha256 = p_token_sha256;
    return null;
  end if;
  if s.last_used_at < now() - interval '1 minute' then
    update sessions set last_used_at = now() where token_sha256 = p_token_sha256;
  end if;
  return s.user_id;
end $$;

create or replace function purge_expired_sign_in() returns int
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  delete from sessions where last_used_at < now() - session_lifetime();
  get diagnostics n = row_count;
  delete from password_resets where expires_at < now() - interval '30 days';
  delete from invites where expires_at < now() - interval '30 days' and used_at is null;
  return n;
end $$;

-- What clients learn before signing in now includes the setting, so the web
-- app knows when to sign out an idle tab. A new column means a new function.
drop function if exists instance_info();
create function instance_info()
returns table (name text, signup text, setup_needed boolean, idle_sign_out_minutes int)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select s.name, s.signup, not exists (select 1 from users where is_admin and deleted_at is null), s.idle_sign_out_minutes
    from instance_settings s
$$;

-- The admin's setting: minutes, or null for off.
create or replace function admin_set_idle_sign_out(p_minutes int) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  update instance_settings set idle_sign_out_minutes = p_minutes;
end $$;

revoke execute on function session_lifetime(), instance_info(), admin_set_idle_sign_out(int) from public;
grant execute on function session_lifetime(), instance_info(), admin_set_idle_sign_out(int) to app_user;
