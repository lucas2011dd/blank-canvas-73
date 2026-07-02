import { createClient } from "@supabase/supabase-js";

// SERVER-ONLY. A extensão .server.ts é bloqueada no bundle do browser.
const url = process.env.EXT_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.EXT_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.EXT_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    "EXT_SUPABASE_URL e EXT_SUPABASE_SERVICE_ROLE_KEY são obrigatórios no ambiente do servidor.",
  );
}

export const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
});

export function supabaseServerAnon() {
  return createClient(url!, anonKey ?? "", {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}
