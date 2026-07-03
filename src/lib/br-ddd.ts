// Mapa de DDDs por estado (Brasil) — usado nos filtros de migração/disparo.
// Fontes: Anatel. Ordem estável para UI.
export const BR_STATES: Array<{ uf: string; name: string; ddds: string[] }> = [
  { uf: "AC", name: "Acre", ddds: ["68"] },
  { uf: "AL", name: "Alagoas", ddds: ["82"] },
  { uf: "AM", name: "Amazonas", ddds: ["92", "97"] },
  { uf: "AP", name: "Amapá", ddds: ["96"] },
  { uf: "BA", name: "Bahia", ddds: ["71", "73", "74", "75", "77"] },
  { uf: "CE", name: "Ceará", ddds: ["85", "88"] },
  { uf: "DF", name: "Distrito Federal", ddds: ["61"] },
  { uf: "ES", name: "Espírito Santo", ddds: ["27", "28"] },
  { uf: "GO", name: "Goiás", ddds: ["62", "64"] },
  { uf: "MA", name: "Maranhão", ddds: ["98", "99"] },
  { uf: "MG", name: "Minas Gerais", ddds: ["31", "32", "33", "34", "35", "37", "38"] },
  { uf: "MS", name: "Mato Grosso do Sul", ddds: ["67"] },
  { uf: "MT", name: "Mato Grosso", ddds: ["65", "66"] },
  { uf: "PA", name: "Pará", ddds: ["91", "93", "94"] },
  { uf: "PB", name: "Paraíba", ddds: ["83"] },
  { uf: "PE", name: "Pernambuco", ddds: ["81", "87"] },
  { uf: "PI", name: "Piauí", ddds: ["86", "89"] },
  { uf: "PR", name: "Paraná", ddds: ["41", "42", "43", "44", "45", "46"] },
  { uf: "RJ", name: "Rio de Janeiro", ddds: ["21", "22", "24"] },
  { uf: "RN", name: "Rio Grande do Norte", ddds: ["84"] },
  { uf: "RO", name: "Rondônia", ddds: ["69"] },
  { uf: "RR", name: "Roraima", ddds: ["95"] },
  { uf: "RS", name: "Rio Grande do Sul", ddds: ["51", "53", "54", "55"] },
  { uf: "SC", name: "Santa Catarina", ddds: ["47", "48", "49"] },
  { uf: "SE", name: "Sergipe", ddds: ["79"] },
  { uf: "SP", name: "São Paulo", ddds: ["11", "12", "13", "14", "15", "16", "17", "18", "19"] },
  { uf: "TO", name: "Tocantins", ddds: ["63"] },
];

export function dddsForStates(ufs: string[] | undefined | null): string[] {
  if (!ufs?.length) return [];
  const set = new Set<string>();
  for (const uf of ufs) {
    const s = BR_STATES.find((r) => r.uf === uf.toUpperCase());
    if (s) s.ddds.forEach((d) => set.add(d));
  }
  return Array.from(set);
}

// Extrai o DDD de um telefone (esperado com DDI 55 no início).
// Ex: 5511987654321 -> "11". Fora do Brasil retorna "".
export function extractBrDdd(phone: string): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (!d.startsWith("55") || d.length < 4) return "";
  return d.slice(2, 4);
}

// Retorna true se `phone` combina com o filtro. Se ambos vazios, passa tudo.
// Números não-BR (sem prefixo 55) são bloqueados quando existir qualquer filtro.
export function phoneMatchesBrFilter(
  phone: string,
  opts: { states?: string[] | null; ddds?: string[] | null } | null | undefined,
): boolean {
  const st = opts?.states ?? [];
  const dd = opts?.ddds ?? [];
  if (!st.length && !dd.length) return true;
  const ddd = extractBrDdd(phone);
  if (!ddd) return false;
  const allowed = new Set<string>([...dd.map((x) => String(x).replace(/\D/g, "")), ...dddsForStates(st)]);
  return allowed.has(ddd);
}
