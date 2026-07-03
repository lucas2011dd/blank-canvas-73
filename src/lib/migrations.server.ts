// Server-only worker para processar 1 batch de uma migração de grupo.
// É importado dinamicamente por server functions e pelo cron público
// (/api/public/wa/tick). NUNCA importe no cliente.
import { evolution } from "@/lib/evolution.server";

function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

function jitter(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export async function processGroupMigrationBatch(supabase: any, migrationId: string, userIdScope?: string) {
  let q = supabase.from("group_migrations").select("*").eq("id", migrationId);
  if (userIdScope) q = q.eq("user_id", userIdScope);
  const { data: mig } = await q.maybeSingle();
  if (!mig) throw new Error("Migração não encontrada");
  if (mig.status !== "running" && mig.status !== "pending") {
    return { migrationId, skipped: true, reason: `status=${mig.status}` };
  }
  if (!mig.target_group_jid) throw new Error("Grupo destino ausente");

  // Escopa o lookup de conexão pelo user_id da migração, mesmo usando o
  // admin client — evita que uma migração forjada aponte para a conexão de
  // outro usuário.
  const { data: conn } = await supabase
    .from("connections")
    .select("status,metadata,user_id")
    .eq("id", mig.connection_id)
    .eq("user_id", mig.user_id)
    .maybeSingle();
  if (!conn) throw new Error("Conexão não encontrada");
  if (conn.status !== "online") {
    await supabase.from("group_migrations").update({
      next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      last_error: "Conexão offline — reagendado em 5min",
    }).eq("id", mig.id);
    return { migrationId, skipped: true, reason: "connection_offline" };
  }
  const instance = conn.metadata?.evolution_instance ?? instanceNameFor(mig.connection_id);

  const { data: batch } = await supabase.from("group_migration_targets")
    .select("*").eq("migration_id", mig.id).eq("status", "pending").limit(mig.batch_size ?? 3);

  if (!batch || batch.length === 0) {
    await supabase.from("group_migrations").update({
      status: "completed", finished_at: new Date().toISOString(),
    }).eq("id", mig.id);
    return { migrationId, completed: true };
  }

  const phones = batch.map((t: any) => t.phone);
  let added = 0, failed = 0, skipped = 0;
  const errors: Record<string, string> = {};

  try {
    const res = await evolution.addGroupParticipants(instance, mig.target_group_jid, phones);
    // Evolution v2 devolve array por participante com status. Normalizamos.
    const list = Array.isArray(res) ? res : (res?.participants ?? res?.data ?? []);
    const byPhone: Record<string, any> = {};
    for (const item of list) {
      const jid = String(item?.jid ?? item?.id ?? "");
      const phone = jid.split("@")[0]?.replace(/\D/g, "") ?? "";
      if (phone) byPhone[phone] = item;
    }
    for (const t of batch) {
      const it = byPhone[t.phone];
      const status = it?.status ?? (list.length ? "unknown" : "success");
      if (status === "success" || status === 200 || String(status) === "200") {
        await supabase.from("group_migration_targets").update({
          status: "added", added_at: new Date().toISOString(),
        }).eq("id", t.id);
        added++;
      } else if (status === "skipped" || status === "already_in_group") {
        await supabase.from("group_migration_targets").update({ status: "skipped", error: String(status) }).eq("id", t.id);
        skipped++;
      } else {
        const err = String(it?.message ?? status ?? "erro");
        await supabase.from("group_migration_targets").update({ status: "failed", error: err }).eq("id", t.id);
        failed++;
        errors[t.phone] = err;
      }
    }
  } catch (e: any) {
    // Falha em massa: marca todos como failed
    for (const t of batch) {
      await supabase.from("group_migration_targets").update({
        status: "failed", error: String(e?.message ?? "erro"),
      }).eq("id", t.id);
      failed++;
    }
  }

  const nextAt = new Date(Date.now() + jitter(mig.min_delay_seconds ?? 45, mig.max_delay_seconds ?? 120) * 1000).toISOString();
  const totalDone = (mig.added_count ?? 0) + added + (mig.failed_count ?? 0) + failed + (mig.skipped_count ?? 0) + skipped;
  const done = totalDone >= (mig.total ?? 0);

  await supabase.from("group_migrations").update({
    status: done ? "completed" : "running",
    added_count: (mig.added_count ?? 0) + added,
    failed_count: (mig.failed_count ?? 0) + failed,
    skipped_count: (mig.skipped_count ?? 0) + skipped,
    next_attempt_at: done ? null : nextAt,
    finished_at: done ? new Date().toISOString() : null,
    last_error: Object.keys(errors).length ? Object.values(errors)[0] : null,
  }).eq("id", mig.id);

  return { migrationId, added, failed, skipped, done };
}
