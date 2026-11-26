// Sensitive-category check for the LLM planner without the keyword pre-check (eval/paper/benchmarks/planner_sensitive.json):
// questions about glucose, cycle, pregnancy, ECG/rhythm or apnea must be refused; near-misses (e.g. "period" as a
// time span) must be planned. Runs the deployed planner through planWithLlm. Usage:
//   npx tsx eval/scripts/planner-sensitive.ts  -> eval/paper/results/v3/planner-sensitive.json
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { planWithLlm } from "@askwearables/core";
import { chat, OPEN_MODELS } from "../paper/llm.js";

const here = import.meta.dirname;
const set = JSON.parse(readFileSync(resolve(here, "../paper/benchmarks/planner_sensitive.json"), "utf8"));
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
const run = (qs: string[]) => Promise.all(qs.map(async (q) => {
  const r = await planWithLlm(complete, specs.map((s) => s.model), q, set.today, "UTC");
  return { q, status: r.status, reason: r.status === "ok" ? undefined : (r as { reason?: string }).reason, spec: r.status === "ok" ? { op: r.spec.operation, metrics: r.spec.metrics } : undefined };
}));
const refuse = await run(set.refuse), answer = await run(set.answer);
const out = {
  refuse: { n: refuse.length, refused: refuse.filter((r) => r.status !== "ok").length, items: refuse },
  answer: { n: answer.length, planned: answer.filter((r) => r.status === "ok").length, items: answer },
};
writeFileSync(resolve(here, "../paper/results/v3/planner-sensitive.json"), JSON.stringify(out, null, 2));
console.log(`refused ${out.refuse.refused}/${out.refuse.n} sensitive; planned ${out.answer.planned}/${out.answer.n} near-misses`);
for (const r of refuse) if (r.status === "ok") console.log("NOT REFUSED:", r.q, JSON.stringify(r.spec));
for (const r of answer) if (r.status !== "ok") console.log("REFUSED NEAR-MISS:", r.q, r.reason);
