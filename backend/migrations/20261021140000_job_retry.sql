-- A daily job that failed runs again an hour later, until it works
-- (app/core/jobs.py), so a server that couldn't fetch exchange rates at its
-- first start, or had a full disk at backup time, catches up without waiting
-- a day. The scheduler needs to know how each last run went; a new column in
-- the answer means a new function.
drop function if exists job_schedule();
create function job_schedule()
returns table (name text, at_minute int, timezone text, enabled boolean, changed_at timestamptz,
               last_started_at timestamptz, last_result text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select j.name, j.at_minute, j.timezone, j.enabled, j.changed_at, j.last_started_at, j.last_result
    from jobs j order by array_position(array['purge', 'backup', 'rates'], j.name)
$$;
revoke execute on function job_schedule() from public;
grant execute on function job_schedule() to account_purger;
