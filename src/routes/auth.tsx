import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const authSchema = z.object({
  email: z.string().trim().email("Email inválido").max(255),
  password: z.string().min(8, "Senha precisa de ao menos 8 caracteres").max(72),
});
const signupSchema = authSchema.extend({
  full_name: z.string().trim().min(2, "Nome muito curto").max(120),
});

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>) => ({ mode: (s.mode as "login" | "signup") ?? "login", redirect: (s.redirect as string) ?? "/dashboard" }),
  head: () => ({ meta: [{ title: "Entrar — ConnectHub" }, { name: "robots", content: "noindex" }] }),
  component: AuthPage,
});

function AuthPage() {
  const { mode, redirect } = Route.useSearch();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: redirect as "/dashboard", replace: true });
    });
  }, [navigate, redirect]);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      const fd = new FormData(e.currentTarget);
      const parsed = authSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
      if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
      const { error } = await supabase.auth.signInWithPassword(parsed.data);
      if (error) throw error;
      toast.success("Bem-vindo!");
      navigate({ to: redirect as "/dashboard", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no login");
    } finally { setLoading(false); }
  }

  async function handleSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      const fd = new FormData(e.currentTarget);
      const parsed = signupSchema.safeParse({
        email: fd.get("email"), password: fd.get("password"), full_name: fd.get("full_name"),
      });
      if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
      const { error } = await supabase.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: {
          data: { full_name: parsed.data.full_name },
          emailRedirectTo: `${window.location.origin}/dashboard`,
        },
      });
      if (error) throw error;
      toast.success("Conta criada! Confira seu email para confirmar.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha no cadastro");
    } finally { setLoading(false); }
  }

  async function handleReset() {
    const email = prompt("Digite seu email:");
    if (!email) return;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) toast.error(error.message);
    else toast.success("Email de recuperação enviado.");
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between bg-gradient-hero p-12 text-primary-foreground">
        <Link to="/" className="flex items-center gap-2">
          <Sparkles className="h-6 w-6" />
          <span className="font-semibold text-lg">ConnectHub</span>
        </Link>
        <div>
          <h2 className="text-4xl font-bold">Sua central de conexões e conversas.</h2>
          <p className="mt-4 opacity-90">Conexões WhatsApp, chat em tempo real, Google Contacts e auditoria — tudo no seu servidor.</p>
        </div>
        <p className="text-sm opacity-70">Auto-hospedável · Open source · Segurança RLS</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <Sparkles className="h-5 w-5 text-primary" />
            <span className="font-semibold">ConnectHub</span>
          </div>
          <Tabs defaultValue={mode} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Entrar</TabsTrigger>
              <TabsTrigger value="signup">Criar conta</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-4 pt-4">
                <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="email" required /></div>
                <div><Label htmlFor="password">Senha</Label><Input id="password" name="password" type="password" autoComplete="current-password" required /></div>
                <Button type="submit" className="w-full" disabled={loading}>{loading ? "Entrando..." : "Entrar"}</Button>
                <button type="button" onClick={handleReset} className="w-full text-xs text-muted-foreground hover:text-foreground">Esqueci minha senha</button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignup} className="space-y-4 pt-4">
                <div><Label htmlFor="full_name">Nome completo</Label><Input id="full_name" name="full_name" required /></div>
                <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="email" required /></div>
                <div><Label htmlFor="password">Senha (mín. 8)</Label><Input id="password" name="password" type="password" autoComplete="new-password" required /></div>
                <Button type="submit" className="w-full" disabled={loading}>{loading ? "Criando..." : "Criar conta"}</Button>
              </form>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
