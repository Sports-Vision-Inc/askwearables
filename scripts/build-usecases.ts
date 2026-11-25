// Builds the "What people ask" scenarios on the landing page from the real engine.
//   npx tsx scripts/build-usecases.ts      ->  workers/site/public/data/usecases.json
//
// Each scenario is one synthetic person from the study cohort (eval/paper/synth.ts), stored and ingested exactly as the
// benchmark does, one grant, and one or more QuerySpecs sent through the real gate and compute engine
// (packages/core answerSpec). The packets, denials and reasons in the JSON are the engine's output, never typed by
// hand. The scenario copy (titles, the agent's words) carries no figures; the page fills every number from the packets.
// Deterministic for a given TODAY (pinned below), except the receipt ids, which are random by design.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const USECASE_TODAY = "2026-11-24";
const STRESS_PERSON = "p7";

type Json = Record<string, unknown>;

export async function buildUsecases(today = USECASE_TODAY) {
  // synth.ts reads the evaluation date when it loads, so pin it before importing.
  process.env.EVAL_TODAY = today;
  const core = await import("@askwearables/core");
  const { addDays, answerSpec, plainCipher } = core;
  const { makePeople, weightCanary } = await import("../eval/paper/synth.js");
  const { buildStore } = await import("../eval/paper/conditions.js");
  type Grant = import("@askwearables/core").Grant;
  type QuerySpec = import("@askwearables/core").QuerySpec;
  type Person = ReturnType<typeof makePeople>[number];

  const people = new Map(makePeople().map((p) => [p.id, p]));
  const now = new Date(`${today}T15:00:00Z`);
  const y = addDays(today, -1);

  function grantFor(p: Person, agent: string, over: Partial<Grant>): Grant {
    return { grant_id: `gr_${agent}_${p.id}`, user_id: `u_${p.id}`, agent_id: `ag_${agent}`, purpose: "general_wellness", metrics: [], max_level: 1, max_window_days: 60, daily_packet_budget: 50, expires_at: "2027-02-01T00:00:00Z", ...over };
  }

  async function run(personId: string, agentKey: string, agentName: string, grantOver: Partial<Grant>, specs: QuerySpec[], extra: (p: Person) => Person["records"] = () => []) {
    const p = people.get(personId)!;
    const s = await buildStore(p, extra(p));
    const grant = grantFor(p, agentKey, grantOver);
    const token = { valid: true, agent_id: grant.agent_id, user_id: grant.user_id, grant_id: grant.grant_id };
    const agent = { agent_id: grant.agent_id, name: agentName, registered_by: "example", verified_domain: null, model_facing: true };
    const asks: Json[] = [];
    for (const spec of specs) {
      const response = await answerSpec(s.sql, plainCipher, { token, grant, agent, spec, now, today });
      asks.push({ spec, response });
    }
    return { p, s, grant, asks };
  }

  const grantView = (g: Grant) => ({ purpose: g.purpose, metrics: g.metrics, max_level: g.max_level, max_window_days: g.max_window_days });

  // a. Scheduling: a calendar agent with a level-1 sleep grant. The short_sleep person slept far less the last 3 nights.
  const a = await run("p7", "calendar", "Calendar assistant", { purpose: "scheduling", metrics: ["sleep_duration"], max_level: 1 }, [
    { metrics: ["sleep_duration"], operation: "compare_to_baseline", window: { start: addDays(today, -3), end: y }, params: {} },
  ]);

  // b. Video coaching: the agent has its own video metrics for a session; it asks only for the wearable side.
  const session = addDays(today, -2);
  const b = await run("p9", "videocoach", "Video coaching agent", { purpose: "training_advice", metrics: ["hrv_rmssd", "resting_hr", "workout"], max_level: 2 }, [
    { metrics: ["hrv_rmssd"], operation: "trend", window: { start: addDays(today, -28), end: y }, params: {} },
    { metrics: ["resting_hr"], operation: "compare_to_baseline", window: { start: addDays(session, -1), end: addDays(session, 1) }, params: {} },
    { metrics: ["workout"], operation: "compare_periods", window: { start: addDays(today, -7), end: y }, params: { compare_window: { start: addDays(today, -14), end: addDays(today, -8) } } },
  ]);

  // c. "Stress points": no stress metric exists. Resting HR and HRV against the person's own usual range, one day at a
  // time: one level-1 packet per metric per day, so the agent learns each day's direction and size, never a value.
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -7 + i));
  const c = await run(STRESS_PERSON, "wellness", "Wellness journal agent", { purpose: "general_wellness", metrics: ["resting_hr", "hrv_rmssd"], max_level: 2 },
    (["resting_hr", "hrv_rmssd"] as const).flatMap((m) => days.map((day) => ({ metrics: [m], operation: "compare_to_baseline" as const, window: { start: day, end: day }, params: {} }))));

  // d. A refusal working: an insurance app with a steps-only grant asks for weight. Weight is in the store; the gate denies it.
  const d = await run("p1", "insurer", "Insurance rewards app", { purpose: "general_wellness", metrics: ["steps"], max_level: 1 }, [
    { metrics: ["weight"], operation: "latest", window: { start: addDays(today, -7), end: y }, params: {} },
    { metrics: ["steps"], operation: "compare_to_baseline", window: { start: addDays(today, -7), end: y }, params: {} },
  ], (p) => weightCanary(p).records);

  // The hero's device view: what one well-synced person's own devices show (p1, the clean profile), read by the
  // person themselves through a personal grant that is not model-facing, computed by the same engine. Every signal
  // has a reading for yesterday with its "vs your usual" bucket and a 7-day daily series. None of these values is
  // released to the agents on the cards. The stale and missing-data people stay in the story cards, where
  // "unknown" is the point.
  const DEVICE_PERSON = "p1";
  const dp = people.get(DEVICE_PERSON)!;
  const ds = await buildStore(dp);
  const SIGNALS = ["steps", "sleep_duration", "resting_hr", "hrv_rmssd", "workout", "spo2", "respiratory_rate", "skin_temp_deviation"] as const;
  const og = grantFor(dp, "owner", { purpose: "personal_research", metrics: [...SIGNALS], max_level: 2 });
  const otoken = { valid: true, agent_id: og.agent_id, user_id: og.user_id, grant_id: og.grant_id };
  const oagent = { agent_id: og.agent_id, name: "The person's own view", registered_by: "owner", verified_domain: null, model_facing: false };
  const ask1 = async (spec: QuerySpec) => (await answerSpec(ds.sql, plainCipher, { token: otoken, grant: og, agent: oagent, spec, now, today })).packet?.findings[0];
  const week = { start: addDays(today, -7), end: y };
  const signals: Record<string, Json> = {};
  const missing: string[] = [];
  for (const metric of SIGNALS) {
    const isWorkout = metric === "workout";
    const latest = isWorkout ? null : await ask1({ metrics: [metric], operation: "latest", window: week, params: {} });
    const series = await ask1({ metrics: [metric], operation: "aggregate", window: week, params: { statistic: isWorkout || metric === "steps" ? "total" : "mean" } });
    const values = (series?.values ?? []) as { day: string; value: number }[];
    if ((latest && latest.value == null) || (!latest && series?.value == null) || (!isWorkout && latest?.unknown_reason)) { missing.push(metric); continue; }
    const day = latest?.values?.length ? latest.values[latest.values.length - 1]!.day : null;
    const out: Json = {
      value: latest ? latest.value : series!.value, unit: (latest ?? series)!.unit, day,
      usual: latest ? { direction: latest.direction, magnitude: latest.magnitude } : null,
      statement: (latest ?? series)!.statement, week: values, week_value: series?.value ?? null,
    };
    if (metric === "sleep_duration" && day) {
      // The vault's daily rollup for that night carries the stage split (engine ingest code, not typed here).
      const row = ds.sql.all<{ extra: string | null }>(`SELECT extra FROM daily_rollups WHERE metric = 'sleep_stages' AND day = ?`, day)[0];
      if (row?.extra) out.stages = JSON.parse(row.extra);
    }
    signals[metric] = out;
  }
  const device = { person: DEVICE_PERSON, trap: dp.trap, signals, not_in_cohort: missing };

  const pack = (x: typeof a, extraFields: Json = {}) => ({ person: x.p.id, trap: x.p.trap, grant: grantView(x.grant), asks: x.asks, ...extraFields });
  return {
    generated_by: "scripts/build-usecases.ts (packages/core answerSpec over eval/paper/synth.ts people)",
    today,
    device,
    cases: {
      meeting: { ...pack(a), session_day: null },
      video: { ...pack(b), session_day: session },
      stress: { ...pack(c), days },
      insurer: pack(d),
    },
  };
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(here, "build-usecases.ts")) {
  const out = await buildUsecases();
  const file = resolve(here, "../workers/site/public/data/usecases.json");
  writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  for (const [k, v] of Object.entries(out.cases)) {
    for (const a of v.asks as { spec: { operation: string; metrics: string[] }; response: { status: string; reasons?: string[]; packet?: { level: number; findings: { statement: string }[] } } }[]) {
      console.log(`${k}: ${a.spec.operation}(${a.spec.metrics}) -> ${a.response.status} ${a.response.packet ? `L${a.response.packet.level} "${a.response.packet.findings.map((f) => f.statement).join(" | ")}"` : (a.response.reasons ?? []).join(",")}`);
    }
  }
  console.log(`wrote ${file}`);
}
