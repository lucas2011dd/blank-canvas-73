import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Megaphone, Play, Pause, Trash2, X, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { listBroadcasts, createBroadcast, controlBroadcast, runBroadcastTick } from "@/lib/broadcasts.functions";
import { listConnections } from "@/lib/connections.functions";
import { listContacts } from "@/lib/contacts.functions";
import { toast } from "sonner";
import { BrGeoFilter } from "@/components/br-geo-filter";

const bcQ = queryOptions({ queryKey: ["broadcasts"], queryFn: () => listBroadcasts() });
const connQ = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });
// Contatos podem ser milhares — carregamos sob demanda ao abrir o diálogo de
// novo disparo, não no load da rota.
const contactsQ = queryOptions({
  queryKey: ["contacts"],
  queryFn: () => listContacts({ data: {} }),
  staleTime: 60_000,
});

export const Route = createFileRoute("/_authenticated/broadcasts")({
  head: () => ({ meta: [{ title: "Disparos — ConnectHub" }] }),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(bcQ),
    context.queryClient.ensureQueryData(connQ),
  ]),
  component: BroadcastsPage,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function BroadcastsPage() {
  const qc = useQueryClient();
  const { data: broadcasts } = useSuspenseQuery(bcQ);
  const { data: connections } = useSuspenseQuery(connQ);
  const [open, setOpen] = useState(false);
  const contactsLazy = useQuery({ ...contactsQ, enabled: open });
  const contacts = contactsLazy.data ?? [];


  useEffect(() => {
    const ch = supabase.channel("bc-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "broadcasts" }, () => qc.invalidateQueries({ queryKey: ["broadcasts"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "broadcast_targets" }, () => qc.invalidateQueries({ queryKey: ["broadcasts"] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const create = useMutation({
    mutationFn: useServerFn(createBroadcast),
    onSuccess: () => { toast.success("Disparo criado"); setOpen(false); qc.invalidateQueries({ queryKey: ["broadcasts"] }); },
    onError: (e) => toast.error(e.message),
  });
  const ctrl = useMutation({
    mutationFn: useServerFn(controlBroadcast),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["broadcasts"] }),
    onError: (e) => toast.error(e.message),
  });
  const tick = useMutation({
    mutationFn: useServerFn(runBroadcastTick),
    onSuccess: (r: any) => toast.success(`${r.processed} mensagens processadas`),
    onError: (e) => toast.error(e.message),
  });

  const whatsapps = useMemo(() => connections.filter((c: any) => c.provider === "whatsapp"), [connections]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Megaphone className="h-6 w-6" /> Disparos em massa</h1>
          <p className="text-sm text-muted-foreground">Envio com delay aleatório e template dinâmico (antiban).</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>Novo disparo</Button></DialogTrigger>
          <NewBroadcastDialog connections={whatsapps} contacts={contacts} onSubmit={(v: any) => create.mutate({ data: v })} pending={create.isPending} />
        </Dialog>
      </div>

      <div className="grid gap-4">
        {broadcasts.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">Nenhum disparo criado ainda.</Card>
        ) : broadcasts.map((b: any) => {
          const pct = b.total_recipients ? Math.round(((b.sent_count + b.failed_count) / b.total_recipients) * 100) : 0;
          return (
            <Card key={b.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{b.name}</span>
                    <Badge variant={b.status === "running" ? "default" : b.status === "completed" ? "secondary" : "outline"}>{b.status}</Badge>
                    <span className="text-xs text-muted-foreground">delay {b.min_delay_seconds}-{b.max_delay_seconds}s</span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">{b.sent_count}/{b.total_recipients} enviadas · {b.failed_count} falhas</div>
                  <Progress value={pct} className="mt-2" />
                </div>
                <div className="flex flex-col gap-1">
                  {b.status === "draft" || b.status === "paused" ? (
                    <Button size="sm" variant="default" onClick={() => ctrl.mutate({ data: { id: b.id, action: b.status === "draft" ? "start" : "resume" } })}><Play className="h-3 w-3 mr-1" />Iniciar</Button>
                  ) : b.status === "running" ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => tick.mutate({ data: { id: b.id, max: 1 } })} disabled={tick.isPending}>
                        {tick.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Zap className="h-3 w-3 mr-1" />}Enviar agora
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => ctrl.mutate({ data: { id: b.id, action: "pause" } })}><Pause className="h-3 w-3 mr-1" />Pausar</Button>
                      <Button size="sm" variant="ghost" onClick={() => ctrl.mutate({ data: { id: b.id, action: "cancel" } })}><X className="h-3 w-3 mr-1" />Cancelar</Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("Excluir?")) ctrl.mutate({ data: { id: b.id, action: "delete" } }); }}>
                    <Trash2 className="h-3 w-3 mr-1" />Excluir
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="p-4 text-xs text-muted-foreground">
        <strong>Antiban:</strong> mensagens saem com intervalo aleatório entre os delays configurados. Para envio automático 24/7, configure um cron externo chamando
        <code className="mx-1 rounded bg-muted px-1">/api/public/wa/tick?secret=SEU_TICK_SECRET</code>
        a cada 1 minuto (defina o secret <code>TICK_SECRET</code>). No preview, use o botão <em>Enviar agora</em>.
      </Card>
    </div>
  );
}

function NewBroadcastDialog({ connections, contacts, onSubmit, pending }: any) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filterStates, setFilterStates] = useState<string[]>([]);
  const [filterDdds, setFilterDdds] = useState<string[]>([]);
  const filtered = useMemo(() => contacts.filter((c: any) => !query || (c.name ?? "").toLowerCase().includes(query.toLowerCase()) || (c.phone ?? "").includes(query)), [contacts, query]);

  return (
    <DialogContent className="max-w-2xl">
      <form onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const phonesRaw = String(fd.get("phones") || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        const payload = {
          name: String(fd.get("name") || "").trim(),
          connectionId: String(fd.get("connectionId") || ""),
          template: String(fd.get("template") || "").trim(),
          minDelaySeconds: Number(fd.get("min") || 30),
          maxDelaySeconds: Number(fd.get("max") || 90),
          scheduledAt: fd.get("scheduledAt") ? new Date(String(fd.get("scheduledAt"))).toISOString() : null,
          contactIds: Array.from(selected),
          phones: phonesRaw,
          filterStates, filterDdds,
        };
        if (!payload.connectionId) return toast.error("Escolha a conexão");
        if (!payload.contactIds.length && !payload.phones.length) return toast.error("Selecione contatos ou informe telefones");
        onSubmit(payload);
      }}>
        <DialogHeader><DialogTitle>Novo disparo</DialogTitle></DialogHeader>
        <div className="space-y-4 py-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Nome</Label><Input name="name" required maxLength={120} placeholder="Promoção Setembro" /></div>
            <div>
              <Label>Conexão WhatsApp</Label>
              <select name="connectionId" required className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
                <option value="">— Selecione —</option>
                {connections.map((c: any) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
              </select>
            </div>
          </div>
          <div>
            <Label>Mensagem (use {"{nome}"} e {"{telefone}"})</Label>
            <Textarea name="template" required maxLength={4000} rows={4} placeholder="Olá {nome}, temos uma novidade..." />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><Label>Delay mín (s)</Label><Input name="min" type="number" min={30} max={600} defaultValue={30} /></div>
            <div><Label>Delay máx (s)</Label><Input name="max" type="number" min={90} max={3600} defaultValue={90} /></div>
            <div><Label>Agendar (opcional)</Label><Input name="scheduledAt" type="datetime-local" /></div>
          </div>
          <div>
            <Label>Telefones avulsos (vírgula ou linha, com DDI)</Label>
            <Textarea name="phones" rows={2} placeholder="5511999999999, 5511888888888" />
          </div>
          <BrGeoFilter states={filterStates} setStates={setFilterStates} ddds={filterDdds} setDdds={setFilterDdds} />
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Contatos ({selected.size} selecionados)</Label>
              <Input className="w-48" placeholder="Buscar..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="max-h-60 overflow-y-auto rounded border">
              {filtered.length === 0 ? <div className="p-4 text-center text-sm text-muted-foreground">Nenhum contato</div> :
                filtered.map((c: any) => (
                  <label key={c.id} className="flex items-center gap-2 border-b px-3 py-2 text-sm hover:bg-accent cursor-pointer">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => {
                      const s = new Set(selected); e.target.checked ? s.add(c.id) : s.delete(c.id); setSelected(s);
                    }} />
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.phone}</span>
                  </label>
                ))}
            </div>
          </div>
        </div>
        <DialogFooter><Button type="submit" disabled={pending}>Criar</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}
