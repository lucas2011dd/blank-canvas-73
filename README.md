# ConnectHub — SaaS 2026

Plataforma SaaS completa: conexões (WhatsApp/Telegram), chat em tempo real, contatos, Google Contacts, auditoria e mais.
**100% auto-hospedável** — roda em Node no seu servidor, atrás de Apache/XAMPP/Nginx como reverse proxy.

## Stack

- **Frontend**: TanStack Start (React 19, Vite 7, TypeScript, TailwindCSS 4)
- **Backend**: Server functions do TanStack (Node runtime) + `@supabase/supabase-js`
- **Banco/Auth/Storage/Realtime**: Supabase (projeto próprio — externo, isolado)
- **UI**: shadcn/ui, Radix, Sonner (toasts), Lucide icons
- **Validação**: Zod (client + server)

## Setup

### 1. Crie um novo projeto Supabase

1. Acesse [supabase.com/dashboard](https://supabase.com/dashboard) → **New Project**
2. Guarde: **Project URL**, **anon public key**, **service_role key**
3. Vá em **SQL Editor** → cole e execute o conteúdo de `supabase/migrations/0001_init.sql`
4. Em **Authentication → Providers → Email**: ative "Confirm email" (opcional) e "Password HIBP Check"
5. Em **Authentication → URL Configuration**: adicione `http://localhost:3000` e `http://seusaas.local` como URLs permitidas

### 2. Instale dependências

```bash
git clone <seu-repo>
cd <projeto>
npm install  # ou bun install
```

### 3. Configure o ambiente

```bash
cp .env.example .env
# Edite .env com as credenciais do seu Supabase
```

### 4. Rode em desenvolvimento

```bash
npm run dev
# http://localhost:3000
```

### 5. Build para produção

```bash
npm run build
node .output/server/index.mjs
# Servidor em http://localhost:3000 (respeita $PORT)
```

## Rodando atrás do XAMPP (Apache)

Requisitos: mod_proxy, mod_proxy_http, mod_proxy_wstunnel, mod_rewrite habilitados no `httpd.conf`.

1. Copie `xampp-vhost.example.conf` para `xampp/apache/conf/extra/httpd-vhosts.conf` (ou faça um Include)
2. Ajuste `ServerName` e a porta do Node se necessário
3. Adicione ao `C:\Windows\System32\drivers\etc\hosts`: `127.0.0.1 seusaas.local`
4. Rode o backend Node: `node .output/server/index.mjs`
5. Reinicie o Apache no XAMPP e acesse `http://seusaas.local`

### Como serviço (Windows)

Use [nssm](https://nssm.cc) para transformar o Node em serviço:

```powershell
nssm install ConnectHub "C:\Program Files\nodejs\node.exe" "C:\caminho\projeto\.output\server\index.mjs"
nssm set ConnectHub AppEnvironmentExtra "PORT=3000"
nssm start ConnectHub
```

## Segurança

- ✅ RLS habilitado em **todas** as tabelas
- ✅ Função `has_role()` SECURITY DEFINER para RBAC (evita recursão)
- ✅ Roles em tabela separada (`user_roles`) — impede escalação de privilégio
- ✅ JWT do Supabase validado em todo server function via `requireSupabaseAuth`
- ✅ Zod valida todos inputs (client + server)
- ✅ Service role key **nunca** exposto ao browser (`.server.ts`)
- ✅ Auditoria completa em `audit_logs`
- ✅ MFA (TOTP) opcional via Supabase Auth

## Estrutura

```
src/
  routes/
    index.tsx                    # landing
    auth.tsx                     # login/signup
    reset-password.tsx
    _authenticated/              # subtree protegido (redirect /auth)
      route.tsx
      dashboard.tsx
      conexoes.tsx
      chat.tsx
      contatos.tsx
      ferramentas.tsx
      configuracoes.tsx
      logs.tsx
    api/
      google/authorize.ts        # OAuth Google - início
      google/callback.ts         # OAuth Google - callback
  lib/
    *.functions.ts               # server functions (RPC)
  integrations/supabase/
    client.ts                    # browser client
    client.server.ts             # server admin (service role)
    auth-middleware.ts           # requireSupabaseAuth
    auth-attacher.ts             # anexa bearer no client
    types.ts                     # tipos Database
  components/
    app-sidebar.tsx
    theme-provider.tsx
    theme-toggle.tsx
    ui/                          # shadcn
supabase/migrations/0001_init.sql
```

## Integrações opcionais

### Google Contacts (OAuth 2.0)

1. Google Cloud Console → **APIs & Services → Credentials → OAuth 2.0 Client ID**
2. Tipo: Web application. Authorized redirect URI: `http://seusaas.local/api/google/callback`
3. Preencha `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT` no `.env`
4. Na app: **Configurações → Integrações → Vincular conta Google**

### WhatsApp Business API

Suporta [Evolution API](https://github.com/EvolutionAPI/evolution-api) (self-hosted), Meta Cloud API, Twilio.
Configure `WHATSAPP_PROVIDER`, `WHATSAPP_API_URL`, `WHATSAPP_API_KEY` no `.env`.
A UI de conexão + QR Code está em **Menu Conexões**.

### Sentry (monitoramento de erros)

`bun add @sentry/react @sentry/node` e adicione seu DSN no `.env` como `SENTRY_DSN`.

## Roadmap sugerido

- [ ] Backup automático (cron server-fn export SQL)
- [ ] Dashboard de monitoramento CPU/mem (endpoint `/api/metrics` compatível com Prometheus)
- [ ] Webhooks outbound (já modelado; falta UI para configurar)
- [ ] Templates de mensagem
- [ ] Multi-tenancy (organizações)

## Licença

MIT.
