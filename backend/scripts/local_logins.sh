#!/usr/bin/env bash
# Creates one login per database role on the LOCAL Supabase stack only, with a
# fixed local password (see .env.example). Hosted environments get their own
# logins by hand, with real passwords (msaving-docs, Environments).
set -euo pipefail
url="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$url" in *127.0.0.1*|*localhost*) ;; *) echo "refusing: $url is not local" >&2; exit 1 ;; esac
psql "$url" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
declare r record;
begin
  for r in select * from (values ('api_login', 'app_user'), ('ai_login', 'ai_reader'), ('fx_login', 'fx_updater'),
                                 ('purge_login', 'account_purger'), ('billing_login', 'billing_webhook')) v(login, role) loop
    if not exists (select 1 from pg_roles where rolname = r.login) then
      execute format('create role %I login password %L in role %I', r.login, 'local-only-password', r.role);
    end if;
  end loop;
end $$;
SQL
echo "local logins ready"
