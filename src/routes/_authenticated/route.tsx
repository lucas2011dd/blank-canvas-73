import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { SidebarProvider, SidebarTrigger, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false, // Supabase guarda sessão em localStorage — o SSR não a vê.
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { mode: "login", redirect: location.pathname } });
    }
    return { user: data.user };
  },
  component: Layout,
});

function Layout() {
  const navigate = useNavigate();

  // Notificação global de novas mensagens recebidas
  useEffect(() => {
    const channel = supabase.channel("global-inbox")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: "direction=eq.inbound" },
        (payload: any) => {
          const msg = payload.new;
          if (!msg) return;
          const preview = String(msg.body ?? "").slice(0, 80);
          toast.message("Nova mensagem", {
            description: preview || "(sem conteúdo)",
            action: msg.conversation_id
              ? { label: "Abrir", onClick: () => navigate({ to: "/chat", search: { conv: msg.conversation_id } }) }
              : undefined,
          });
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [navigate]);

  return (
    <SidebarProvider>
      {/* min-h-dvh evita "corte" no mobile por causa da barra dinâmica do Safari */}
      <div className="min-h-dvh flex w-full overflow-x-hidden">
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/80 px-3 sm:px-4 backdrop-blur">
            <div className="flex items-center gap-2">
              <SidebarTrigger />
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
            </div>
          </header>
          {/* Padding fluido: 1rem no mobile → 1.5rem no desktop; min-w-0 impede overflow horizontal quando filhos usam grid/flex */}
          <main className="flex-1 min-w-0 p-4 sm:p-6">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
