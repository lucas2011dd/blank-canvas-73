import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/wa/debug")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("secret") !== process.env.TICK_SECRET) {
          return new Response("unauthorized", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { evolution } = await import("@/lib/evolution.server");

        const { data: conns } = await supabaseAdmin
          .from("whatsapp_connections")
          .select("id,instance_name,status,phone_number")
          .order("created_at", { ascending: false });

        const enriched = await Promise.all(
          (conns ?? []).map(async (c) => {
            const st = await evolution.state(c.instance_name).catch((e) => ({ error: String(e?.message ?? e) }));
            const groups = await evolution.fetchAllGroups(c.instance_name).catch(() => []);
            return {
              ...c,
              live_state: st,
              group_count: groups.length,
              sample_groups: groups.slice(0, 5).map((g: any) => ({
                jid: g.id ?? g.jid,
                subject: g.subject,
                size: g.size ?? g.participants?.length,
              })),
            };
          }),
        );

        return Response.json({ connections: enriched });
      },
    },
  },
});
