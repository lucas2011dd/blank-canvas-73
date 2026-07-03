-- 006_session_persistence.sql
-- Persistência da sessão WhatsApp por instância — permite reconexão silenciosa
-- automática. O usuário só perde a sessão se clicar em "Desconectar" (fluxo
-- manual). Rode este arquivo no SQL editor do Supabase do projeto.

-- 1) Novas colunas na tabela `connections`
alter table public.connections
  add column if not exists disconnected_manually boolean not null default false,
  add column if not exists auto_reconnect        boolean not null default true,
  add column if not exists last_seen_online_at   timestamptz,
  add column if not exists evolution_owner_jid   text,
  add column if not exists evolution_instance    text,
  add column if not exists session_snapshot      jsonb not null default '{}'::jsonb;

create index if not exists idx_connections_auto_reconnect
  on public.connections(auto_reconnect, disconnected_manually, status);

-- 2) Histórico/último snapshot da sessão por instância Evolution
create table if not exists public.connection_sessions (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  instance_name text not null,
  owner_jid     text,
  state         text,
  status        text,
  snapshot      jsonb not null default '{}'::jsonb,
  captured_at   timestamptz not null default now(),
  unique (connection_id, instance_name)
);

create index if not exists idx_connection_sessions_user
  on public.connection_sessions(user_id);
create index if not exists idx_connection_sessions_instance
  on public.connection_sessions(instance_name);

-- 3) GRANTs (schema public exige grant explícito)
grant select, insert, update, delete on public.connection_sessions to authenticated;
grant all                            on public.connection_sessions to service_role;

-- 4) RLS
alter table public.connection_sessions enable row level security;

drop policy if exists "connection_sessions_owner_all" on public.connection_sessions;
create policy "connection_sessions_owner_all" on public.connection_sessions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
