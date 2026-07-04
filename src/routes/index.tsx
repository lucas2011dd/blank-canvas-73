import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Cable, MessageSquare, Users, Shield, Zap, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ConnectHub — Gerencie conexões, contatos e conversas em um só lugar" },
      { name: "description", content: "SaaS completo para times: conexões WhatsApp, sync com Google Contacts, chat em tempo real, auditoria e mais. Auto-hospedável." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b sticky top-0 z-40 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-hero">
              <Sparkles className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold">ConnectHub</span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="ghost"><Link to="/auth">Entrar</Link></Button>
            <Button asChild><Link to="/auth" search={{ mode: "signup" }}>Começar grátis</Link></Button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 pt-20 pb-16 text-center">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border bg-card px-4 py-1.5 text-xs text-muted-foreground">
          <Zap className="h-3 w-3" /> Novo · Sync com Google Contacts + WhatsApp Business
        </div>
        <h1 className="mt-6 text-5xl font-bold tracking-tight md:text-6xl">
          Sua central de <span className="text-gradient">conexões e conversas</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Gerencie múltiplas conexões WhatsApp, sincronize contatos com o Google, converse em tempo real e mantenha
          tudo auditado. Rode 100% no seu servidor.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Button asChild size="lg"><Link to="/auth" search={{ mode: "signup" }}>Criar conta <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
          <Button asChild size="lg" variant="outline"><a href="#recursos">Ver recursos</a></Button>
        </div>
      </section>

      <section id="recursos" className="mx-auto max-w-7xl px-4 py-16">
        <div className="grid gap-6 md:grid-cols-3">
          {[
            { icon: Cable, title: "Múltiplas conexões", desc: "Gerencie diversas contas WhatsApp com QR Code, reconexão automática e logs detalhados." },
            { icon: MessageSquare, title: "Chat em tempo real", desc: "Powered by Supabase Realtime. Mensagens, notificações e anexos com latência mínima." },
            { icon: Users, title: "Google Contacts", desc: "OAuth 2.0 oficial. Sync bidirecional, resolução de conflitos e histórico completo." },
            { icon: Shield, title: "Segurança total", desc: "RLS em todas as tabelas, JWT + Refresh, MFA opcional, auditoria imutável." },
            { icon: Zap, title: "Auto-hospedável", desc: "Rode via Node atrás do seu Apache/XAMPP/Nginx. Sem lock-in, sem custos escondidos." },
            { icon: Sparkles, title: "UX moderna", desc: "Tema claro/escuro, 100% responsivo, skeleton loading, toasts e feedback visual." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border bg-card p-6">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-accent">
                <f.icon className="h-5 w-5 text-accent-foreground" />
              </div>
              <h3 className="text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} ConnectHub · Auto-hospedável e open source
      </footer>
    </div>
  );
}
