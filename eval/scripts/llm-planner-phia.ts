// The LLM planner (as deployed: inkling-2-small, fallback gpt-oss-120b) on every PHIA objective question.
// Measures honest refusal on unsupported questions and agreement with the hand-built mapping on the rest.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { planWithLlm } from "@askwearables/core";
import { type MappingEntry, loadQuestions, loadUserFiles, toPhiaData, userToday } from "../src/phia.js";
import { chat, OPEN_MODELS } from "../paper/llm.js";

const dataDir = resolve(import.meta.dirname, "../data");
const ver = process.argv.find((a) => a.startsWith("--version="))?.slice(10) ?? "";
const out = resolve(import.meta.dirname, `../paper/${process.env.EVAL_RESULTS_DIR ?? "results"}/planner-phia${process.argv.includes("--heldout") ? "-heldout" : ""}${ver ? `_${ver}` : ""}.jsonl`);
const models = (process.argv[2] ?? "inkling-2-small,gpt-oss-120b").split(",");
const specs = models.map((id) => OPEN_MODELS.find((m) => m.id === id)!);
const mapping: MappingEntry[] = JSON.parse(readFileSync(resolve(import.meta.dirname, "../phia/mapping.json"), "utf8")).entries;
const byId = new Map(mapping.map((m) => [m.id, m]));
const sample = Number(process.argv[3] ?? 0);
let qs = loadQuestions(dataDir).filter((q) => byId.has(q.id));
if (sample) {
  // Stratified, deterministic sample: every k-th question within mapped and unsupported.
  // --heldout: a disjoint stratified sample (offset by half a stride), for validating the planner choice.
  const heldout = process.argv.includes("--heldout");
  const pick = (xs: typeof qs, n: number) => {
    const k = Math.max(1, Math.floor(xs.length / n));
    return xs.filter((_, i) => i % k === (heldout ? Math.floor(k / 2) : 0)).slice(0, n);
  };
  qs = [...pick(qs.filter((q) => byId.get(q.id)!.status === "mapped"), sample / 2), ...pick(qs.filter((q) => byId.get(q.id)!.status === "unsupported"), sample / 2)];
}
const done = new Set<string>();
if (existsSync(out)) for (const l of readFileSync(out, "utf8").split("\n")) if (l) done.add(JSON.parse(l).id + "|" + JSON.parse(l).planner);
const today = new Map<string, string>();
for (const q of qs) if (!today.has(q.user)) today.set(q.user, userToday(toPhiaData(loadUserFiles(dataDir, q.user))));
const planner = models.join("+");
const todo = qs.filter((q) => !done.has(q.id + "|" + planner));
console.log(`${todo.length} questions to plan with ${planner}`);
const complete = async (model: string, system: string, user: string) => {
  const m = specs.find((x) => x.model === model)!;
  const r = await chat(m, [{ role: "system", content: system }, { role: "user", content: user }], { max_tokens: 2500, temperature: 0 });
  if (r.error) throw new Error(r.error);
  return r.message.content ?? "";
};
let i = 0, n = 0;
await Promise.all(Array.from({ length: 40 }, async () => {
  while (i < todo.length) {
    const q = todo[i++]!;
    const m = byId.get(q.id)!;
    const t0 = Date.now();
    const r = await planWithLlm(complete, specs.map((s) => s.model), q.question, today.get(q.user)!, "UTC");
    const same = r.status === "ok" && m.status === "mapped" && r.spec.operation === m.spec!.operation && r.spec.metrics.join() === m.spec!.metrics.join();
    appendFileSync(out, JSON.stringify({ commit: process.env.STUDY_COMMIT ?? "uncommitted", id: q.id, planner, mapping: m.status, mapping_reason: m.reason ?? null, status: r.status, reason: r.status === "unsupported" ? r.reason : null, operation: r.status === "ok" ? r.spec.operation : null, metrics: r.status === "ok" ? r.spec.metrics : null, window: r.status === "ok" ? r.spec.window : null, map_operation: m.spec?.operation ?? null, map_metrics: m.spec?.metrics ?? null, map_window: m.spec?.window ?? null, same_op_metric: same, ms: Date.now() - t0 }) + "\n");
    if (++n % 200 === 0) console.log(`  ${n}/${todo.length}`);
  }
}));
console.log("done");
