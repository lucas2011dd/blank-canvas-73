-- =========================================================================
-- ConnectHub — Estado persistente do worker de migração
--
-- Rode DEPOIS de 008. Necessário para instalações que já aplicaram a 008
-- antes da correção: o worker salva last_batch_at/backoffs em metadata.
-- =========================================================================

alter table public.group_migrations
  add column if not exists metadata jsonb default '{}'::jsonb;
