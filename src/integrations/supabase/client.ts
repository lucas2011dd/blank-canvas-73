import { createClient } from "@supabase/supabase-js";

// Chaves públicas (anon) — seguras no browser porque a proteção real é RLS.
const url = "https://faivazixuzbtgixqnnuk.supabase.co";
const anonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhaXZheml4dXpidGdpeHFubnVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMDk0NDAsImV4cCI6MjA5ODU4NTQ0MH0.NVHh28my_Cpqu4KdsEYB5BLu5QAY8hLlOH2GGPY_Afw";

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    storageKey: "connecthub-auth",
  },
});
