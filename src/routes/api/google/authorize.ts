// Inicia OAuth do Google. Só permite iniciar para o usuário autenticado
// (verifica bearer Supabase) e emite um `state` HMAC-assinado com TTL de 10min.
// Sem isso, `?uid=` era spoofable e o callback confiava cegamente no state.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { issueOAuthState } from "@/lib/oauth-state.server";

export const Route = createFileRoute("/api/google/authorize")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId) return new Response("GOOGLE_CLIENT_ID não configurado", { status: 500 });

        // Autentica o iniciador via Bearer Supabase — só o próprio usuário
        // pode começar o fluxo, e o user_id vem da sessão validada.
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
        if (!token) return new Response("unauthorized", { status: 401 });

        const supaUrl = process.env.SUPABASE_URL;
        const supaKey = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!supaUrl || !supaKey) return new Response("supabase env ausente", { status: 500 });
        const client = createClient(supaUrl, supaKey, {
          auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userData, error } = await client.auth.getUser(token);
        if (error || !userData?.user?.id) return new Response("unauthorized", { status: 401 });

        const url = new URL(request.url);
        const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT ?? `${url.origin}/api/google/callback`;
        const state = issueOAuthState(userData.user.id);
        const scope = encodeURIComponent("https://www.googleapis.com/auth/contacts openid email profile");
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
        throw redirect({ href: authUrl });
      },
    },
  },
});
