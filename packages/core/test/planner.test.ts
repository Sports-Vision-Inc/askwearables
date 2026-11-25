import { describe, expect, it } from "vitest";
import { compute } from "../src/compute.js";
import { canonicalJson } from "../src/hash.js";
import { buildPacket } from "../src/packet.js";
import { parseLlmPlan, planWithRules } from "../src/planner.js";
import { validateQuerySpec } from "../src/queryspec.js";
import { ingest } from "../src/store.js";
import type { Level } from "../src/types.js";
import { USER, freshStore, seedSources, source, synthUser } from "./helpers.js";

const TODAY = "2026-11-24"; // a Tuesday

const CASES: [string, Record<string, unknown>][] = [
  ["What was my resting heart rate today?", { operation: "latest", metrics: ["resting_hr"], window: { start: TODAY, end: TODAY } }],
  ["How much did I sleep this week?", { operation: "aggregate", metrics: ["sleep_duration"], window: { start: "2026-11-23", end: TODAY } }],
  ["Is my HRV going up?", { operation: "trend", metrics: ["hrv_rmssd"], window: { start: "2026-10-28", end: TODAY } }],
  ["Am I rested?", { operation: "compare_to_baseline", metrics: ["sleep_duration"], window: { start: TODAY, end: TODAY } }],
  ["Steps this month compared to last month", { operation: "compare_periods", metrics: ["steps"], window: { start: "2026-11-01", end: TODAY }, params: { compare_window: { start: "2026-10-01", end: "2026-10-31" } } }],
  ["Did I sleep under 6 hours this week?", { operation: "threshold_check", metrics: ["sleep_duration"], params: { comparator: "<", threshold: 6, threshold_unit: "h" } }],
  ["Do I sleep better after exercise?", { operation: "correlate", metrics: ["workout", "sleep_efficiency"], params: { lag_days: 1 } }],
  ["What workouts did I do this week?", { operation: "list_sessions", metrics: ["workout"] }],
  ["Average resting heart rate over the last 30 days", { operation: "aggregate", metrics: ["resting_hr"], window: { start: "2026-10-26", end: TODAY }, params: { statistic: "mean" } }],
  ["How many steps yesterday?", { operation: "aggregate", metrics: ["steps"], window: { start: "2026-11-23", end: "2026-11-23" } }],
  ["Is my resting heart rate higher than usual?", { operation: "compare_to_baseline", metrics: ["resting_hr"] }],
  ["Did I walk more than 10000 steps every day last week?", { operation: "threshold_check", metrics: ["steps"], params: { comparator: ">", threshold: 10000, threshold_unit: "count", mode: "all" } }],
  ["Is my sleep getting worse?", { operation: "trend", metrics: ["sleep_duration"] }],
  ["What's my VO2 max?", { operation: "latest", metrics: ["vo2max"] }],
  ["How much did I weigh last month?", { operation: "aggregate", metrics: ["weight"], window: { start: "2026-10-01", end: "2026-10-31" } }],
];

describe("planner rules", () => {
  for (const [q, want] of CASES) {
    it(q, () => {
      const r = planWithRules(q, TODAY);
      expect(r?.status, q).toBe("ok");
      if (r?.status !== "ok") return;
      expect(r.spec).toMatchObject(want);
      expect(validateQuerySpec(r.spec).ok).toBe(true);
    });
  }

  it("returns unsupported for sensitive categories and null for things rules cannot map", () => {
    expect(planWithRules("What's my blood sugar?", TODAY)?.status).toBe("unsupported");
    expect(planWithRules("Am I pregnant?", TODAY)?.status).toBe("unsupported");
    expect(planWithRules("Write me a poem", TODAY)).toBeNull();
    expect(planWithRules("Grade my heart health from A to F", TODAY)?.status).toBe("unsupported");
    expect(planWithRules("What is the median of my steps last 14 days?", TODAY)?.status).toBe("unsupported");
    expect(planWithRules("What were the lowest REM sleep percent last 30 days", TODAY)?.status).toBe("unsupported");
    expect(planWithRules("What is the standard deviation of my resting heart rate last 7 days?", TODAY)?.status).toBe("unsupported");
  });

  it("validates LLM output strictly and never guesses", () => {
    expect(parseLlmPlan('{"supported": false}').status).toBe("unsupported");
    expect(parseLlmPlan("not json").status).toBe("unsupported");
    expect(parseLlmPlan({ supported: true, spec: { metrics: ["cholesterol"], operation: "latest", window: { start: TODAY, end: TODAY } } }).status).toBe("unsupported");
    expect(parseLlmPlan({ supported: true, spec: { metrics: ["steps"], operation: "latest", window: { start: TODAY, end: TODAY }, extra: 1 } }).status).toBe("unsupported");
    const ok = parseLlmPlan({ supported: true, spec: { metrics: ["steps"], operation: "latest", window: { start: TODAY, end: TODAY } } });
    expect(ok.status).toBe("ok");
  });
});

describe("repeatability acceptance test", () => {
  it("100 questions, 5 runs each on frozen data: byte-identical packets", async () => {
    const sql = freshStore();
    seedSources(sql, [source("w", "watch", "apple_health", { last_sync_at: "2026-11-24T08:00:00Z" })]);
    await ingest(sql, USER, synthUser({ sourceId: "w", start: "2026-08-01", days: 116, workoutEvery: 3 }));
    const templates = [
      "What was my resting heart rate on DATE?", "How much did I sleep in the last N days?", "Is my HRV going up over the last N days?",
      "Did I sleep under 7 hours in the last N days?", "How many steps in the last N days?", "Is my resting heart rate higher than usual in the last N days?",
      "What workouts did I do in the last N days?", "Average sleep efficiency over the last N days", "Did I walk more than 8000 steps every day in the last N days?",
      "Is my sleep getting worse over the last N days?",
    ];
    const questions: string[] = [];
    for (let i = 0; i < 100; i++) {
      const t = templates[i % templates.length]!;
      questions.push(t.replace("N", String(3 + (i % 25))).replace("DATE", `2026-11-${String(1 + (i % 24)).padStart(2, "0")}`));
    }
    let planned = 0;
    for (const q of questions) {
      const plan = planWithRules(q, "2026-11-24");
      if (plan?.status !== "ok") continue;
      planned++;
      const level = ((planned % 3) as Level);
      const outs = new Set<string>();
      for (let run = 0; run < 5; run++) {
        const again = planWithRules(q, "2026-11-24");
        if (again?.status !== "ok") throw new Error("planner unstable");
        const r = compute({ sql, spec: again.spec, now: new Date(Date.UTC(2026, 10, 24, 12, run * 7)) });
        outs.add(canonicalJson(await buildPacket(r, level)));
      }
      expect(outs.size, q).toBe(1);
    }
    expect(planned).toBe(100);
  });
});

describe("planner v2 fixes", () => {
  it("accepts common unit spellings in thresholds", () => {
    const v = validateQuerySpec({ metrics: ["sleep_duration"], operation: "threshold_check", window: { start: "2026-11-18", end: "2026-11-24" }, params: { comparator: "<", threshold: 6, threshold_unit: "hours", mode: "any" } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.spec.params!.threshold_unit).toBe("h");
    expect(validateQuerySpec({ metrics: ["weight"], operation: "threshold_check", window: { start: "2026-11-18", end: "2026-11-24" }, params: { comparator: ">", threshold: 180, threshold_unit: "pounds" } }).ok).toBe(true);
    expect(validateQuerySpec({ metrics: ["steps"], operation: "threshold_check", window: { start: "2026-11-18", end: "2026-11-24" }, params: { comparator: ">", threshold: 1, threshold_unit: "furlongs" } }).ok).toBe(false);
  });
  it("does not read an ordinary 'period' as cycle tracking, but still refuses cycle questions", () => {
    expect(planWithRules("What was my average resting heart rate over the period from 2026-11-10 to 2026-11-23?", TODAY)?.status).not.toBe("unsupported");
    expect(planWithRules("When is my next period?", TODAY)?.status).toBe("unsupported");
    expect(planWithRules("Track my menstrual cycle", TODAY)?.status).toBe("unsupported");
  });
});
