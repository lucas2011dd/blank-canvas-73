import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { UsersRound, Play, Pause, X, Zap, Loader2, ArrowRight, Timer, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
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
  runGroupMigrationNow, startGroupMigration,
} from "@/lib/migrations.functions";

import { BrGeoFilter } from "@/components/br-geo-filter";

const connQ = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });
const migQ = queryOptions({ queryKey: ["group-migrations"], queryFn: () => listGroupMigrations() });

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
      <div className="flex items-center justify-between gap-4 flex-wrap animate-fade-in">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-hero shadow-glow">
              <UsersRound className="h-5 w-5 text-primary-foreground" />
              <span className="absolute inset-0 rounded-xl ring-1 ring-white/20 animate-pulse" />
            </span>
            Migração de Grupos
          </h1>
          <p className="text-muted-foreground">Copie participantes de um grupo para outro com técnicas anti-restrição.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={onlineConns.length === 0} className="hover-lift">
              <Sparkles className="mr-2 h-4 w-4" /> Nova migração
            </Button>
          </DialogTrigger>
          <NewMigrationDialog connections={onlineConns} onDone={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["group-migrations"] }); }} />
        </Dialog>
      </div>

      {onlineConns.length === 0 && (
        <Card className="p-4 text-sm text-muted-foreground animate-fade-in">
          Nenhuma conexão WhatsApp online. Conecte um WhatsApp em <b>Conexões</b> primeiro.
        </Card>
      )}

      <div className="grid gap-3 stagger-in">
        {migrations.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">Nenhuma migração ainda.</Card>
        ) : migrations.map((m: any) => {
          const done = (m.added_count ?? 0) + (m.failed_count ?? 0) + (m.skipped_count ?? 0);
          const pct = m.total ? Math.round((done / m.total) * 100) : 0;
          const isRunning = m.status === "running";
          const isFirst = isRunning && done === 0;
          return (
            <Card key={m.id} className="p-4 space-y-3 card-premium card-premium-hover relative overflow-hidden">
              {isRunning && (
                <span className="pointer-events-none absolute -top-px left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent animate-shimmer" />
              )}
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{m.source_group_subject || m.source_group_jid}</span>
                    <ArrowRight className={`h-4 w-4 text-muted-foreground shrink-0 ${isRunning ? "animate-pulse" : ""}`} />
                    <span className="font-medium truncate">{m.target_group_subject || m.target_group_jid || "—"}</span>
                    <Badge variant={
                      m.status === "completed" ? "default" :
                      m.status === "running" ? "secondary" :
                      m.status === "failed" || m.status === "canceled" ? "destructive" : "outline"
                    } className={isRunning ? "animate-pulse" : ""}>
                      {m.status === "completed" && <CheckCircle2 className="mr-1 h-3 w-3 inline" />}
                      {(m.status === "failed" || m.status === "canceled") && <AlertTriangle className="mr-1 h-3 w-3 inline" />}
                      {m.status}
                    </Badge>
                    <Badge variant="outline">{m.mode === "new_group" ? "novo grupo" : "grupo existente"}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Batch {m.batch_size} · delay {m.min_delay_seconds}–{m.max_delay_seconds}s ·
                    {" "}✅ {m.added_count} · ⚠️ {m.skipped_count} · ❌ {m.failed_count} de {m.total}
                  </p>
                  {(isRunning || m.status === "paused") && (
                    <Countdown
                      target={m.next_attempt_at}
                      label={isFirst ? "Primeiro catch em" : "Próximo catch em"}
                      paused={m.status === "paused"}
                    />
                  )}
                  {m.last_error && <p className="text-xs text-destructive mt-1 animate-fade-in">Erro: {m.last_error}</p>}
                </div>
                <div className="flex gap-1">
                  {isRunning && (
                    <Button size="sm" variant="outline" className="hover-lift" onClick={() => runNow.mutate({ data: { id: m.id } })} disabled={runNow.isPending}>
                      {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Zap className="mr-1 h-4 w-4" /> Batch agora</>}
                    </Button>
                  )}
                  {isRunning && (
                    <Button size="sm" variant="ghost" onClick={() => control.mutate({ data: { id: m.id, action: "pause" } })}>
                      <Pause className="h-4 w-4" />
                    </Button>
                  )}
                  {m.status === "paused" && (
                    <Button size="sm" variant="ghost" onClick={() => control.mutate({ data: { id: m.id, action: "resume" } })}>
                      <Play className="h-4 w-4" />
                    </Button>
                  )}
                  {(isRunning || m.status === "paused") && (
                    <Button size="sm" variant="ghost" onClick={() => control.mutate({ data: { id: m.id, action: "cancel" } })}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="relative">
                <Progress value={pct} className="transition-all duration-700" />
                {isRunning && (
                  <span className="pointer-events-none absolute inset-0 rounded-full overflow-hidden">
                    <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-shimmer" />
                  </span>
                )}
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
                  <span>{done}/{m.total}</span>
                  <span>{pct}%</span>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Countdown({ target, label, paused }: { target: string | null | undefined; label: string; paused?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!target) {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Timer className="h-3 w-3" /> {paused ? "Pausado" : "Aguardando agendamento…"}
      </div>
    );
  }
  const diff = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  const mm = String(Math.floor(diff / 60)).padStart(2, "0");
  const ss = String(diff % 60).padStart(2, "0");
  const running = !paused && diff > 0;
  const ready = !paused && diff === 0;
  return (
    <div className={`mt-2 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors ${
      paused ? "bg-muted/40 text-muted-foreground" :
      ready ? "bg-primary/10 border-primary/30 text-primary" :
      "bg-accent/40 border-accent text-accent-foreground"
    }`}>
      <Timer className={`h-3 w-3 ${running ? "animate-spin" : ""}`} style={running ? { animationDuration: "3s" } : undefined} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{paused ? "—" : ready ? "executando…" : `${mm}:${ss}`}</span>
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
  const [minDelay, setMinDelay] = useState(180);
  const [maxDelay, setMaxDelay] = useState(300);

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
              {skipAdmins ? ` · ${previewQ.data.adminCount ?? 0} admin(s) serão ignorados` : ""}
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
              min={180}
              value={minDelay}
              onChange={(e) => setMinDelay(Math.max(180, Number(e.target.value) || 180))}
            />
            <p className="text-[10px] text-muted-foreground mt-1">mínimo permitido: 180s</p>
          </div>
          <div>
            <Label className="text-xs">Delay max (s)</Label>
            <Input
              type="number"
              min={300}
              value={maxDelay}
              onChange={(e) => setMaxDelay(Math.max(300, Number(e.target.value) || 300))}
            />
            <p className="text-[10px] text-muted-foreground mt-1">mínimo permitido: 300s</p>
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
          Modo humano avançado ativo: cadência com jitter log-normal, warm-up nos 5 primeiros adds,
          coffee breaks aleatórios a cada 6–10 adds (20–45min), quiet hours 22h–08h (SP) e limite
          diário por conexão. Base configurada: 1 add por catch, delay {minDelay}–{maxDelay}s
          (o sistema aumenta automaticamente conforme o padrão humano).
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
