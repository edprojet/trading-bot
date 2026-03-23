-- Fix: security definer function without explicit search_path.
-- Without it, a malicious object in the default search_path could shadow
-- cron/net tables. Setting search_path explicitly prevents this.

drop function if exists get_bot_run_logs(int);

create function get_bot_run_logs(limit_n int default 50)
returns table (
  run_id        bigint,
  started_at    timestamptz,
  cron_status   text,
  http_status   int,
  timed_out     boolean,
  http_error    text,
  http_content  text
)
language sql
security definer
set search_path = public, cron, net
as $$
  select
    jrd.runid,
    jrd.start_time,
    jrd.status,
    hr.status_code,
    hr.timed_out,
    hr.error_msg,
    hr.content
  from cron.job_run_details jrd
  left join net._http_response hr on hr.id = jrd.runid
  order by jrd.start_time desc
  limit limit_n;
$$;
