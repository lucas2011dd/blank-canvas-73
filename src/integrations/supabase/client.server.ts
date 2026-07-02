import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// SERVER-ONLY. Nunca importar deste arquivo em componentes/rotas do browser.
// A extensão .server.ts é bloqueada pelo bundler no client bundle.
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no ambiente do servidor. Configure seu .env",
  );
}

export const supabaseAdmin = createClient<Database>(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
});

export function supabaseServerAnon() {
  return createClient<Database>(url!, process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}
