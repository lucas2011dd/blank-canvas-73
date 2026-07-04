import { createClient } from "@supabase/supabase-js";

// Chaves públicas (anon) — seguras no browser porque a proteção real é RLS.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY são obrigatórios no cliente.");
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    storageKey: "connecthub-auth",
  },
});
