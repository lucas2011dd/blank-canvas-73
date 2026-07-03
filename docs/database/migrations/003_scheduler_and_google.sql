-- =========================================================================
-- ConnectHub — Mensagens agendadas + tokens do Google + refinamentos
-- Execute DEPOIS de 001 e 002.
-- =========================================================================

-- Mensagens agendadas ----------------------------------------------------
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  target_kind text not null check (target_kind in ('phone','group')),
  target text not null,             -- número (só dígitos) OU jid do grupo (xxxx@g.us)
  target_label text,                -- rótulo amigável (nome do contato/grupo)
  body text not null,
  scheduled_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','canceled')),
  attempts int not null default 0,
  last_error text,
  sent_at timestamptz,
  recurrence text default 'none' check (recurrence in ('none','daily','weekly')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_sched_user on public.scheduled_messages(user_id, scheduled_at);
create index if not exists idx_sched_due on public.scheduled_messages(status, scheduled_at);

do $$
begin
  execute 'drop trigger if exists scheduled_messages_touch on public.scheduled_messages';
  execute 'create trigger scheduled_messages_touch before update on public.scheduled_messages for each row execute function public.touch_updated_at()';
end $$;

grant select, insert, update, delete on public.scheduled_messages to authenticated;
grant all on public.scheduled_messages to service_role;

alter table public.scheduled_messages enable row level security;
drop policy if exists "sched_owner_all" on public.scheduled_messages;
create policy "sched_owner_all" on public.scheduled_messages for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$ begin
  execute 'alter publication supabase_realtime add table public.scheduled_messages';
exception when duplicate_object then null; end $$;

-- Tokens do Google (por usuário) -----------------------------------------
create table if not exists public.google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  updated_at timestamptz default now()
);
grant select, insert, update, delete on public.google_tokens to authenticated;
grant all on public.google_tokens to service_role;
alter table public.google_tokens enable row level security;
drop policy if exists "gt_owner_all" on public.google_tokens;
create policy "gt_owner_all" on public.google_tokens for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
