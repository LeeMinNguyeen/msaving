-- Signing out after inactivity (msaving#26): each user can choose, for their
-- own sessions, how many minutes they may go unused before they end. Off
-- (null) by default: sessions then last 30 days unused, as before.
--
-- The server ends a session unused that long, plus a minute, since
-- last_used_at is kept to the minute (session_user_id()): it covers tabs that
-- are closed or hidden and devices that sleep. A tab left open on screen keeps
-- its session in use with its background refreshes, so the web app also signs
-- out after that long with no click, key or touch.
alter table users
  add column if not exists idle_sign_out_minutes int check (idle_sign_out_minutes between 1 and 1440);
grant update (idle_sign_out_minutes) on users to app_user;

-- How long a session of this user may go unused before it ends.
create or replace function session_lifetime(p_user uuid) returns interval
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select least(interval '30 days', make_interval(mins => u.idle_sign_out_minutes + 1))
                     from users u where u.id = p_user), interval '30 days')
$$;

-- As before (the baseline), with the session's own lifetime for the 30 days.
create or replace function session_user_id(p_token_sha256 bytea) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare s sessions;
begin
  select * into s from sessions where token_sha256 = p_token_sha256;
  if not found then
    return null;
  end if;
  if s.last_used_at < now() - session_lifetime(s.user_id)
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
  delete from sessions s where s.last_used_at < now() - session_lifetime(s.user_id);
  get diagnostics n = row_count;
  delete from password_resets where expires_at < now() - interval '30 days';
  delete from invites where expires_at < now() - interval '30 days' and used_at is null;
  return n;
end $$;

-- The user's own profile now includes the setting. A new column means a new function.
drop function if exists my_profile();
create function my_profile()
returns table (username text, display_name text, timezone text, language text, created_at timestamptz,
               deletion_requested_at timestamptz, is_admin boolean, idle_sign_out_minutes int)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select username, display_name, timezone, language, created_at, deletion_requested_at, is_admin, idle_sign_out_minutes
    from users where id = current_app_user()
$$;

revoke execute on function session_lifetime(uuid), my_profile() from public;
grant execute on function session_lifetime(uuid), my_profile() to app_user;
