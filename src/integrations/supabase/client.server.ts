import { createClient } from "@supabase/supabase-js";

// SERVER-ONLY. A extensão .server.ts é bloqueada no bundle do browser.
function serverEnv() {
  const url = process.env.EXT_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.EXT_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.EXT_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "EXT_SUPABASE_URL e EXT_SUPABASE_SERVICE_ROLE_KEY são obrigatórios no ambiente do servidor.",
    );
  }

  return { url, serviceKey, anonKey };
}

let adminClient: any = null;

function getSupabaseAdmin() {
  if (!adminClient) {
    const { url, serviceKey } = serverEnv();
    adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    });
  }
  return adminClient;
}

export const supabaseAdmin: any = new Proxy({}, {
  get(_target, prop, receiver) {
    return Reflect.get(getSupabaseAdmin(), prop, receiver);
  },
});

export function supabaseServerAnon() {
  const { url, anonKey } = serverEnv();
  if (!anonKey) throw new Error("SUPABASE_PUBLISHABLE_KEY/ANON_KEY ausente no ambiente do servidor.");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}
