-- Signed-in devices (msaving#5), listed on Profile and security. Each session
-- gets an id the API can show and end, so the token's hash never leaves the
-- database, and a short label of the browser and system that signed in, with
-- no versions or addresses: "Chrome · Windows", "Safari · iOS"
-- (app/core/sign_in.py device_label()). Sessions from before have none.
alter table sessions
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists device text check (length(device) <= 60);
create unique index if not exists sessions_id_key on sessions (id);
grant select (id, device), insert (device) on sessions to app_user;
