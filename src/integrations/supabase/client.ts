import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.warn("[supabase] VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY não definidos — copie .env.example para .env");
}

export const supabase = createClient<Database>(url ?? "https://placeholder.supabase.co", anonKey ?? "placeholder", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    storageKey: "connecthub-auth",
  },
});
