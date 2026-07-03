-- =====================================================================
-- 005 — Autotick 24/7 via pg_cron + pg_net
-- =====================================================================
-- Objetivo: garantir que broadcasts, agendamentos e migrações de grupo
-- continuem rodando SOZINHOS mesmo com ninguém no painel.
--
-- Como instalar (uma única vez):
--   1) Abra o Supabase → SQL Editor do seu projeto ConnectHub.
--   2) Substitua os placeholders abaixo antes de executar:
--        - <APP_URL>     : https://SEU-DOMINIO.tld  (sem barra no fim)
--        - <TICK_SECRET> : o mesmo valor de TICK_SECRET nas variáveis do app
--   3) Rode este arquivo inteiro.
--
-- Depois disso, o tick é disparado a cada 60s pelo Postgres e o sistema
-- opera 24/7 sem depender do navegador aberto.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove agendamento anterior se existir (idempotente)
select cron.unschedule(jobid)
from cron.job
where jobname = 'connecthub_autotick';

-- Agenda o tick a cada 1 minuto
select cron.schedule(
  'connecthub_autotick',
  '* * * * *',
  $$
  select net.http_get(
    url := '<APP_URL>/api/public/wa/tick',
    headers := jsonb_build_object(
      'X-Tick-Secret', '<TICK_SECRET>',
      'User-Agent', 'ConnectHub-Autotick/1.0'
    ),
    timeout_milliseconds := 25000
  );
  $$
);

-- Verifique com:
--   select * from cron.job where jobname = 'connecthub_autotick';
--   select * from cron.job_run_details order by start_time desc limit 10;
