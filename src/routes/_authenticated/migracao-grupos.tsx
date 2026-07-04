import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { UsersRound, Play, Pause, X, Zap, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { listConnections, listWhatsappGroups } from "@/lib/connections.functions";
import {
  controlGroupMigration, listGroupMigrations, previewGroupParticipants,
  runGroupMigrationNow, startGroupMigration, tickMyMigrations,
} from "@/lib/migrations.functions";

import { BrGeoFilter } from "@/components/br-geo-filter";

const connQ = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });
const migQ = queryOptions({ queryKey: ["group-migrations"], queryFn: () => listGroupMigrations() });
const AUTO_TICK_LEASE_KEY = "connecthub:group-migration-auto-tick";

function readAutoTickLease() {
  try {
    const raw = window.localStorage.getItem(AUTO_TICK_LEASE_KEY);
    return raw ? JSON.parse(raw) as { owner?: string; expiresAt?: number } : null;
  } catch {
    window.localStorage.removeItem(AUTO_TICK_LEASE_KEY);
    return null;
  }
}

export const Route = createFileRoute("/_authenticated/migracao-grupos")({
  head: () => ({ meta: [{ title: "Migração de Grupos — ConnectHub" }] }),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(connQ),
    context.queryClient.ensureQueryData(migQ),
  ]),
  component: Page,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function Page() {
  const qc = useQueryClient();
  const { data: connections } = useSuspenseQuery(connQ);
  const { data: migrations } = useSuspenseQuery(migQ);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const ch = supabase.channel("gm-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "group_migrations" }, () => qc.invalidateQueries({ queryKey: ["group-migrations"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "group_migration_targets" }, () => qc.invalidateQueries({ queryKey: ["group-migrations"] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  // Auto-tick client-side: enquanto houver migração "running", dispara o
  // worker do usuário a cada 15s para que os batches avancem sozinhos sem
  // depender de cron externo nem de cliques manuais em "Iniciar/Batch agora".
  const hasRunning = useMemo(
    () => (migrations ?? []).some((m: any) => m.status === "running"),
    [migrations],
  );
  const tickFn = useServerFn(tickMyMigrations);
  const autoTickInFlight = useRef(false);
  const autoTickTabId = useRef(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()));
  useEffect(() => {
    if (!hasRunning) return;
    let stopped = false;
    const run = async () => {
      if (autoTickInFlight.current) return;
      const now = Date.now();
      const lease = readAutoTickLease();
      if (lease?.owner && lease.owner !== autoTickTabId.current && Number(lease.expiresAt ?? 0) > now) return;
      window.localStorage.setItem(AUTO_TICK_LEASE_KEY, JSON.stringify({ owner: autoTickTabId.current, expiresAt: now + 28_000 }));
      autoTickInFlight.current = true;
      try {
        await tickFn();
        if (!stopped) qc.invalidateQueries({ queryKey: ["group-migrations"] });
      } catch { /* silencioso */ }
      finally { autoTickInFlight.current = false; }
    };
    run();
    const id = setInterval(run, 30_000);
    return () => {
      stopped = true;
      clearInterval(id);
      const lease = readAutoTickLease();
      if (lease?.owner === autoTickTabId.current) window.localStorage.removeItem(AUTO_TICK_LEASE_KEY);
    };
  }, [hasRunning, tickFn, qc]);


  const onlineConns = useMemo(
    () => connections.filter((c: any) => c.provider === "whatsapp" && c.status === "online"),
    [connections],
  );

  const control = useMutation({
    mutationFn: useServerFn(controlGroupMigration),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["group-migrations"] }),
  });
  const runNow = useMutation({
    mutationFn: useServerFn(runGroupMigrationNow),
    onSuccess: (r: any) => {
      if (r?.completed) toast.success("Migração concluída");
      else if (r?.skipped) toast.info(`Ignorado: ${r.reason}`);
      else toast.success(`Batch: +${r.added} adicionados, ${r.failed} falhas, ${r.skipped} ignorados`);
      qc.invalidateQueries({ queryKey: ["group-migrations"] });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <UsersRound className="h-7 w-7" /> Migração de Grupos
          </h1>
          <p className="text-muted-foreground">Copie participantes de um grupo para outro com técnicas anti-restrição.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={onlineConns.length === 0}>Nova migração</Button>
          </DialogTrigger>
          <NewMigrationDialog connections={onlineConns} onDone={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["group-migrations"] }); }} />
        </Dialog>
      </div>

      {onlineConns.length === 0 && (
        <Card className="p-4 text-sm text-muted-foreground">
          Nenhuma conexão WhatsApp online. Conecte um WhatsApp em <b>Conexões</b> primeiro.
        </Card>
      )}

      <div className="grid gap-3">
        {migrations.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">Nenhuma migração ainda.</Card>
        ) : migrations.map((m: any) => {
          const done = (m.added_count ?? 0) + (m.failed_count ?? 0) + (m.skipped_count ?? 0);
          const pct = m.total ? Math.round((done / m.total) * 100) : 0;
          return (
            <Card key={m.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{m.source_group_subject || m.source_group_jid}</span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-medium truncate">{m.target_group_subject || m.target_group_jid || "—"}</span>
                    <Badge variant={
                      m.status === "completed" ? "default" :
                      m.status === "running" ? "secondary" :
                      m.status === "failed" || m.status === "canceled" ? "destructive" : "outline"
                    }>{m.status}</Badge>
                    <Badge variant="outline">{m.mode === "new_group" ? "novo grupo" : "grupo existente"}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Batch {m.batch_size} · delay {m.min_delay_seconds}–{m.max_delay_seconds}s ·
                    {" "}✅ {m.added_count} · ⚠️ {m.skipped_count} · ❌ {m.failed_count} de {m.total}
                  </p>
                  {m.last_error && <p className="text-xs text-destructive mt-1">Erro: {m.last_error}</p>}
                </div>
                <div className="flex gap-1">
                  {m.status === "running" && (
                    <Button size="sm" variant="outline" onClick={() => runNow.mutate({ data: { id: m.id } })} disabled={runNow.isPending}>
                      {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Zap className="mr-1 h-4 w-4" /> Batch agora</>}
                    </Button>
                  )}
                  {m.status === "running" && (
                    <Button size="sm" variant="ghost" onClick={() => control.mutate({ data: { id: m.id, action: "pause" } })}>
                      <Pause className="h-4 w-4" />
                    </Button>
                  )}
                  {m.status === "paused" && (
                    <Button size="sm" variant="ghost" onClick={() => control.mutate({ data: { id: m.id, action: "resume" } })}>
                      <Play className="h-4 w-4" />
                    </Button>
                  )}
                  {(m.status === "running" || m.status === "paused") && (
                    <Button size="sm" variant="ghost" onClick={() => control.mutate({ data: { id: m.id, action: "cancel" } })}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              <Progress value={pct} />
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function NewMigrationDialog({ connections, onDone }: { connections: any[]; onDone: () => void }) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [sourceJid, setSourceJid] = useState("");
  const [mode, setMode] = useState<"new_group" | "existing_group">("new_group");
  const [targetSubject, setTargetSubject] = useState("");
  const [targetJid, setTargetJid] = useState("");
  const [batchSize, setBatchSize] = useState(1);
  // CORREÇÃO: Defaults de delay aumentados para 25s/60s.
  // Valores abaixo de 20s causam device_removed no WhatsApp ao adicionar
  // membros em grupos. O WhatsApp interpreta intervalos curtos como spam.
  const [minDelay, setMinDelay] = useState(25);
  const [maxDelay, setMaxDelay] = useState(60);

  const [skipAdmins, setSkipAdmins] = useState(true);
  const [skipSelf, setSkipSelf] = useState(true);
  const [shuffleOrder, setShuffleOrder] = useState(true);
  const [maxParticipants, setMaxParticipants] = useState<number | "">("");
  const [filterStates, setFilterStates] = useState<string[]>([]);
  const [filterDdds, setFilterDdds] = useState<string[]>([]);

  const groupsQ = useQuery({
    queryKey: ["wa-groups", connectionId],
    queryFn: () => listWhatsappGroups({ data: { connectionId } }),
    enabled: !!connectionId,
  });

  const previewQ = useQuery({
    queryKey: ["preview-participants", connectionId, sourceJid],
    queryFn: () => previewGroupParticipants({ data: { connectionId, sourceGroupJid: sourceJid } }),
    enabled: !!connectionId && !!sourceJid,
    retry: false,
  });

  const start = useMutation({
    mutationFn: useServerFn(startGroupMigration),
    onSuccess: () => { toast.success("Migração iniciada — o processamento roda em background."); onDone(); },
    onError: (e) => toast.error(e.message),
  });

  const groups = groupsQ.data ?? [];
  const targetOptions = groups.filter((g: any) => g.jid !== sourceJid);

  return (
    <DialogContent className="max-w-lg w-[calc(100vw-1rem)] sm:w-full max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6">
      <DialogHeader><DialogTitle className="text-base sm:text-lg">Nova migração de grupo</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Conexão WhatsApp</Label>
          <select className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <Label>Grupo de origem</Label>
          <select className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" value={sourceJid} onChange={(e) => setSourceJid(e.target.value)}>
            <option value="">— selecione —</option>
            {groups.map((g: any) => <option key={g.jid} value={g.jid}>{g.subject} ({g.participants_count ?? 0})</option>)}
          </select>
          {previewQ.data && (
            <p className="text-xs text-muted-foreground mt-1">
              ✅ {previewQ.data.total} participantes encontrados
              {skipAdmins ? ` · ${previewQ.data.participants.filter((p: any) => p.admin).length} admin(s) serão ignorados` : ""}
            </p>
          )}
          {previewQ.error && <p className="text-xs text-destructive mt-1">{(previewQ.error as Error).message}</p>}
        </div>


        <div>
          <Label>Destino</Label>
          <div className="flex gap-2 mt-1">
            <Button type="button" size="sm" variant={mode === "new_group" ? "default" : "outline"} onClick={() => setMode("new_group")}>Criar novo grupo</Button>
            <Button type="button" size="sm" variant={mode === "existing_group" ? "default" : "outline"} onClick={() => setMode("existing_group")}>Grupo existente</Button>
          </div>
        </div>

        {mode === "new_group" ? (
          <div>
            <Label>Nome do novo grupo</Label>
            <Input value={targetSubject} onChange={(e) => setTargetSubject(e.target.value)} placeholder="Ex: Clientes VIP" />
          </div>
        ) : (
          <div>
            <Label>Grupo de destino</Label>
            <select className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" value={targetJid} onChange={(e) => setTargetJid(e.target.value)}>
              <option value="">— selecione —</option>
              {targetOptions.map((g: any) => <option key={g.jid} value={g.jid}>{g.subject}</option>)}
            </select>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            {/* CORREÇÃO: Batch fixo em 1. O servidor já força max=1. */}
            <Label className="text-xs">Batch (fixo: 1)</Label>
            <Input type="number" min={1} max={1} value={1} readOnly className="opacity-60 cursor-not-allowed" />
            <p className="text-[10px] text-muted-foreground mt-1">mínimo: 1 · máximo permitido pelo sistema: 1</p>
          </div>
          <div>
            <Label className="text-xs">Delay min (s)</Label>
            <Input
              type="number"
              min={25}
              value={minDelay}
              onChange={(e) => setMinDelay(Math.max(25, Number(e.target.value) || 25))}
            />
            <p className="text-[10px] text-muted-foreground mt-1">mínimo permitido: 25s (valores abaixo são elevados no servidor)</p>
          </div>
          <div>
            <Label className="text-xs">Delay max (s)</Label>
            <Input
              type="number"
              min={45}
              value={maxDelay}
              onChange={(e) => setMaxDelay(Math.max(45, Number(e.target.value) || 45))}
            />
            <p className="text-[10px] text-muted-foreground mt-1">mínimo permitido: 45s (valores abaixo são elevados no servidor)</p>
          </div>
        </div>

        <div className="rounded-md border p-3 space-y-2">
          <div className="text-xs font-medium">Opções anti-restrição</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={skipAdmins} onChange={(e) => setSkipAdmins(e.target.checked)} />
            Pular administradores do grupo (recomendado — evita confusão)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={skipSelf} onChange={(e) => setSkipSelf(e.target.checked)} />
            Não adicionar meu próprio número
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={shuffleOrder} onChange={(e) => setShuffleOrder(e.target.checked)} />
            Randomizar ordem de adição (mais difícil de detectar)
          </label>
          <div className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={maxParticipants !== ""} onChange={(e) => setMaxParticipants(e.target.checked ? 50 : "")} />
            <span>Limitar a</span>
            <Input type="number" min={1} max={1024} className="h-7 w-24" disabled={maxParticipants === ""} value={maxParticipants} onChange={(e) => setMaxParticipants(Number(e.target.value) || 1)} />
            <span>participantes</span>
          </div>
        </div>

        <BrGeoFilter states={filterStates} setStates={setFilterStates} ddds={filterDdds} setDdds={setFilterDdds} />

        <p className="text-xs text-muted-foreground">
          <b>Automático:</b> com o painel aberto, os batches avançam sozinhos; com cron externo, rodam 24/7.
          Adiciona com ritmo seguro: 1 contato por chamada real, delay {minDelay}–{maxDelay}s entre cada adição.
          <b> Recomendado: mínimo 25s, máximo 60s</b> para evitar que o WhatsApp detecte como spam e desconecte a sessão.
        </p>
      </div>
      <DialogFooter>
        <Button
          disabled={
            !connectionId || !sourceJid || start.isPending ||
            (mode === "new_group" && !targetSubject.trim()) ||
            (mode === "existing_group" && !targetJid)
          }
          onClick={() => start.mutate({ data: {
            connectionId, sourceGroupJid: sourceJid, mode,
            targetSubject: mode === "new_group" ? targetSubject.trim() : undefined,
            targetGroupJid: mode === "existing_group" ? targetJid : undefined,
            batchSize, minDelaySeconds: minDelay, maxDelaySeconds: maxDelay,
            excludePhones: [],
            skipAdmins, skipSelf, shuffleOrder,
            maxParticipants: maxParticipants === "" ? undefined : Number(maxParticipants),
            filterStates, filterDdds,
          } })}
        >
          {start.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Iniciar migração
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
