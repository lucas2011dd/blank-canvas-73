-- Adiciona coluna external_jid às conversas para suportar envio a grupos
-- (jids @g.us) e correlacionar conversas com chats externos sem depender
-- do título (que é usado como rótulo visível).
alter table public.conversations
  add column if not exists external_jid text;

create index if not exists idx_conversations_external_jid
  on public.conversations(connection_id, external_jid);

-- Preenche external_jid para conversas 1:1 já existentes cujo título é só dígitos.
update public.conversations
   set external_jid = title || '@s.whatsapp.net'
 where external_jid is null
   and connection_id is not null
   and title ~ '^[0-9]+$';
