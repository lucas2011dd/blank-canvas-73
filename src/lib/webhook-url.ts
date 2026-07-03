function normalizeBaseUrl(value: string | undefined | null): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    return url.origin.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function previewBaseFromConfiguredProjectHost(base: string | undefined): string | undefined {
  if (!base) return undefined;
  const match = base.match(/^https?:\/\/project--([a-f0-9-]+)\.lovable\.app$/i);
  return match ? `https://id-preview--${match[1]}.lovable.app` : undefined;
}

function isProjectLovableHost(base: string | undefined): boolean {
  return /^https?:\/\/project--[a-f0-9-]+\.lovable\.app$/i.test(base ?? "");
}

export function webhookPublicBaseUrl(): string | undefined {
  const configured = normalizeBaseUrl(
    process.env.WHATSAPP_WEBHOOK_PUBLIC_URL ??
    process.env.APP_PUBLIC_URL ??
    process.env.PUBLIC_BASE_URL,
  );

  const previewBase = normalizeBaseUrl(
    process.env.LOVABLE_PREVIEW_URL ??
    process.env.LOVABLE_PREVIEW_HOST,
  );

  // Enquanto o projeto não está publicado, project--*.lovable.app responde 404.
  // O preview público equivalente usa id-preview--<project-id>.lovable.app.
  if (isProjectLovableHost(configured)) {
    return previewBase ?? previewBaseFromConfiguredProjectHost(configured) ?? configured;
  }

  return configured ?? previewBase;
}

export function buildWebhookUrl(instanceName: string): string | undefined {
  const base = webhookPublicBaseUrl();
  if (!base) return undefined;
  return `${base}/api/public/wa/webhook/${encodeURIComponent(instanceName)}`;
}