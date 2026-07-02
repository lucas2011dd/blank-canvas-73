import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

/** Client fn middleware: anexa o bearer token do Supabase em toda chamada server-fn. */
export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
});
