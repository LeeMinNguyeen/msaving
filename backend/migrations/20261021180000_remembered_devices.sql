-- A browser where someone ticked "remember this device" at the two-factor step: signing in there skips the code,
-- never the password, for 30 days.
create table if not exists remembered_devices (
  token_sha256  bytea primary key check (length(token_sha256) = 32),
  user_id       uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days'
);
create index if not exists remembered_devices_user_idx on remembered_devices (user_id);
alter table remembered_devices enable row level security;
drop policy if exists own on remembered_devices;
create policy own on remembered_devices for all using (user_id = current_app_user()) with check (user_id = current_app_user());
grant select (token_sha256, user_id, expires_at), insert (token_sha256, user_id), delete on remembered_devices to app_user;

-- A new password or a change to two-factor (turned off, by the user or an admin's reset link) forgets every
-- remembered device, whichever way it's done.
create or replace function forget_remembered_devices() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from remembered_devices where user_id = new.user_id;
  return null;
end $$;
revoke execute on function forget_remembered_devices() from public;

drop trigger if exists forget_remembered_devices on local_credentials;
create trigger forget_remembered_devices after update of password_hash, totp_secret on local_credentials
  for each row when (new.password_hash is distinct from old.password_hash or new.totp_secret is distinct from old.totp_secret)
  execute function forget_remembered_devices();

create or replace function purge_expired_sign_in() returns int
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  delete from sessions s where s.last_used_at < now() - session_lifetime(s.user_id);
  get diagnostics n = row_count;
  delete from password_resets where expires_at < now() - interval '30 days';
  delete from invites where expires_at < now() - interval '30 days' and used_at is null;
  delete from remembered_devices r
   where r.expires_at < now() or exists (select 1 from users u where u.id = r.user_id and u.deleted_at is not null);
  return n;
end $$;
