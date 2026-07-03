-- =========================================================================
-- ConnectHub — Migração de participantes entre grupos (anti-ban)
-- Rode DEPOIS de 001, 002 e 003.
-- =========================================================================

create table if not exists public.group_migrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  source_group_jid text not null,
  source_group_subject text,
  target_group_jid text,
  target_group_subject text,
  mode text not null check (mode in ('new_group','existing_group')),
  batch_size int not null default 3,
  min_delay_seconds int not null default 45,
  max_delay_seconds int not null default 120,
  status text not null default 'pending' check (status in ('pending','running','paused','completed','failed','canceled')),
  total int not null default 0,
  added_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  next_attempt_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_gm_user on public.group_migrations(user_id, created_at desc);
create index if not exists idx_gm_due on public.group_migrations(status, next_attempt_at);

do $$ begin
  execute 'drop trigger if exists group_migrations_touch on public.group_migrations';
  execute 'create trigger group_migrations_touch before update on public.group_migrations for each row execute function public.touch_updated_at()';
end $$;

grant select, insert, update, delete on public.group_migrations to authenticated;
grant all on public.group_migrations to service_role;
alter table public.group_migrations enable row level security;
drop policy if exists "gm_owner_all" on public.group_migrations;
create policy "gm_owner_all" on public.group_migrations for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.group_migration_targets (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references public.group_migrations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  phone text not null,
  jid text,
  name text,
  status text not null default 'pending' check (status in ('pending','added','failed','skipped')),
  error text,
  added_at timestamptz,
  created_at timestamptz default now(),
  unique (migration_id, phone)
);
create index if not exists idx_gmt_migration on public.group_migration_targets(migration_id, status);

grant select, insert, update, delete on public.group_migration_targets to authenticated;
grant all on public.group_migration_targets to service_role;
alter table public.group_migration_targets enable row level security;
drop policy if exists "gmt_owner_all" on public.group_migration_targets;
create policy "gmt_owner_all" on public.group_migration_targets for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$ begin
  execute 'alter publication supabase_realtime add table public.group_migrations';
exception when duplicate_object then null; end $$;
do $$ begin
  execute 'alter publication supabase_realtime add table public.group_migration_targets';
exception when duplicate_object then null; end $$;
