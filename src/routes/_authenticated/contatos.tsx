import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Plus, Search, Trash2, Download, MessageCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { createContact, deleteContact, listContacts } from "@/lib/contacts.functions";
import { listConnections } from "@/lib/connections.functions";
import { exportContactsToGoogle } from "@/lib/google.functions";

// staleTime alto: contatos raramente mudam fora das mutações desta tela,
// que já disparam invalidateQueries. Evita refetch da lista inteira ao
// navegar entre abas.
const q = queryOptions({ queryKey: ["contacts"], queryFn: () => listContacts({ data: {} }), staleTime: 60_000 });
const connQ = queryOptions({ queryKey: ["connections"], queryFn: () => listConnections() });

export const Route = createFileRoute("/_authenticated/contatos")({
  head: () => ({ meta: [{ title: "Contatos — ConnectHub" }] }),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(q),
    context.queryClient.ensureQueryData(connQ),
  ]),
  component: Page,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function Page() {
  const { data } = useSuspenseQuery(q);
  const { data: connections } = useSuspenseQuery(connQ);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const whatsapps = connections.filter((c: any) => c.provider === "whatsapp");

  // Realtime removido: mutações locais já invalidam a lista e o canal
  // adicionava overhead constante para uma tabela que muda pouco.


  function openWhatsapp(phone: string) {
    const clean = phone.replace(/\D/g, "");
    if (!clean) return toast.error("Contato sem telefone");
    const online = whatsapps.find((c: any) => c.status === "online") ?? whatsapps[0];
    if (!online) return toast.error("Nenhuma conexão WhatsApp configurada");
    navigate({ to: "/chat", search: { phone: clean, connectionId: online.id } });
  }

  const create = useMutation({
    mutationFn: useServerFn(createContact),
    onSuccess: () => { toast.success("Contato criado"); setOpen(false); qc.invalidateQueries({ queryKey: ["contacts"] }); },
    onError: (e) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: useServerFn(deleteContact),
    onSuccess: () => { toast.success("Removido"); qc.invalidateQueries({ queryKey: ["contacts"] }); },
  });
  const gExport = useMutation({
    mutationFn: useServerFn(exportContactsToGoogle),
    onSuccess: (r: any) => toast.success(`${r.exported} contato(s) enviados ao Google. Abra o Gmail no celular para sincronizar.`),
    onError: (e) => toast.error(e.message.includes("Google") ? e.message : "Vincule sua conta Google em Configurações → Integrações"),
  });

  const filtered = data.filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return c.name.toLowerCase().includes(s) || (c.phone ?? "").includes(s) || (c.email ?? "").toLowerCase().includes(s) || (c.company ?? "").toLowerCase().includes(s);
  });

  function exportCSV() {
    const header = "name,phone,email,company,city\n";
    const rows = filtered.map((c) => [c.name, c.phone, c.email, c.company, c.city].map((v) => `"${(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `contatos-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Contatos</h1>
          <p className="text-muted-foreground">{data.length} contato(s) sincronizado(s).</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportCSV}><Download className="mr-2 h-4 w-4" /> Exportar CSV</Button>
          <Button variant="outline" onClick={() => gExport.mutate({ data: {} })} disabled={gExport.isPending}>
            <Upload className="mr-2 h-4 w-4" /> {gExport.isPending ? "Enviando..." : "Enviar todos para Google"}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button><Plus className="mr-2 h-4 w-4" /> Novo contato</Button></DialogTrigger>
            <DialogContent>
              <form onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                create.mutate({ data: {
                  name: String(fd.get("name")), phone: String(fd.get("phone") || ""),
                  email: String(fd.get("email") || ""), company: String(fd.get("company") || ""),
                  city: String(fd.get("city") || ""),
                } });
              }}>
                <DialogHeader><DialogTitle>Novo contato</DialogTitle></DialogHeader>
                <div className="grid gap-4 py-4 sm:grid-cols-2">
                  <div className="sm:col-span-2"><Label>Nome</Label><Input name="name" required /></div>
                  <div><Label>Telefone</Label><Input name="phone" /></div>
                  <div><Label>Email</Label><Input name="email" type="email" /></div>
                  <div><Label>Empresa</Label><Input name="company" /></div>
                  <div><Label>Cidade</Label><Input name="city" /></div>
                </div>
                <DialogFooter><Button type="submit" disabled={create.isPending}>Salvar</Button></DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Buscar por nome, telefone, email..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Nenhum contato.</TableCell></TableRow>
              ) : filtered.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">{c.phone || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.email || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.company || "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {c.phone && (
                        <Button size="icon" variant="ghost" title="Enviar WhatsApp" onClick={() => openWhatsapp(c.phone!)}>
                          <MessageCircle className="h-4 w-4 text-primary" />
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" onClick={() => del.mutate({ data: { id: c.id } })}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
