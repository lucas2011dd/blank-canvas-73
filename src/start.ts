import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "./integrations/supabase/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) throw error;
    if (error instanceof Response) throw error;
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

/**
 * Security headers em TODA resposta (defense-in-depth).
 * - X-Frame-Options DENY: bloqueia clickjacking via iframe embed.
 * - X-Content-Type-Options nosniff: impede MIME sniffing (XSS via upload).
 * - Referrer-Policy strict-origin-when-cross-origin: não vaza path para terceiros.
 * - Permissions-Policy: desliga APIs sensíveis não usadas pelo app.
 * - HSTS: força HTTPS por 1 ano incluindo subdomínios (só faz efeito quando servido via https).
 * CSP não é aplicado aqui: Tailwind/shadcn usam estilos inline; adotar CSP exige nonce
 * no HeadContent e whitelist de fonts.googleapis.com/gstatic.com — deve ser feito à parte.
 */
const securityHeadersMiddleware = createMiddleware().server(async ({ next }) => {
  const res = await next();
  const response = res instanceof Response ? res : new Response(String(res ?? ""));
  const h = response.headers;
  if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "DENY");
  if (!h.has("X-Content-Type-Options")) h.set("X-Content-Type-Options", "nosniff");
  if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!h.has("Permissions-Policy")) {
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  }
  if (!h.has("Strict-Transport-Security")) {
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return response;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeadersMiddleware, errorMiddleware],
  functionMiddleware: [attachSupabaseAuth],
}));
