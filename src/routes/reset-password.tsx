import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Redefinir senha — ConnectHub" }, { name: "robots", content: "noindex" }] }),
  component: ResetPage,
});

function ResetPage() {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Supabase parseia o token de recovery do hash automaticamente (detectSessionInUrl)
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => { if (data.session) setReady(true); });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      const fd = new FormData(e.currentTarget);
      const password = String(fd.get("password"));
      if (password.length < 8) { toast.error("Senha muito curta"); return; }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Senha atualizada!");
      navigate({ to: "/dashboard", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao redefinir");
    } finally { setLoading(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Nova senha</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {ready ? "Escolha uma senha forte (mín. 8 caracteres)." : "Aguardando link de recuperação..."}
        </p>
        {ready && (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div><Label htmlFor="password">Nova senha</Label><Input id="password" name="password" type="password" autoComplete="new-password" required /></div>
            <Button type="submit" className="w-full" disabled={loading}>{loading ? "Salvando..." : "Redefinir senha"}</Button>
          </form>
        )}
      </div>
    </div>
  );
}
