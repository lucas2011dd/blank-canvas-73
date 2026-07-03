import { useMemo, useState } from "react";
import { BR_STATES } from "@/lib/br-ddd";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export function BrGeoFilter({
  states, setStates, ddds, setDdds,
}: {
  states: string[];
  setStates: (v: string[]) => void;
  ddds: string[];
  setDdds: (v: string[]) => void;
}) {
  const [dddInput, setDddInput] = useState("");
  const [q, setQ] = useState("");
  const filtered = useMemo(
    () => BR_STATES.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.uf.includes(q.toUpperCase())),
    [q],
  );
  const toggleState = (uf: string) => {
    const s = new Set(states);
    s.has(uf) ? s.delete(uf) : s.add(uf);
    setStates(Array.from(s));
  };
  const addDdd = () => {
    const parts = dddInput.split(/[\s,;]+/).map((x) => x.replace(/\D/g, "")).filter((x) => x.length === 2);
    if (!parts.length) return;
    setDdds(Array.from(new Set([...ddds, ...parts])));
    setDddInput("");
  };
  const removeDdd = (d: string) => setDdds(ddds.filter((x) => x !== d));
  const hasFilter = states.length > 0 || ddds.length > 0;

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium">Filtro geográfico (opcional)</div>
        {hasFilter && (
          <button type="button" className="text-xs text-muted-foreground hover:underline"
            onClick={() => { setStates([]); setDdds([]); }}>
            limpar
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Só serão processados números BR (com DDI 55) cujos DDDs combinem com os estados/DDDs escolhidos. Sem filtro = todos.
      </p>

      <div>
        <Label className="text-xs">Estados</Label>
        <Input className="mt-1 h-8" placeholder="Buscar UF ou nome…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="mt-2 max-h-32 overflow-y-auto rounded border p-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
          {filtered.map((s) => (
            <label key={s.uf} className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-accent rounded px-1 py-0.5">
              <input type="checkbox" checked={states.includes(s.uf)} onChange={() => toggleState(s.uf)} />
              <span className="font-mono">{s.uf}</span>
              <span className="truncate text-muted-foreground">{s.name}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label className="text-xs">DDDs específicos</Label>
        <div className="flex gap-1 mt-1">
          <Input className="h-8" placeholder="Ex: 11, 21, 47" value={dddInput}
            onChange={(e) => setDddInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDdd(); } }} />
          <button type="button" className="rounded-md border px-2 text-xs hover:bg-accent" onClick={addDdd}>+</button>
        </div>
        {ddds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {ddds.map((d) => (
              <Badge key={d} variant="secondary" className="cursor-pointer" onClick={() => removeDdd(d)}>
                {d} ✕
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
