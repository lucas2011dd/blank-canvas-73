-- =========================================================================
-- ConnectHub — Locks distribuídos por conexão para migração de grupos
-- Item 1 e 2: mover locks/cooldowns da memória do processo para o banco,
-- para que sejam efetivos entre múltiplas réplicas (Lovable serverless /
-- load balancer / self-hosted com PM2 cluster).
--
-- Rode DEPOIS de 001..007.
-- =========================================================================

-- Lock atômico por conexão. NULL = livre. Timestamp futuro = travada até lá.
alter table public.connections
  add column if not exists processing_until timestamptz;

-- Cooldown de reconexão (era Map em globalThis). Usado por
-- processGroupMigrationBatch para não reiniciar a mesma instância em loop.
alter table public.connections
  add column if not exists last_reconnect_attempt_at timestamptz;

-- Estado persistente do worker de migração (last_batch_at, backoffs,
-- contadores de falha). O código usa esta coluna ao finalizar o primeiro
-- batch; sem ela, o update falha e a fila fica travada/conectando.
alter table public.group_migrations
  add column if not exists metadata jsonb default '{}'::jsonb;

-- Índice para varrer travas expiradas (opcional, mas ajuda diagnóstico).
create index if not exists idx_connections_processing_until
  on public.connections(processing_until)
  where processing_until is not null;

-- Higiene: se por acaso ficou uma trava velha em produção antes do deploy,
-- limpar tudo é seguro (ninguém está segurando, é só um TTL).
update public.connections
  set processing_until = null
  where processing_until is not null and processing_until < now();
