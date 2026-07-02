import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listLogs } from "@/lib/logs.functions";

const q = queryOptions({ queryKey: ["logs"], queryFn: () => listLogs({ data: {} }) });

export const Route = createFileRoute("/_authenticated/logs")({
  head: () => ({ meta: [{ title: "Logs — ConnectHub" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(q),
  component: LogsPage,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function LogsPage() {
  const { data } = useSuspenseQuery(q);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Logs & Auditoria</h1>
        <p className="text-muted-foreground">Histórico completo de eventos da sua conta.</p>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ação</TableHead>
                <TableHead>Entidade</TableHead>
                <TableHead>Detalhes</TableHead>
                <TableHead className="text-right">Quando</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">Nenhum evento registrado.</TableCell></TableRow>
              ) : data.map((log) => (
                <TableRow key={log.id}>
                  <TableCell><Badge variant="outline">{log.action}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{log.entity ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground truncate max-w-xs">{JSON.stringify(log.metadata) === "{}" ? "—" : JSON.stringify(log.metadata)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{new Date(log.created_at).toLocaleString("pt-BR")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
