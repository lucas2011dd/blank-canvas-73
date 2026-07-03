-- =========================================================================
-- ConnectHub SaaS — schema inicial completo
-- Execute no SQL Editor do seu projeto Supabase (novo, isolado).
-- =========================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

do $$ begin
  create type public.app_role as enum ('admin', 'user');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  timezone text default 'America/Sao_Paulo',
  locale text default 'pt-BR',
  theme text default 'dark' check (theme in ('light','dark','system')),
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.profiles add column if not exists is_active boolean not null default true;


create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null default 'user',
  created_at timestamptz default now(),
  unique (user_id, role)
);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  insert into public.user_roles (user_id, role) values (new.id, 'user');
  return new;
end $$;

do $$
begin
  execute 'drop trigger if exists on_auth_user_created on auth.users';
  execute 'create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user()';
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
begin
  execute 'drop trigger if exists profiles_touch on public.profiles';
  execute 'create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at()';
end $$;

create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  provider text not null default 'whatsapp',
  status text not null default 'offline' check (status in ('online','offline','connecting','error')),
  qr_code text,
  metadata jsonb default '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_connections_user on public.connections(user_id);
do $$
begin
  execute 'drop trigger if exists connections_touch on public.connections';
  execute 'create trigger connections_touch before update on public.connections for each row execute function public.touch_updated_at()';
end $$;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  company text,
  city text,
  notes text,
  external_source text,
  external_id text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_contacts_user on public.contacts(user_id);
create index if not exists idx_contacts_search on public.contacts using gin (
  to_tsvector('portuguese', coalesce(name,'') || ' ' || coalesce(phone,'') || ' ' || coalesce(email,'') || ' ' || coalesce(company,''))
);
do $$
begin
  execute 'drop trigger if exists contacts_touch on public.contacts';
  execute 'create trigger contacts_touch before update on public.contacts for each row execute function public.touch_updated_at()';
end $$;

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text default '#7c3aed',
  created_at timestamptz default now(),
  unique(user_id, name)
);
create index if not exists idx_tags_user on public.tags(user_id);

create table if not exists public.contact_tags (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (contact_id, tag_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  title text,
  last_message_at timestamptz default now(),
  unread_count int default 0,
  created_at timestamptz default now()
);
create index if not exists idx_conversations_user on public.conversations(user_id, last_message_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  body text,
  attachment_url text,
  status text default 'sent' check (status in ('sent','delivered','read','failed')),
  created_at timestamptz default now()
);
create index if not exists idx_messages_conv on public.messages(conversation_id, created_at);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity text,
  entity_id uuid,
  metadata jsonb default '{}'::jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz default now()
);
create index if not exists idx_audit_user on public.audit_logs(user_id, created_at desc);
create index if not exists idx_audit_action on public.audit_logs(action);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, provider)
);
do $$
begin
  execute 'drop trigger if exists integrations_touch on public.integrations';
  execute 'create trigger integrations_touch before update on public.integrations for each row execute function public.touch_updated_at()';
end $$;

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  created_at timestamptz default now(),
  revoked_at timestamptz
);
create index if not exists idx_api_keys_user on public.api_keys(user_id);

create table if not exists public.webhooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  events text[] not null default '{}',
  secret text,
  active boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_webhooks_user on public.webhooks(user_id);

-- GRANTS ------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles     to authenticated;
grant select on public.user_roles                            to authenticated;
grant select, insert, update, delete on public.connections   to authenticated;
grant select, insert, update, delete on public.contacts      to authenticated;
grant select, insert, update, delete on public.tags          to authenticated;
grant select, insert, update, delete on public.contact_tags  to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages      to authenticated;
grant select, insert on public.audit_logs                    to authenticated;
grant select, insert, update, delete on public.integrations  to authenticated;
grant select, insert, update, delete on public.api_keys      to authenticated;
grant select, insert, update, delete on public.webhooks      to authenticated;
grant all on all tables in schema public to service_role;

-- RLS ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.user_roles    enable row level security;
alter table public.connections   enable row level security;
alter table public.contacts      enable row level security;
alter table public.tags          enable row level security;
alter table public.contact_tags  enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.audit_logs    enable row level security;
alter table public.integrations  enable row level security;
alter table public.api_keys      enable row level security;
alter table public.webhooks      enable row level security;

create policy "profiles_self_select" on public.profiles for select to authenticated
  using (auth.uid() = id or public.has_role(auth.uid(), 'admin'));
create policy "profiles_self_update" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);
create policy "user_roles_self_select" on public.user_roles for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));
create policy "connections_owner_all" on public.connections for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "contacts_owner_all" on public.contacts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tags_owner_all" on public.tags for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "contact_tags_owner_all" on public.contact_tags for all to authenticated
  using (exists (select 1 from public.contacts c where c.id = contact_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.contacts c where c.id = contact_id and c.user_id = auth.uid()));
create policy "conversations_owner_all" on public.conversations for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "messages_owner_all" on public.messages for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "audit_owner_read" on public.audit_logs for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));
create policy "audit_owner_insert" on public.audit_logs for insert to authenticated
  with check (auth.uid() = user_id);
create policy "integrations_owner_all" on public.integrations for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "api_keys_owner_all" on public.api_keys for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "webhooks_owner_all" on public.webhooks for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime ----------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.connections;

-- =========================================================================
-- SEED DO ADMIN MESTRE
-- Rode este bloco APÓS criar o usuário cloudteste1122@gmail.com no
-- Supabase Dashboard → Authentication → Users → "Add user" (Email+Password:
-- A1b2c344Asd@) com "Auto Confirm User" LIGADO.
-- =========================================================================
insert into public.user_roles (user_id, role)
select id, 'admin'::public.app_role
from auth.users where email = 'cloudteste1122@gmail.com'
on conflict (user_id, role) do nothing;

update public.profiles set is_active = true, full_name = coalesce(full_name, 'Administrador Mestre')
where id = (select id from auth.users where email = 'cloudteste1122@gmail.com');

