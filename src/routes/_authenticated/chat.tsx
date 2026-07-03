import { createFileRoute, useSearch } from "@tanstack/react-router";
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Send, Search, Trash2, Link2 } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { createConversation, deleteConversation, listConversations, listMessages, sendMessage } from "@/lib/chat.functions";
import { listConnections } from "@/lib/connections.functions";
import { toast } from "sonner";

const convQ = queryOptions({ queryKey: ["conversations"], queryFn: () => listConversations() });
const connQ = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });

const searchSchema = z.object({
  conv: z.string().uuid().optional(),
  phone: z.string().optional(),
  connectionId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({ meta: [{ title: "Chat — ConnectHub" }] }),
  validateSearch: (s) => searchSchema.parse(s),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(convQ),
    context.queryClient.ensureQueryData(connQ),
  ]),
  component: ChatPage,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function ChatPage() {
  const { data: conversations } = useSuspenseQuery(convQ);
  const { data: connections } = useSuspenseQuery(connQ);
  const search = useSearch({ from: "/_authenticated/chat" });
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(search.conv ?? conversations[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const create = useMutation({
    mutationFn: useServerFn(createConversation),
    onSuccess: (row: any) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      setSelected(row.id);
      setOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: useServerFn(deleteConversation),
    onSuccess: () => {
      toast.success("Conversa removida");
      setSelected(null);
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  // Deep-link (?phone=...&connectionId=...) — cria/abre conversa automaticamente
  useEffect(() => {
    if (search.phone && search.connectionId) {
      create.mutate({ data: { title: search.phone, phone: search.phone, connectionId: search.connectionId } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.phone, search.connectionId]);

  // Realtime — conversas e mensagens
  useEffect(() => {
    const channel = supabase.channel("chat-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload: any) => {
        const convId = payload.new?.conversation_id ?? payload.old?.conversation_id;
        if (convId) qc.invalidateQueries({ queryKey: ["messages", convId] });
        qc.invalidateQueries({ queryKey: ["conversations"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        qc.invalidateQueries({ queryKey: ["conversations"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);

  const filtered = conversations.filter((c) => !query || (c.title ?? "").toLowerCase().includes(query.toLowerCase()));
  const whatsapps = useMemo(() => connections.filter((c: any) => c.provider === "whatsapp"), [connections]);

  return (
    // Altura fluida via dvh (respeita a chrome do mobile) descontando header (3.5rem) + padding (2rem)
    <div className="h-[calc(100dvh-6rem)] sm:h-[calc(100dvh-7rem)]">
      {/* Mobile: pilha única mostrando a lista OU a conversa selecionada. Desktop (lg+): duas colunas. */}
      <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card className="flex flex-col overflow-hidden">
          <div className="border-b p-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-8" placeholder="Buscar..." value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild><Button size="icon"><Plus className="h-4 w-4" /></Button></DialogTrigger>
                <DialogContent>
                  <form onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const connId = String(fd.get("connectionId") || "");
                    const phone = String(fd.get("phone") || "").trim();
                    const title = String(fd.get("title") || "").trim();
                    if (connId && !phone) return toast.error("Informe o telefone (com DDI, ex: 5511999999999)");
                    if (!connId && !title) return toast.error("Informe um título");
                    create.mutate({ data: {
                      title: phone || title,
                      connectionId: connId || null,
                      phone: phone || null,
                    } });
                  }}>
                    <DialogHeader><DialogTitle>Nova conversa</DialogTitle></DialogHeader>
                    <div className="space-y-4 py-4">
                      <div>
                        <Label>Conexão WhatsApp (opcional)</Label>
                        <select name="connectionId" className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
                          <option value="">— Somente interna —</option>
                          {whatsapps.map((c: any) => (
                            <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="phone">Telefone (com DDI, só dígitos)</Label>
                        <Input id="phone" name="phone" placeholder="5511999999999" maxLength={20} />
                      </div>
                      <div>
                        <Label htmlFor="title">Ou título livre</Label>
                        <Input id="title" name="title" placeholder="Ex.: Anotações" maxLength={200} />
                      </div>
                    </div>
                    <DialogFooter><Button type="submit" disabled={create.isPending}>Criar</Button></DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          <ScrollArea className="flex-1">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma conversa.</div>
            ) : filtered.map((c) => (
              <div key={c.id}
                onClick={() => setSelected(c.id)}
                className={`group flex w-full cursor-pointer items-center gap-2 border-b p-3 text-left hover:bg-accent ${selected === c.id ? "bg-accent" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-sm">{c.title ?? "Sem título"}</span>
                    {c.connection_id && <Link2 className="h-3 w-3 shrink-0 text-primary" />}
                  </div>
                  <span className="text-xs text-muted-foreground">{new Date(c.last_message_at).toLocaleString("pt-BR")}</span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); if (confirm("Excluir conversa?")) del.mutate({ data: { id: c.id } }); }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </ScrollArea>
        </Card>

        <Card className="flex flex-col overflow-hidden">
          {selected ? (
            <ConvPane id={selected} connection={connections.find((c: any) => c.id === conversations.find((cv) => cv.id === selected)?.connection_id)} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">Selecione ou crie uma conversa</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function ConvPane({ id, connection }: { id: string; connection?: any }) {
  const qc = useQueryClient();
  const { data: msgs = [] } = useQuery({ queryKey: ["messages", id], queryFn: () => listMessages({ data: { conversationId: id } }) });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs.length]);

  const send = useMutation({
    mutationFn: useServerFn(sendMessage),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messages", id] }),
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      {connection && (
        <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs">
          <Link2 className="h-3 w-3" />
          <span>Vinculada a <strong>{connection.name}</strong></span>
          <Badge variant={connection.status === "online" ? "default" : "outline"}>{connection.status}</Badge>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {msgs.length === 0 ? (
          <div className="mt-20 text-center text-sm text-muted-foreground">Nenhuma mensagem ainda.</div>
        ) : msgs.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${m.direction === "outbound" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {m.body}
              <div className="mt-1 text-[10px] opacity-70">
                {new Date(m.created_at).toLocaleTimeString("pt-BR")}
                {m.status && ` · ${m.status}`}
              </div>
            </div>
          </div>
        ))}
      </div>
      <form className="border-t p-3 flex gap-2" onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const body = String(fd.get("body") || "").trim();
        if (!body) return;
        send.mutate({ data: { conversationId: id, body } });
        e.currentTarget.reset();
      }}>
        <Input name="body" placeholder="Digite uma mensagem..." maxLength={4000} autoComplete="off" />
        <Button type="submit" size="icon" disabled={send.isPending}><Send className="h-4 w-4" /></Button>
      </form>
    </>
  );
}
