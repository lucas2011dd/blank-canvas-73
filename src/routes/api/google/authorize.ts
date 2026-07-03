import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/api/google/authorize")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const url = new URL(request.url);
        const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT ?? `${url.origin}/api/google/callback`;
        if (!clientId) return new Response("GOOGLE_CLIENT_ID não configurado", { status: 500 });
        const state = url.searchParams.get("uid") ?? "";
        const scope = encodeURIComponent("https://www.googleapis.com/auth/contacts openid email profile");
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
        throw redirect({ href: authUrl });
      },
    },
  },
});
