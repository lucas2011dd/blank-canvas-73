import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, QrCode, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  createConnection, deleteConnection, disconnectConnection, listConnections,
  reconnectConnection, refreshConnectionStatus,
} from "@/lib/connections.functions";

const q = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });

export const Route = createFileRoute("/_authenticated/conexoes")({
  head: () => ({ meta: [{ title: "Conexões — ConnectHub" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(q),
  component: Page,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function Page() {
  const { data } = useSuspenseQuery(q);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: useServerFn(createConnection),
    onSuccess: () => { toast.success("Conexão criada"); setOpen(false); qc.invalidateQueries({ queryKey: ["connections"] }); },
    onError: (e) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: useServerFn(deleteConnection),
    onSuccess: () => { toast.success("Removida"); qc.invalidateQueries({ queryKey: ["connections"] }); },
  });
  const reconnect = useMutation({
    mutationFn: useServerFn(reconnectConnection),
    onSuccess: (row: any) => { setQr(row.qr_code); qc.invalidateQueries({ queryKey: ["connections"] }); },
    onError: (e) => toast.error(e.message),
  });
  const disc = useMutation({
    mutationFn: useServerFn(disconnectConnection),
    onSuccess: () => { toast.success("Desconectada"); qc.invalidateQueries({ queryKey: ["connections"] }); },
  });
  const refresh = useServerFn(refreshConnectionStatus);

  // Poll status a cada 5s para conexões em connecting
  useEffect(() => {
    const connecting = data.filter((c: any) => c.status === "connecting");
    if (connecting.length === 0) return;
    const t = setInterval(async () => {
      await Promise.all(connecting.map((c: any) => refresh({ data: { id: c.id } }).catch(() => null)));
      qc.invalidateQueries({ queryKey: ["connections"] });
    }, 5000);
    return () => clearInterval(t);
  }, [data, qc, refresh]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Conexões</h1>
          <p className="text-muted-foreground">Gerencie suas conexões WhatsApp, Telegram e customizadas.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-2 h-4 w-4" /> Nova conexão</Button></DialogTrigger>
          <DialogContent>
            <form onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              create.mutate({ data: { name: String(fd.get("name")), description: String(fd.get("description") || ""), provider: fd.get("provider") as "whatsapp" } });
            }}>
              <DialogHeader><DialogTitle>Nova conexão</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <div><Label htmlFor="name">Nome</Label><Input id="name" name="name" required maxLength={120} /></div>
                <div><Label htmlFor="description">Descrição</Label><Input id="description" name="description" maxLength={500} /></div>
                <div>
                  <Label htmlFor="provider">Provedor</Label>
                  <select id="provider" name="provider" className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
                    <option value="whatsapp">WhatsApp</option>
                    <option value="telegram">Telegram</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
              </div>
              <DialogFooter><Button type="submit" disabled={create.isPending}>Criar</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {data.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhuma conexão ainda. Crie a primeira.</CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{c.name}</CardTitle>
                    <CardDescription className="text-xs">{c.provider}</CardDescription>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {c.description && <p className="text-sm text-muted-foreground">{c.description}</p>}
                <p className="text-xs text-muted-foreground">
                  Criada em {new Date(c.created_at).toLocaleDateString("pt-BR")}
                  {c.last_sync_at && ` · Última sync: ${new Date(c.last_sync_at).toLocaleTimeString("pt-BR")}`}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => reconnect.mutate({ data: { id: c.id } })}>
                    <RefreshCw className="mr-1 h-3 w-3" /> Reconectar
                  </Button>
                  {c.status !== "offline" && (
                    <Button size="sm" variant="outline" onClick={() => disc.mutate({ data: { id: c.id } })}>
                      Desconectar
                    </Button>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="ghost" className="ml-auto text-destructive"><Trash2 className="h-4 w-4" /></Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Excluir conexão?</AlertDialogTitle>
                        <AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => del.mutate({ data: { id: c.id } })}>Excluir</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!qr} onOpenChange={() => setQr(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><QrCode className="h-5 w-5" /> Escaneie o QR Code</DialogTitle></DialogHeader>
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="rounded-lg bg-white p-4">
              <img alt="QR" width={220} height={220} src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qr ?? "")}`} />
            </div>
            <p className="text-center text-xs text-muted-foreground">Abra o WhatsApp → Aparelhos conectados → Conectar</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    online: { label: "Online", className: "bg-success text-success-foreground" },
    offline: { label: "Offline", className: "bg-muted text-muted-foreground" },
    connecting: { label: "Conectando", className: "bg-warning text-warning-foreground" },
    error: { label: "Erro", className: "bg-destructive text-destructive-foreground" },
  };
  const s = map[status] ?? map.offline;
  return <Badge className={s.className}><Circle className="mr-1 h-2 w-2 fill-current" /> {s.label}</Badge>;
}
