import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Plus, Send, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { createConversation, listConversations, listMessages, sendMessage } from "@/lib/chat.functions";
import { toast } from "sonner";

const convQ = queryOptions({ queryKey: ["conversations"], queryFn: () => listConversations() });

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({ meta: [{ title: "Chat — ConnectHub" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(convQ),
  component: ChatPage,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function ChatPage() {
  const { data: conversations } = useSuspenseQuery(convQ);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(conversations[0]?.id ?? null);
  const [search, setSearch] = useState("");

  const create = useMutation({
    mutationFn: useServerFn(createConversation),
    onSuccess: (row: any) => { qc.invalidateQueries({ queryKey: ["conversations"] }); setSelected(row.id); },
  });

  // Realtime subscription
  useEffect(() => {
    const channel = supabase.channel("messages-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const m = payload.new as { conversation_id: string };
        qc.invalidateQueries({ queryKey: ["messages", m.conversation_id] });
        qc.invalidateQueries({ queryKey: ["conversations"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);

  const filtered = conversations.filter((c) => !search || (c.title ?? "").toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="h-[calc(100vh-8rem)]">
      <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <Card className="flex flex-col overflow-hidden">
          <div className="border-b p-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-8" placeholder="Buscar..." value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Button size="icon" onClick={() => {
                const title = prompt("Título da conversa:");
                if (title) create.mutate({ data: { title } });
              }}><Plus className="h-4 w-4" /></Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma conversa.</div>
            ) : filtered.map((c) => (
              <button key={c.id} onClick={() => setSelected(c.id)}
                className={`flex w-full flex-col items-start gap-1 border-b p-3 text-left hover:bg-accent ${selected === c.id ? "bg-accent" : ""}`}>
                <span className="font-medium text-sm">{c.title ?? "Sem título"}</span>
                <span className="text-xs text-muted-foreground">{new Date(c.last_message_at).toLocaleString("pt-BR")}</span>
              </button>
            ))}
          </ScrollArea>
        </Card>

        <Card className="flex flex-col overflow-hidden">
          {selected ? <ConvPane id={selected} /> : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">Selecione ou crie uma conversa</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function ConvPane({ id }: { id: string }) {
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {msgs.length === 0 ? (
          <div className="mt-20 text-center text-sm text-muted-foreground">Nenhuma mensagem ainda.</div>
        ) : msgs.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${m.direction === "outbound" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {m.body}
              <div className="mt-1 text-[10px] opacity-70">{new Date(m.created_at).toLocaleTimeString("pt-BR")}</div>
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
        <Button type="submit" size="icon"><Send className="h-4 w-4" /></Button>
      </form>
    </>
  );
}
