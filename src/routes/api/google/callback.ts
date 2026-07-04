import { createFileRoute } from "@tanstack/react-router";
import { verifyOAuthState } from "@/lib/oauth-state.server";

// Troca o `code` por tokens. O `state` é HMAC-assinado (issueOAuthState)
// e verificado aqui — sem o segredo o atacante não consegue direcionar
// tokens para outro user_id.
export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        if (!code) return new Response("Missing code", { status: 400 });

        const userId = verifyOAuthState(url.searchParams.get("state"));
        if (!userId) return new Response("invalid state", { status: 400 });

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return new Response("Google OAuth não configurado no servidor", { status: 500 });
        }
        const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT ?? `${url.origin}/api/google/callback`;

        const tokRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code",
          }),
        });
        if (!tokRes.ok) return new Response("Google token exchange failed", { status: 502 });
        const tokens = await tokRes.json() as { access_token: string; refresh_token?: string; expires_in: number; scope: string };

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          await supabaseAdmin.from("google_tokens").upsert({
            user_id: userId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token ?? null,
            expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
            scope: tokens.scope,
          });
        } catch (e) { console.error("[google] save tokens", e); }

        const dest = new URL("/configuracoes", url.origin);
        dest.hash = `google=connected`;
        return Response.redirect(dest.toString(), 302);
      },
    },
  },
});

