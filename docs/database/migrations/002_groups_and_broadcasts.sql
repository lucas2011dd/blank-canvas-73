-- =========================================================================
-- ConnectHub — Grupos do WhatsApp + Disparos em massa
-- Rode no SQL Editor do Supabase depois do schema.sql inicial.
-- =========================================================================

-- WhatsApp Groups ---------------------------------------------------------
create table if not exists public.whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  jid text not null,
  subject text not null default '',
  description text,
  participants_count int default 0,
  owner text,
  monitored boolean not null default false,
  picture_url text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (connection_id, jid)
);
create index if not exists idx_wa_groups_user on public.whatsapp_groups(user_id);
create index if not exists idx_wa_groups_conn on public.whatsapp_groups(connection_id);

do $$
begin
  execute 'drop trigger if exists whatsapp_groups_touch on public.whatsapp_groups';
  execute 'create trigger whatsapp_groups_touch before update on public.whatsapp_groups for each row execute function public.touch_updated_at()';
end $$;

grant select, insert, update, delete on public.whatsapp_groups to authenticated;
grant all on public.whatsapp_groups to service_role;

alter table public.whatsapp_groups enable row level security;
drop policy if exists "wa_groups_owner_all" on public.whatsapp_groups;
create policy "wa_groups_owner_all" on public.whatsapp_groups for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Broadcasts (disparos em massa) -----------------------------------------
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  name text not null,
  template text not null,
  min_delay_seconds int not null default 5,
  max_delay_seconds int not null default 30,
  status text not null default 'draft' check (status in ('draft','running','paused','completed','failed')),
  total_recipients int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_broadcasts_user on public.broadcasts(user_id, created_at desc);
create index if not exists idx_broadcasts_status on public.broadcasts(status);

do $$
begin
  execute 'drop trigger if exists broadcasts_touch on public.broadcasts';
  execute 'create trigger broadcasts_touch before update on public.broadcasts for each row execute function public.touch_updated_at()';
end $$;

grant select, insert, update, delete on public.broadcasts to authenticated;
grant all on public.broadcasts to service_role;

alter table public.broadcasts enable row level security;
drop policy if exists "broadcasts_owner_all" on public.broadcasts;
create policy "broadcasts_owner_all" on public.broadcasts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.broadcast_targets (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  phone text not null,
  name text,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  error text,
  sent_at timestamptz,
  next_attempt_at timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists idx_bt_broadcast on public.broadcast_targets(broadcast_id);
create index if not exists idx_bt_pending on public.broadcast_targets(status, next_attempt_at);

grant select, insert, update, delete on public.broadcast_targets to authenticated;
grant all on public.broadcast_targets to service_role;

alter table public.broadcast_targets enable row level security;
drop policy if exists "broadcast_targets_owner_all" on public.broadcast_targets;
create policy "broadcast_targets_owner_all" on public.broadcast_targets for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime ---------------------------------------------------------------
do $$ begin
  execute 'alter publication supabase_realtime add table public.whatsapp_groups';
exception when duplicate_object then null; end $$;
do $$ begin
  execute 'alter publication supabase_realtime add table public.broadcasts';
exception when duplicate_object then null; end $$;
do $$ begin
  execute 'alter publication supabase_realtime add table public.broadcast_targets';
exception when duplicate_object then null; end $$;
do $$ begin
  execute 'alter publication supabase_realtime add table public.contacts';
exception when duplicate_object then null; end $$;
