create or replace function get_bot_run_logs_count()
returns bigint
language sql
security definer
set search_path = public, cron
as $$
  select count(*)::bigint
  from cron.job_run_details;
$$;
