// Packets for the worked examples in the paper. Run records store each agent's final answer but not the packets it
// received, so the packets are recomputed here: same synthetic person, same data, the QuerySpec each question maps to,
// released through the gate under the study's wellness grant. Deterministic; no model is called.
// Usage: EVAL_TODAY=2026-11-25 npx tsx eval/paper/example_packets.ts   -> eval/paper/out/example_packets.json
import { writeFileSync } from "node:fs";
import { answerSpec, plainCipher, addDays, type QuerySpec } from "@askwearables/core";
import { buildStore, wellnessGrant } from "./conditions.js";
import { makePeople, TODAY } from "./synth.js";

const y = addDays(TODAY, -1);
const EXAMPLES: { key: string; person: string; spec: QuerySpec }[] = [
  { key: "two_step_steps_yesterday", person: "p2", spec: { metrics: ["steps"], operation: "latest", window: { start: y, end: y }, params: {} } },
  { key: "missing_steps_total_7d", person: "p4", spec: { metrics: ["steps"], operation: "aggregate", window: { start: addDays(TODAY, -7), end: y }, params: { statistic: "total" } } },
  { key: "dst_hrv_trend_28d", person: "p10", spec: { metrics: ["hrv_rmssd"], operation: "trend", window: { start: addDays(TODAY, -28), end: y }, params: {} } },
];
const out: Record<string, unknown> = { today: TODAY };
const people = new Map(makePeople().map((p) => [p.id, p]));
for (const ex of EXAMPLES) {
  const p = people.get(ex.person)!;
  const s = await buildStore(p);
  const grant = wellnessGrant(p);
  const token = { valid: true, agent_id: grant.agent_id, user_id: grant.user_id, grant_id: grant.grant_id };
  const agent = { agent_id: grant.agent_id, name: "eval agent", registered_by: "eval", verified_domain: null, model_facing: true };
  const res = await answerSpec(s.sql, plainCipher, { token, grant, agent, spec: ex.spec, now: new Date(`${TODAY}T15:00:00Z`), today: TODAY });
  out[ex.key] = { person: ex.person, trap: p.trap, spec: ex.spec, response: res };
}
writeFileSync(new URL(`./${process.env.EVAL_OUT_DIR ?? "out"}/example_packets.json`, import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
