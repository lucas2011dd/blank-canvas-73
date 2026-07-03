import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, QrCode, Circle, Download, Users } from "lucide-react";
import qrGen from "qrcode-generator";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  createConnection, deleteConnection, disconnectConnection, listConnections,
  reconnectConnection, refreshConnectionStatus, syncWhatsappConnection,
  listWhatsappGroups, toggleGroupMonitored,
} from "@/lib/connections.functions";
import { Checkbox } from "@/components/ui/checkbox";


const q = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });

function rawCodeToSvgDataUrl(text: string): string {
  const qr = qrGen(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cell = 8;
  const margin = 16;
  const size = count * cell + margin * 2;
  const rects: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) rects.push(`<rect x="${margin + c * cell}" y="${margin + r * cell}" width="${cell}" height="${cell}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
  return `data:image/svg+xml;base64,${window.btoa(svg)}`;
}

function normalizeQrSrc(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:image/")) return trimmed;
  if (trimmed.startsWith("<svg")) return `data:image/svg+xml;base64,${window.btoa(trimmed)}`;

  const compact = trimmed.replace(/\s/g, "");
  const looksLikeImageBase64 = (
    compact.startsWith("iVBORw0KGgo") ||
    compact.startsWith("/9j/") ||
    compact.startsWith("R0lGOD") ||
    compact.startsWith("PHN2Zy") ||
    compact.length > 800
  ) && /^[A-Za-z0-9+/]+=*$/.test(compact);
  if (looksLikeImageBase64) {
    const mime = compact.startsWith("PHN2Zy") ? "image/svg+xml" : "image/png";
    return `data:${mime};base64,${compact}`;
  }

  return rawCodeToSvgDataUrl(trimmed);
}

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
  const [groupsFor, setGroupsFor] = useState<string | null>(null);
  const qrSrc = normalizeQrSrc(qr);


  const create = useMutation({
    mutationFn: useServerFn(createConnection),
    onSuccess: (row: any) => {
      toast.success("Conexão criada");
      setOpen(false);
      if (row?.qr_code) setQr(row.qr_code);
      else if (row?.provider === "whatsapp") toast.info("QR não gerado — clique em Reconectar");
      qc.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: useServerFn(deleteConnection),
    onSuccess: () => { toast.success("Removida"); qc.invalidateQueries({ queryKey: ["connections"] }); },
  });
  const reconnect = useMutation({
    mutationFn: useServerFn(reconnectConnection),
    onSuccess: (row: any) => {
      if (row?.qr_code) setQr(row.qr_code);
      else if (row?.status === "online") toast.success("WhatsApp já está online.");
      else toast.error("A Evolution não retornou QR nesta tentativa. A instância foi recriada; clique em Reconectar novamente se necessário.");
      qc.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const disc = useMutation({
    mutationFn: useServerFn(disconnectConnection),
    onSuccess: () => { toast.success("Desconectada"); qc.invalidateQueries({ queryKey: ["connections"] }); },
  });
  const sync = useMutation({
    mutationFn: useServerFn(syncWhatsappConnection),
    onSuccess: (r: any) => {
      toast.success(`Sync: ${r.contactsUpserted} contatos, ${r.conversationsUpserted} conversas, ${r.groupsUpserted} grupos`);
      qc.invalidateQueries();
    },
    onError: (e) => toast.error(e.message),
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

  // Realtime — reage a mudanças na tabela connections sem esperar polling
  useEffect(() => {
    const channel = supabase.channel("connections-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "connections" }, () => {
        qc.invalidateQueries({ queryKey: ["connections"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);


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
                  {c.qr_code && c.status !== "online" && (
                    <Button size="sm" variant="outline" onClick={() => setQr(c.qr_code)}>
                      <QrCode className="mr-1 h-3 w-3" /> QR
                    </Button>
                  )}
                  {c.provider === "whatsapp" && c.status === "online" && (() => {
                    const isSyncingThis = sync.isPending && (sync.variables as any)?.data?.id === c.id;
                    return (
                      <>
                        <Button size="sm" variant="outline" onClick={() => sync.mutate({ data: { id: c.id } })} disabled={sync.isPending}>
                          {isSyncingThis ? (
                            <><RefreshCw className="mr-1 h-3 w-3 animate-spin" /> Sincronizando…</>
                          ) : (
                            <><Download className="mr-1 h-3 w-3" /> Sincronizar</>
                          )}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setGroupsFor(c.id)} disabled={isSyncingThis}>
                          <Users className="mr-1 h-3 w-3" /> Grupos
                        </Button>
                      </>
                    );
                  })()}
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
              {qrSrc ? (
                <img
                  alt="QR"
                  width={260}
                  height={260}
                  className="block h-[260px] w-[260px]"
                  src={qrSrc}
                />
              ) : null}
            </div>
            <p className="text-center text-xs text-muted-foreground">Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
            <p className="text-center text-xs text-muted-foreground">O status será atualizado automaticamente após pareamento.</p>
          </div>
        </DialogContent>
      </Dialog>

      <GroupsDialog connectionId={groupsFor} onClose={() => setGroupsFor(null)} />
    </div>
  );
}

function GroupsDialog({ connectionId, onClose }: { connectionId: string | null; onClose: () => void }) {
  const listGroups = useServerFn(listWhatsappGroups);
  const toggle = useServerFn(toggleGroupMonitored);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connectionId) return;
    setLoading(true);
    listGroups({ data: { connectionId } })
      .then((r) => setGroups(r as any[]))
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [connectionId, listGroups]);

  return (
    <Dialog open={!!connectionId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> Grupos do WhatsApp</DialogTitle></DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto py-2">
          {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!loading && groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nenhum grupo sincronizado ainda. Clique em <b>Sincronizar</b> primeiro.
            </p>
          )}
          {groups.map((g) => (
            <label key={g.id} className="flex items-center justify-between gap-3 rounded-md border p-3 hover:bg-accent">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{g.subject}</p>
                <p className="text-xs text-muted-foreground">{g.participants_count ?? 0} participantes</p>
              </div>
              <Checkbox
                checked={g.monitored}
                onCheckedChange={async (v) => {
                  const monitored = v === true;
                  setGroups((cur) => cur.map((x) => x.id === g.id ? { ...x, monitored } : x));
                  try { await toggle({ data: { id: g.id, monitored } }); }
                  catch (e: any) { toast.error(e.message); }
                }}
              />
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Marque para receber mensagens do grupo dentro do chat.</p>
      </DialogContent>
    </Dialog>
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
