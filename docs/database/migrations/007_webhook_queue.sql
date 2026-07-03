-- 007_webhook_queue.sql
-- Fila assíncrona de webhooks da Evolution. O endpoint só grava o evento cru
-- aqui e retorna 200 imediatamente — o /api/public/wa/tick processa em fila
-- em segundo plano com retry/backoff. Assim a VPS/Evolution nunca fica presa
-- esperando o Supabase e não perdemos sessão por timeout de 30s.
--
-- Rode este arquivo no SQL editor do Supabase do projeto.

create table if not exists public.webhook_logs (
  id             bigserial primary key,
  instance_name  text not null,
  event          text not null,
  payload        jsonb not null,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  attempts       int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error     text,
  status         text not null default 'pending'  -- pending | processing | done | failed
);

create index if not exists idx_webhook_logs_pending
  on public.webhook_logs(status, next_attempt_at)
  where status in ('pending','processing');

create index if not exists idx_webhook_logs_instance_received
  on public.webhook_logs(instance_name, received_at desc);

-- GRANTs (Data API): apenas service_role escreve/lê essa fila.
grant all on public.webhook_logs        to service_role;
grant usage, select on sequence public.webhook_logs_id_seq to service_role;

alter table public.webhook_logs enable row level security;

-- Nenhuma policy pública: a tabela é operada exclusivamente pelo backend
-- (supabaseAdmin, que usa service_role e bypass RLS).

-- Housekeeping opcional (semanal): remove eventos já processados > 7 dias.
-- Rode manualmente ou via pg_cron se quiser:
--   delete from public.webhook_logs
--   where status = 'done' and processed_at < now() - interval '7 days';
