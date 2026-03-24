create table if not exists bot_execution_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_source text not null default 'unknown',
  bot_status text not null,
  severity text not null check (severity in ('ok', 'warn', 'error')),
  human_message text not null,
  http_status int,
  details jsonb
);

create index if not exists bot_execution_logs_created_at_idx
  on bot_execution_logs (created_at desc);

create or replace function purge_bot_execution_logs_90d()
returns void
language sql
security definer
set search_path = public
as $$
  delete from bot_execution_logs
  where created_at < now() - interval '90 days';
$$;

do $$
begin
  perform cron.unschedule('bot-execution-logs-retention');
exception
  when others then null;
end
$$;

select cron.schedule(
  'bot-execution-logs-retention',
  '12 3 * * *',
  $$select public.purge_bot_execution_logs_90d();$$
);
