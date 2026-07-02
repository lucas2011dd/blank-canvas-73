import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/api/google/authorize")({
  server: {
    handlers: {
      GET: async () => {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT ?? "http://localhost:3000/api/google/callback";
        if (!clientId) return new Response("GOOGLE_CLIENT_ID não configurado", { status: 500 });
        const scope = encodeURIComponent("https://www.googleapis.com/auth/contacts.readonly openid email profile");
        const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;
        throw redirect({ href: url });
      },
    },
  },
});
