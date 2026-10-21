-- The daily jobs' schedule and their last results (msaving#6), on Server admin.
--
-- Each job runs once a day at its time of day, set by the admin in their own
-- timezone (kept with it, so a change of daylight saving time doesn't move
-- it); until then at JOBS_HOUR (UTC, from .env), as before. The scheduler
-- (app/jobs/scheduler.py) looks at this every 30 seconds, so a change applies
-- without a restart, and runs a job that's due: one whose time came since its
-- last run and since its schedule last changed (so a server that was off at
-- that time catches up when it starts). Only the exchange rates can be turned
-- off: a server can do without them, not without backups or the purge.
create table if not exists jobs (
  name              text primary key check (name in ('purge', 'backup', 'rates')),
  at_minute         int check (at_minute between 0 and 1439),    -- minutes after midnight in `timezone`; null: JOBS_HOUR (UTC)
  timezone          text,                                         -- an IANA name, the admin's when they set the time
  enabled           boolean not null default true,
  changed_at        timestamptz,
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_result       text check (last_result in ('done', 'failed')),
  last_detail       text check (length(last_detail) <= 300),        -- the job's last line of output
  check ((at_minute is null) = (timezone is null)),
  check (enabled or name = 'rates')
);
insert into jobs (name) values ('purge'), ('backup'), ('rates') on conflict do nothing;
alter table jobs enable row level security;   -- no policies: the functions below only

-- Server admin: the schedule and the last results, in the order the jobs run.
create or replace function admin_jobs()
returns table (name text, at_minute int, timezone text, enabled boolean, changed_at timestamptz,
               last_started_at timestamptz, last_finished_at timestamptz, last_result text, last_detail text)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  return query
    select j.name, j.at_minute, j.timezone, j.enabled, j.changed_at, j.last_started_at, j.last_finished_at,
           j.last_result, j.last_detail
      from jobs j order by array_position(array['purge', 'backup', 'rates'], j.name);
end $$;

-- A job's time of day (null with a null timezone: back to JOBS_HOUR) and whether it runs.
create or replace function admin_set_job(p_name text, p_at_minute int, p_timezone text, p_enabled boolean) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  update jobs set at_minute = p_at_minute, timezone = p_timezone, enabled = p_enabled, changed_at = now()
   where name = p_name;
  if not found then
    raise exception 'not_found: no such job';
  end if;
end $$;

-- The scheduler, logged in as purge_login: what to run and when, and what happened.
create or replace function job_schedule()
returns table (name text, at_minute int, timezone text, enabled boolean, changed_at timestamptz, last_started_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select j.name, j.at_minute, j.timezone, j.enabled, j.changed_at, j.last_started_at
    from jobs j order by array_position(array['purge', 'backup', 'rates'], j.name)
$$;

create or replace function job_started(p_name text) returns void
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  update jobs set last_started_at = now() where name = p_name
$$;

create or replace function job_finished(p_name text, p_done boolean, p_detail text) returns void
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  update jobs set last_finished_at = now(), last_result = case when p_done then 'done' else 'failed' end,
                  last_detail = left(nullif(p_detail, ''), 300)
   where name = p_name
$$;

revoke execute on function admin_jobs(), admin_set_job(text, int, text, boolean), job_schedule(), job_started(text),
  job_finished(text, boolean, text) from public;
grant execute on function admin_jobs(), admin_set_job(text, int, text, boolean) to app_user;
grant execute on function job_schedule(), job_started(text), job_finished(text, boolean, text) to account_purger;
