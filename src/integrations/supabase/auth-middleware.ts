import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Server-fn middleware: valida o bearer token do Supabase e injeta:
 *   context.supabase (client com RLS como o usuário)
 *   context.userId
 *   context.user
 */
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const auth = getRequestHeader("authorization") ?? getRequestHeader("Authorization");
  if (!auth?.startsWith("Bearer ")) throw new Response("Unauthorized", { status: 401 });
  const token = auth.slice(7);

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) throw new Response("Server misconfigured", { status: 500 });

  const supabase = createClient<Database>(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Response("Unauthorized", { status: 401 });

  return next({ context: { supabase, userId: data.user.id, user: data.user } });
});
