import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { FileUp, Users, RefreshCw, FileDown } from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { importContacts, listContacts } from "@/lib/contacts.functions";

export const Route = createFileRoute("/_authenticated/ferramentas")({
  head: () => ({ meta: [{ title: "Ferramentas — ConnectHub" }] }),
  component: Page,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

type ImportRow = { name: string; phone?: string; email?: string; company?: string; city?: string };

function Page() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const importer = useMutation({
    mutationFn: useServerFn(importContacts),
    onSuccess: (r: any) => { toast.success(`${r.count} contato(s) importado(s)`); qc.invalidateQueries({ queryKey: ["contacts"] }); },
    onError: (e) => toast.error(e.message),
  });

  async function handleFile(f: File) {
    setBusy(true);
    try {
      const ext = f.name.split(".").pop()?.toLowerCase();
      let items: ImportRow[] = [];
      if (ext === "csv") {
        const text = await f.text();
        const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
        items = parsed.data.map((r) => ({ name: r.name || r.Nome || "", phone: r.phone || r.Telefone, email: r.email || r.Email, company: r.company || r.Empresa, city: r.city || r.Cidade })).filter((i) => i.name);
      } else if (ext === "xlsx" || ext === "xls") {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf); const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);
        items = rows.map((r) => ({ name: r.name || r.Nome || "", phone: r.phone || r.Telefone, email: r.email || r.Email, company: r.company || r.Empresa, city: r.city || r.Cidade })).filter((i) => i.name);
      } else if (ext === "vcf") {
        const text = await f.text();
        items = parseVCF(text);
      } else { toast.error("Formato não suportado (use CSV, XLSX ou VCF)"); return; }
      if (items.length === 0) { toast.error("Nenhum contato válido encontrado"); return; }
      importer.mutate({ data: { items, source: ext === "vcf" ? "vcf" : ext === "csv" ? "csv" : "xlsx" } });
    } finally { setBusy(false); }
  }

  async function exportAll(format: "csv" | "xlsx" | "vcf") {
    const contacts = await listContacts({ data: {} });
    if (format === "csv") {
      const header = "name,phone,email,company,city\n";
      const rows = contacts.map((c) => [c.name, c.phone, c.email, c.company, c.city].map((v) => `"${(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      download(header + rows, `contatos-${Date.now()}.csv`, "text/csv");
    } else if (format === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(contacts.map((c) => ({ Nome: c.name, Telefone: c.phone, Email: c.email, Empresa: c.company, Cidade: c.city })));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Contatos");
      XLSX.writeFile(wb, `contatos-${Date.now()}.xlsx`);
    } else {
      const vcf = contacts.map((c) => `BEGIN:VCARD\nVERSION:3.0\nFN:${c.name}\n${c.phone ? `TEL:${c.phone}\n` : ""}${c.email ? `EMAIL:${c.email}\n` : ""}${c.company ? `ORG:${c.company}\n` : ""}END:VCARD`).join("\n");
      download(vcf, `contatos-${Date.now()}.vcf`, "text/vcard");
    }
    toast.success("Exportado!");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Ferramentas</h1>
        <p className="text-muted-foreground">Importar, exportar e sincronizar contatos.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileUp className="h-4 w-4" /> Importar contatos</CardTitle>
            <CardDescription>CSV, XLSX ou VCF · até 5000 registros.</CardDescription></CardHeader>
          <CardContent>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.vcf" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
            <Button onClick={() => fileRef.current?.click()} disabled={busy || importer.isPending}>{busy || importer.isPending ? "Processando..." : "Selecionar arquivo"}</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileDown className="h-4 w-4" /> Exportar contatos</CardTitle>
            <CardDescription>Baixe seus contatos.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => exportAll("csv")}>CSV</Button>
            <Button variant="outline" size="sm" onClick={() => exportAll("xlsx")}>XLSX</Button>
            <Button variant="outline" size="sm" onClick={() => exportAll("vcf")}>VCF</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> Google Contacts</CardTitle>
            <CardDescription>OAuth 2.0 oficial. Configure em <b>Configurações → Integrações</b>.</CardDescription></CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" disabled><RefreshCw className="mr-2 h-4 w-4" /> Sincronizar agora</Button>
            <p className="mt-2 text-xs text-muted-foreground">Requer conta Google vinculada.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function download(text: string, name: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function parseVCF(text: string): ImportRow[] {
  const cards = text.split(/END:VCARD/i);
  return cards.map((card) => {
    const name = /FN:(.+)/i.exec(card)?.[1]?.trim();
    if (!name) return null;
    return {
      name,
      phone: /TEL[^:]*:(.+)/i.exec(card)?.[1]?.trim(),
      email: /EMAIL[^:]*:(.+)/i.exec(card)?.[1]?.trim(),
      company: /ORG:(.+)/i.exec(card)?.[1]?.trim(),
    };
  }).filter((c): c is ImportRow => !!c);
}
