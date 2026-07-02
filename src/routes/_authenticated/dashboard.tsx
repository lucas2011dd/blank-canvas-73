import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { Cable, MessageSquare, Users, Activity, ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { getDashboardStats } from "@/lib/dashboard.functions";

const statsQuery = queryOptions({
  queryKey: ["dashboard-stats"],
  queryFn: () => getDashboardStats(),
});

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — ConnectHub" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(statsQuery),
  component: Dashboard,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
  pendingComponent: () => <DashSkeleton />,
});

function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Visão geral do seu ConnectHub.</p>
      </div>
      <Suspense fallback={<DashSkeleton />}><StatsGrid /></Suspense>
    </div>
  );
}

function StatsGrid() {
  const { data } = useSuspenseQuery(statsQuery);
  const cards = [
    { title: "Conexões totais", value: data.totalConnections, icon: Cable, sub: `${data.onlineConnections} online · ${data.offlineConnections} offline` },
    { title: "Mensagens", value: data.totalMessages, icon: MessageSquare, sub: "recebidas + enviadas" },
    { title: "Contatos", value: data.totalContacts, icon: Users, sub: "sincronizados" },
    { title: "Ações recentes", value: data.recentActivity.length, icon: Activity, sub: "últimas 24h" },
  ];
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
              <c.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{c.value}</div>
              <p className="mt-1 text-xs text-muted-foreground">{c.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Atividade recente</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentActivity.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma atividade ainda.</p>
          ) : (
            <ul className="divide-y">
              {data.recentActivity.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{a.action}</Badge>
                      {a.entity && <span className="text-sm text-muted-foreground">{a.entity}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleString("pt-BR")}
                    <ArrowUpRight className="h-3 w-3" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function DashSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
    </div>
  );
}
