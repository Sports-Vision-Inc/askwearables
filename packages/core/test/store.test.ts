import { describe, expect, it } from "vitest";
import { CATALOGUE, METRIC_IDS, MIN_LEVEL, OPERATIONS, mapWorkoutType, toCatalogueUnit } from "../src/catalogue.js";
import { baselineAsOf, deviation, getDataVersion, ingest } from "../src/store.js";
import { localDay, tzOffsetAt } from "../src/time.js";
import { USER, freshStore, seedSources, source, synthUser } from "./helpers.js";

describe("metric catalogue (schema test)", () => {
  it("defines every metric once, with its own unit accepted and a sane range", () => {
    for (const id of METRIC_IDS) {
      const d = CATALOGUE[id];
      expect(d.id).toBe(id);
      expect(d.unit.length).toBeGreaterThan(0);
      expect(d.range[0]).toBeLessThan(d.range[1]);
      expect(toCatalogueUnit(id, 1, d.unit)).toBe(1);
    }
  });
  it("matches the v1 catalogue in the spec", () => {
    const v1 = ["steps", "active_energy", "resting_hr", "heart_rate", "hrv_rmssd", "hrv_sdnn", "sleep_duration", "sleep_efficiency", "sleep_stages", "spo2", "respiratory_rate", "skin_temp_deviation", "vo2max", "weight", "workout"];
    expect(METRIC_IDS.filter((m) => !CATALOGUE[m].sensitive)).toEqual(v1);
    expect(METRIC_IDS.filter((m) => CATALOGUE[m].sensitive)).toEqual(["blood_glucose", "menstrual_cycle", "ecg_classification", "breathing_disturbances"]);
  });
  it("has a minimum level for each of the eight operations", () => {
    expect(OPERATIONS).toHaveLength(8);
    expect(MIN_LEVEL).toEqual({ latest: 2, aggregate: 2, trend: 1, compare_to_baseline: 1, compare_periods: 1, threshold_check: 0, correlate: 1, list_sessions: 2 });
  });
  it("converts units on ingest and rejects unknown ones", () => {
    expect(toCatalogueUnit("weight", 220, "lb")).toBeCloseTo(99.79, 2);
    expect(toCatalogueUnit("sleep_duration", 6, "h")).toBe(360);
    expect(toCatalogueUnit("skin_temp_deviation", 0.9, "degF")).toBeCloseTo(0.5, 5);
    expect(() => toCatalogueUnit("steps", 1, "furlongs")).toThrow(/unit_not_accepted/);
  });
  it("maps workout types to the shared list", () => {
    expect(mapWorkoutType("HKWorkoutActivityTypeRunning")).toBe("run");
    expect(mapWorkoutType("Strength Training")).toBe("strength");
    expect(mapWorkoutType("underwater basket weaving")).toBe("other");
  });
});

describe("time", () => {
  it("assigns the local day using the sample's own offset", () => {
    expect(localDay("2026-11-23T23:30:00Z", 60)).toBe("2026-11-24");
    expect(localDay("2026-11-24T03:00:00Z", -300)).toBe("2026-11-23");
  });
  it("reads IANA offsets including daylight saving", () => {
    expect(tzOffsetAt("America/New_York", new Date("2026-07-01T12:00:00Z"))).toBe(-240);
    expect(tzOffsetAt("America/New_York", new Date("2026-12-01T12:00:00Z"))).toBe(-300);
    expect(tzOffsetAt("Asia/Kolkata", new Date("2026-12-01T12:00:00Z"))).toBe(330);
  });
});

describe("store", () => {
  it("is idempotent on (source_id, external_id): re-import writes nothing and keeps data_version", async () => {
    const sql = freshStore();
    seedSources(sql, [source("watch1", "watch")]);
    const recs = synthUser({ sourceId: "watch1", start: "2026-10-01", days: 10 });
    const a = await ingest(sql, USER, recs);
    expect(a.written).toBe(recs.length);
    expect(a.rejected).toEqual([]);
    const v1 = getDataVersion(sql);
    const b = await ingest(sql, USER, recs);
    expect(b.written).toBe(0);
    expect(b.unchanged).toBe(recs.length);
    expect(getDataVersion(sql)).toBe(v1);
  });

  it("rejects implausible values, unknown units and unknown sources without failing the batch", async () => {
    const sql = freshStore();
    seedSources(sql, [source("watch1", "watch")]);
    const res = await ingest(sql, USER, [
      { kind: "sample", metric: "resting_hr", start: "2026-10-01T00:00:00Z", end: "2026-10-01T23:00:00Z", value: 900, unit: "bpm", source_id: "watch1", method: "vendor_daily", tz_offset_min: 0 },
      { kind: "sample", metric: "steps", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", value: 10, unit: "furlongs", source_id: "watch1", method: "measured", tz_offset_min: 0 },
      { kind: "sample", metric: "steps", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", value: 10, unit: "count", source_id: "nope", method: "measured", tz_offset_min: 0 },
      { kind: "sample", metric: "steps", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", value: 10, unit: "count", source_id: "watch1", method: "measured", tz_offset_min: 0 },
    ]);
    expect(res.written).toBe(1);
    expect(res.rejected.map((r) => r.reason)).toEqual(["implausible:resting_hr", "unit_not_accepted:steps:furlongs", "unknown_source"]);
  });

  it("rolls up a day: steps summed, coverage by hours, sleep attributed to the wake date", async () => {
    const sql = freshStore();
    seedSources(sql, [source("watch1", "watch")]);
    await ingest(sql, USER, synthUser({ sourceId: "watch1", start: "2026-10-01", days: 3, stepsPerHour: 500, sleepMin: () => 400 }));
    const rows = sql.all<{ metric: string; day: string; value: number; coverage: number }>(`SELECT metric, day, value, coverage FROM daily_rollups WHERE day = '2026-10-02' ORDER BY metric`);
    const by = Object.fromEntries(rows.map((r) => [r.metric, r]));
    expect(by.steps!.coverage).toBe(1); // 15 hours of 12 expected
    expect(by.sleep_duration!.value).toBe(400);
    expect(by.sleep_efficiency!.value).toBeCloseTo((400 / 420) * 100, 4);
    expect(by.hrv_rmssd).toBeDefined();
    expect(by.resting_hr!.value).toBeGreaterThan(50);
  });

  it("computes a baseline over 28 trailing days, needing 14 valid days", async () => {
    const sql = freshStore();
    seedSources(sql, [source("watch1", "watch")]);
    await ingest(sql, USER, synthUser({ sourceId: "watch1", start: "2026-10-01", days: 40, sleepMin: (_d, i) => 400 + (i % 5) * 10 }));
    const early = baselineAsOf(sql, "sleep_duration", "watch1", "2026-10-10");
    expect("insufficient" in early && early.n_days).toBe(9);
    const b = baselineAsOf(sql, "sleep_duration", "watch1", "2026-11-09");
    if ("insufficient" in b) throw new Error("expected baseline");
    expect(b.n_days).toBe(28);
    expect(b.median).toBe(420);
    expect(deviation(420, b).bucket).toBe("within");
    expect(deviation(b.q1 - b.iqr, b)).toEqual({ bucket: "moderately", direction: "below" });
    expect(deviation(b.q3 + 3 * b.iqr, b)).toEqual({ bucket: "far", direction: "above" });
  });

  it("leaves low-coverage days out of baselines and never interpolates", async () => {
    const sql = freshStore();
    seedSources(sql, [source("phone1", "phone")]);
    // Only 3 hours of steps a day: coverage 0.25.
    const recs = [];
    for (let d = 1; d <= 20; d++) {
      const day = `2026-10-${String(d).padStart(2, "0")}`;
      for (const h of ["09", "12", "15"]) recs.push({ kind: "sample" as const, metric: "steps" as const, start: `${day}T${h}:00:00.000Z`, end: `${day}T${h}:30:00.000Z`, value: 1000, unit: "count", source_id: "phone1", method: "measured" as const, tz_offset_min: 0 });
    }
    await ingest(sql, USER, recs);
    const cov = sql.all<{ coverage: number }>(`SELECT coverage FROM daily_rollups WHERE metric = 'steps' LIMIT 1`)[0]!.coverage;
    expect(cov).toBe(0.25);
    expect("insufficient" in baselineAsOf(sql, "steps", "phone1", "2026-10-21")).toBe(true);
    const n = sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM daily_rollups WHERE metric = 'steps'`)[0]!.n;
    expect(n).toBe(20); // no days invented
  });
});
