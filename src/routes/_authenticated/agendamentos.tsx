import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Trash2, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { listScheduled, createScheduled, cancelScheduled, deleteScheduled, runScheduledNow } from "@/lib/scheduler.functions";
import { listConnections, listWhatsappGroups } from "@/lib/connections.functions";
import { toast } from "sonner";

const listQ = queryOptions({ queryKey: ["scheduled"], queryFn: () => listScheduled() });
const connQ = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });

export const Route = createFileRoute("/_authenticated/agendamentos")({
  head: () => ({ meta: [{ title: "Agendamentos — ConnectHub" }] }),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(listQ),
    context.queryClient.ensureQueryData(connQ),
  ]),
  component: SchedPage,
  errorComponent: ({ error }) => <div className="text-destructive">{error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function SchedPage() {
  const qc = useQueryClient();
  const { data: rows } = useSuspenseQuery(listQ);
  const { data: connections } = useSuspenseQuery(connQ);
  const [open, setOpen] = useState(false);
  const whatsapps = useMemo(() => connections.filter((c: any) => c.provider === "whatsapp"), [connections]);

  useEffect(() => {
    const ch = supabase.channel("sched-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "scheduled_messages" }, () => qc.invalidateQueries({ queryKey: ["scheduled"] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const create = useMutation({
    mutationFn: useServerFn(createScheduled),
    onSuccess: () => { toast.success("Agendado"); setOpen(false); qc.invalidateQueries({ queryKey: ["scheduled"] }); },
    onError: (e) => toast.error(e.message),
  });
  const cancel = useMutation({ mutationFn: useServerFn(cancelScheduled), onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduled"] }) });
  const del = useMutation({ mutationFn: useServerFn(deleteScheduled), onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduled"] }) });
  const now = useMutation({
    mutationFn: useServerFn(runScheduledNow),
    onSuccess: () => { toast.success("Enviado"); qc.invalidateQueries({ queryKey: ["scheduled"] }); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><CalendarClock className="h-6 w-6" /> Mensagens agendadas</h1>
          <p className="text-sm text-muted-foreground">Envio programado para contato ou grupo — com recorrência opcional.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>Nova mensagem</Button></DialogTrigger>
          <NewSchedDialog connections={whatsapps} onSubmit={(v: any) => create.mutate({ data: v })} pending={create.isPending} />
        </Dialog>
      </div>

      <div className="grid gap-3">
        {rows.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">Nenhum agendamento.</Card>
        ) : rows.map((r: any) => (
          <Card key={r.id} className="p-4 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={r.status === "sent" ? "secondary" : r.status === "failed" ? "destructive" : r.status === "canceled" ? "outline" : "default"}>{r.status}</Badge>
                <Badge variant="outline">{r.target_kind === "group" ? "Grupo" : "Contato"}</Badge>
                <span className="text-sm font-medium truncate">{r.target_label ?? r.target}</span>
                {r.recurrence !== "none" && <Badge variant="outline">{r.recurrence}</Badge>}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{new Date(r.scheduled_at).toLocaleString("pt-BR")}</div>
              <div className="mt-2 text-sm line-clamp-2">{r.body}</div>
              {r.last_error && <div className="mt-1 text-xs text-destructive">{r.last_error}</div>}
            </div>
            <div className="flex flex-col gap-1">
              {r.status === "pending" && <Button size="sm" variant="secondary" onClick={() => now.mutate({ data: { id: r.id } })} disabled={now.isPending}>{now.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}</Button>}
              {r.status === "pending" && <Button size="sm" variant="outline" onClick={() => cancel.mutate({ data: { id: r.id } })}>Cancelar</Button>}
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("Excluir?")) del.mutate({ data: { id: r.id } }); }}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-4 text-xs text-muted-foreground">
        Para envio automático no horário programado, configure um cron externo apontando para
        <code className="mx-1 rounded bg-muted px-1">/api/public/wa/tick?secret=SEU_TICK_SECRET</code>
        (a cada 1 min). No preview, use o botão <em>Enviar</em> ao lado de cada mensagem.
      </Card>
    </div>
  );
}

function NewSchedDialog({ connections, onSubmit, pending }: any) {
  const [connId, setConnId] = useState("");
  const [kind, setKind] = useState<"phone" | "group">("phone");
  const { data: groups = [] } = useQuery({
    queryKey: ["groups", connId],
    queryFn: () => listWhatsappGroups({ data: { connectionId: connId } }),
    enabled: !!connId && kind === "group",
  });

  return (
    <DialogContent>
      <form onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const target = kind === "group" ? String(fd.get("groupJid") || "") : String(fd.get("phone") || "");
        const label = kind === "group"
          ? (groups.find((g: any) => g.jid === target)?.subject ?? "")
          : String(fd.get("phone") || "");
        const payload = {
          connectionId: connId,
          targetKind: kind,
          target,
          targetLabel: label,
          body: String(fd.get("body") || "").trim(),
          scheduledAt: new Date(String(fd.get("scheduledAt"))).toISOString(),
          recurrence: String(fd.get("recurrence") || "none") as "none" | "daily" | "weekly",
        };
        if (!payload.connectionId) return toast.error("Escolha a conexão");
        if (!payload.target) return toast.error("Informe o destino");
        onSubmit(payload);
      }}>
        <DialogHeader><DialogTitle>Nova mensagem agendada</DialogTitle></DialogHeader>
        <div className="space-y-3 py-4">
          <div>
            <Label>Conexão</Label>
            <select value={connId} onChange={(e) => setConnId(e.target.value)} className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
              <option value="">— Selecione —</option>
              {connections.map((c: any) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
            </select>
          </div>
          <div>
            <Label>Destino</Label>
            <div className="mt-2 flex gap-2">
              <select value={kind} onChange={(e) => setKind(e.target.value as any)} className="rounded-md border bg-background px-3 py-2 text-sm">
                <option value="phone">Contato</option>
                <option value="group">Grupo</option>
              </select>
              {kind === "phone" ? (
                <Input name="phone" placeholder="5511999999999" maxLength={20} className="flex-1" />
              ) : (
                <select name="groupJid" className="flex-1 rounded-md border bg-background px-3 py-2 text-sm">
                  <option value="">— Grupo —</option>
                  {groups.map((g: any) => <option key={g.jid} value={g.jid}>{g.subject}</option>)}
                </select>
              )}
            </div>
          </div>
          <div><Label>Mensagem</Label><Textarea name="body" required rows={4} maxLength={4000} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Data/Hora</Label><Input name="scheduledAt" type="datetime-local" required /></div>
            <div><Label>Recorrência</Label>
              <select name="recurrence" defaultValue="none" className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
                <option value="none">Uma vez</option>
                <option value="daily">Diária</option>
                <option value="weekly">Semanal</option>
              </select>
            </div>
          </div>
        </div>
        <DialogFooter><Button type="submit" disabled={pending}>Agendar</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}
