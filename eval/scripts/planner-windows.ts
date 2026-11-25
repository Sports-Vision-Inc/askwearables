// Planner window check (eval/paper/benchmarks/planner_windows.json), plus the asks agent models sent in the
// synthetic suite's week-over-week runs (in-distribution). Runs the deployed planner (llama-3.3-70b, fallback
// gpt-oss-120b) through planWithLlm; reports operation and exact-window agreement. Usage:
//   npx tsx eval/scripts/planner-windows.ts <label>   -> eval/paper/results/v3/planner-windows-<label>.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { planWithLlm } from "@askwearables/core";
import { chat, OPEN_MODELS } from "../paper/llm.js";

const here = import.meta.dirname;
const set = JSON.parse(readFileSync(resolve(here, "../paper/benchmarks/planner_windows.json"), "utf8"));
const specs = [OPEN_MODELS.find((m) => m.id === "llama-3.3-70b")!, OPEN_MODELS.find((m) => m.id === "gpt-oss-120b")!];
const complete = async (model: string, system: string, user: string) => {
  const m = specs.find((x) => x.model === model)!;
  for (let i = 0; i < 4; i++) {
    const r = await chat(m, [{ role: "system", content: system }, { role: "user", content: user }], { max_tokens: 2500, temperature: 0 });
    if (!r.error) return r.message.content ?? "";
    if (!/^(http_(401|408|429|5)|network)/.test(r.error)) throw new Error(r.error);
  }
  throw new Error("infra");
};
// In-distribution: every distinct ask the agents sent on the week-over-week task (study and second iteration).
const asks = new Set<string>();
for (const f of ["final/accuracy-open.jsonl", "final/accuracy-frontier.jsonl", "v2/accuracy-open.jsonl", "v2/accuracy-frontier.jsonl"]) {
  for (const l of readFileSync(resolve(here, "../paper/results", f), "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    if (r.condition !== "C_broker" || r.tag !== "steps_week_vs_prev") continue;
    for (const t of r.transcript_tools ?? []) if (t.name === "ask_wearables") { try { asks.add(JSON.parse(t.args).question); } catch { /* skip */ } }
  }
}
const today = set.today;
const eq = (a?: { start: string; end: string }, b?: string[]) => !!a && !!b && a.start === b[0] && a.end === b[1];
const held = await Promise.all(set.items.map(async (it: { q: string; op: string; w: string[]; cw?: string[] }) => {
  const r = await planWithLlm(complete, specs.map((s) => s.model), it.q, today, "UTC");
  const spec = r.status === "ok" ? r.spec : null;
  return { q: it.q, op_ok: spec?.operation === it.op, window_ok: eq(spec?.window, it.w) && (!it.cw || eq(spec?.params?.compare_window as never, it.cw)), got: spec ? { op: spec.operation, w: spec.window, cw: spec.params?.compare_window } : r };
}));
// For the in-distribution asks the expected periods are the 7 days ending yesterday and the 7 days before.
const ind = await Promise.all([...asks].map(async (q) => {
  const r = await planWithLlm(complete, specs.map((s) => s.model), q, today, "UTC");
  const spec = r.status === "ok" ? r.spec : null;
  const w = spec?.window, cw = spec?.params?.compare_window as { start: string; end: string } | undefined;
  const shifted = !!w && (w.start === "2026-11-11" || cw?.start === "2026-11-04");
  return { q, status: r.status, op: spec?.operation ?? null, w, cw, shifted };
}));
const out = {
  label: process.argv[2] ?? "run",
  heldout: { n: held.length, op: held.filter((x) => x.op_ok).length, window: held.filter((x) => x.op_ok && x.window_ok).length, items: held },
  week_asks: { n: ind.length, shifted: ind.filter((x) => x.shifted).length, refused: ind.filter((x) => x.status !== "ok").length, items: ind },
};
mkdirSync(resolve(here, "../paper/results/v3"), { recursive: true });
writeFileSync(resolve(here, `../paper/results/v3/planner-windows-${out.label}.json`), JSON.stringify(out, null, 1));
console.log(out.label, "held-out op", out.heldout.op, "/", out.heldout.n, "window", out.heldout.window, "| week asks", out.week_asks.n, "shifted", out.week_asks.shifted, "refused", out.week_asks.refused);
