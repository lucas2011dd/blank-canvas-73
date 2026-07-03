import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Copy, KeyRound, User, Palette, Link2, Shield } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { createApiKey, getMyProfile, listApiKeys, revokeApiKey, updateMyProfile } from "@/lib/settings.functions";
import { disconnectGoogle, exportContactsToGoogle, googleConnectionStatus, importGoogleContacts } from "@/lib/google.functions";
import { useTheme } from "@/components/theme-provider";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

const profileQ = queryOptions({ queryKey: ["profile"], queryFn: () => getMyProfile() });
const keysQ = queryOptions({ queryKey: ["api-keys"], queryFn: () => listApiKeys() });

export const Route = createFileRoute("/_authenticated/configuracoes")({
  head: () => ({ meta: [{ title: "Configurações — ConnectHub" }] }),
  loader: async ({ context }) => { await Promise.all([context.queryClient.ensureQueryData(profileQ), context.queryClient.ensureQueryData(keysQ)]); },
  component: SettingsPage,
  errorComponent: ({ error }) => <div className="text-destructive">Erro: {error.message}</div>,
  notFoundComponent: () => <div>Não encontrado</div>,
});

function SettingsPage() {
  return (
    <div className="space-y-6">
      <div><h1 className="text-3xl font-bold tracking-tight">Configurações</h1></div>
      <Tabs defaultValue="perfil" className="w-full">
        <TabsList>
          <TabsTrigger value="perfil"><User className="mr-2 h-4 w-4" /> Perfil</TabsTrigger>
          <TabsTrigger value="tema"><Palette className="mr-2 h-4 w-4" /> Aparência</TabsTrigger>
          <TabsTrigger value="integracoes"><Link2 className="mr-2 h-4 w-4" /> Integrações</TabsTrigger>
          <TabsTrigger value="apikeys"><KeyRound className="mr-2 h-4 w-4" /> API Keys</TabsTrigger>
          <TabsTrigger value="seguranca"><Shield className="mr-2 h-4 w-4" /> Segurança</TabsTrigger>
        </TabsList>
        <TabsContent value="perfil"><ProfileTab /></TabsContent>
        <TabsContent value="tema"><ThemeTab /></TabsContent>
        <TabsContent value="integracoes"><IntegrationsTab /></TabsContent>
        <TabsContent value="apikeys"><ApiKeysTab /></TabsContent>
        <TabsContent value="seguranca"><SecurityTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function ProfileTab() {
  const { data } = useSuspenseQuery(profileQ);
  const qc = useQueryClient();
  const up = useMutation({
    mutationFn: useServerFn(updateMyProfile),
    onSuccess: () => { toast.success("Perfil atualizado"); qc.invalidateQueries({ queryKey: ["profile"] }); },
  });
  return (
    <Card>
      <CardHeader><CardTitle>Meu perfil</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          up.mutate({ data: {
            full_name: String(fd.get("full_name")),
            timezone: String(fd.get("timezone")),
            locale: fd.get("locale") as "pt-BR",
          } });
        }}>
          <div><Label>Email</Label><Input value={data.email} disabled /></div>
          <div><Label>Nome completo</Label><Input name="full_name" defaultValue={data.full_name ?? ""} /></div>
          <div><Label>Timezone</Label><Input name="timezone" defaultValue={data.timezone ?? "America/Sao_Paulo"} /></div>
          <div><Label>Idioma</Label>
            <select name="locale" defaultValue={data.locale ?? "pt-BR"} className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
              <option value="pt-BR">Português (BR)</option>
              <option value="en-US">English (US)</option>
              <option value="es">Español</option>
            </select>
          </div>
          <div className="sm:col-span-2"><Button type="submit" disabled={up.isPending}>Salvar</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function ThemeTab() {
  const { theme, setTheme } = useTheme();
  return (
    <Card>
      <CardHeader><CardTitle>Aparência</CardTitle><CardDescription>Escolha um tema para a interface.</CardDescription></CardHeader>
      <CardContent className="flex gap-2">
        {(["light", "dark", "system"] as const).map((t) => (
          <Button key={t} variant={theme === t ? "default" : "outline"} onClick={() => setTheme(t)}>
            {t === "light" ? "Claro" : t === "dark" ? "Escuro" : "Sistema"}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

function IntegrationsTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: status, refetch } = useSuspenseQuery(queryOptions({
    queryKey: ["google-status"],
    queryFn: () => googleConnectionStatus(),
  }));
  const imp = useMutation({
    mutationFn: useServerFn(importGoogleContacts),
    onSuccess: (r: any) => { toast.success(`${r.imported} contato(s) importado(s) do Google`); qc.invalidateQueries({ queryKey: ["contacts"] }); },
    onError: (e) => toast.error(e.message),
  });
  const exp = useMutation({
    mutationFn: useServerFn(exportContactsToGoogle),
    onSuccess: (r: any) => toast.success(`${r.exported} contato(s) enviados para o Google. Abra o Gmail no celular para sincronizar.`),
    onError: (e) => toast.error(e.message),
  });
  const disc = useMutation({
    mutationFn: useServerFn(disconnectGoogle),
    onSuccess: () => { toast.success("Google desconectado"); refetch(); },
  });

  useEffect(() => {
    if (window.location.hash.includes("google=connected")) {
      toast.success("Google conectado!");
      history.replaceState(null, "", window.location.pathname);
      refetch();
    }
  }, [refetch]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Google Contacts
            {status.connected && <Badge variant="default">Conectado</Badge>}
          </CardTitle>
          <CardDescription>
            Vincule seu Gmail para exportar todos os contatos do sistema para o Google Contatos.
            Quando o mesmo Gmail estiver logado no seu celular, os contatos aparecem automaticamente na agenda.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!status.connected ? (
            <>
              <Button onClick={() => { window.location.href = `/api/google/authorize?uid=${user?.id ?? ""}`; }}>
                Vincular conta Google
              </Button>
              <p className="text-xs text-muted-foreground">
                Requer <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> configurados nos Secrets, com People API ativada e redirect <code>{typeof window !== "undefined" ? window.location.origin : ""}/api/google/callback</code>.
              </p>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => exp.mutate({ data: {} })} disabled={exp.isPending}>
                {exp.isPending ? "Enviando..." : "Enviar todos os contatos para o Google"}
              </Button>
              <Button variant="outline" onClick={() => imp.mutate(undefined as any)} disabled={imp.isPending}>
                {imp.isPending ? "Importando..." : "Importar do Google"}
              </Button>
              <Button variant="ghost" onClick={() => disc.mutate(undefined as any)}>Desconectar</Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>WhatsApp Business API</CardTitle>
          <CardDescription>Suporta Evolution API, Meta Cloud e Twilio.</CardDescription></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Configure <code>WHATSAPP_PROVIDER</code>, <code>WHATSAPP_API_URL</code> e <code>WHATSAPP_API_KEY</code>. As conexões são gerenciadas em <b>Menu Conexões</b>.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function ApiKeysTab() {
  const { data: keys } = useSuspenseQuery(keysQ);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: useServerFn(createApiKey),
    onSuccess: (r: any) => { setRevealed(r.raw); setName(""); qc.invalidateQueries({ queryKey: ["api-keys"] }); },
  });
  const revoke = useMutation({
    mutationFn: useServerFn(revokeApiKey),
    onSuccess: () => { toast.success("Revogada"); qc.invalidateQueries({ queryKey: ["api-keys"] }); },
  });

  return (
    <Card>
      <CardHeader><CardTitle>API Keys</CardTitle>
        <CardDescription>Use em integrações externas. A chave só é exibida uma vez.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input placeholder="Nome (ex: Zapier)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button onClick={() => name && create.mutate({ data: { name } })} disabled={create.isPending || !name}>Criar</Button>
        </div>
        {revealed && (
          <div className="rounded-lg border border-warning bg-warning/10 p-3 text-sm">
            <p className="mb-2 font-medium">Copie agora — não será exibida novamente:</p>
            <div className="flex gap-2">
              <code className="flex-1 rounded bg-muted p-2 text-xs break-all">{revealed}</code>
              <Button size="icon" variant="outline" onClick={() => { navigator.clipboard.writeText(revealed); toast.success("Copiada"); }}><Copy className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
        <div className="divide-y">
          {keys.length === 0 ? <p className="py-4 text-sm text-muted-foreground">Nenhuma chave criada.</p> : keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between py-3">
              <div>
                <div className="font-medium">{k.name}</div>
                <div className="text-xs text-muted-foreground">Criada em {new Date(k.created_at).toLocaleDateString("pt-BR")}
                  {k.last_used_at && ` · última uso ${new Date(k.last_used_at).toLocaleDateString("pt-BR")}`}</div>
              </div>
              {k.revoked_at ? <Badge variant="outline">Revogada</Badge>
                : <Button variant="ghost" size="sm" onClick={() => revoke.mutate({ data: { id: k.id } })}>Revogar</Button>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SecurityTab() {
  async function signOutAll() {
    await supabase.auth.signOut({ scope: "global" });
    toast.success("Todas as sessões foram encerradas");
    window.location.href = "/auth";
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Sessões</CardTitle><CardDescription>Encerre sessões em outros dispositivos.</CardDescription></CardHeader>
        <CardContent><Button variant="destructive" onClick={signOutAll}>Encerrar todas as sessões</Button></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Autenticação em 2 fatores (MFA)</CardTitle>
          <CardDescription>Habilite via TOTP no seu app autenticador.</CardDescription></CardHeader>
        <CardContent>
          <Button variant="outline" onClick={async () => {
            const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
            if (error) toast.error(error.message);
            else toast.info("Escaneie o QR: " + (data?.totp?.uri ?? "n/a"));
          }}>Configurar MFA</Button>
        </CardContent>
      </Card>
    </div>
  );
}
