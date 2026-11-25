import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compute, ingest, upsertSource } from "@askwearables/core";
import type { CanonicalRecord, CanonicalSample, CanonicalSession } from "@askwearables/core";
import type { ImportBatch } from "../src/index.js";
import { USER, freshStore } from "@askwearables/core/testing";
import { CsvStream, importLifeSnapsDaily, importLifeSnapsHourly, importPhia, importPmdata, parseCsv, scanMinuteArray, wallToUtc } from "../src/index.js";

const fx = (p: string) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8");
const samples = (rs: CanonicalRecord[], metric: string) => rs.filter((r): r is CanonicalSample => r.kind === "sample" && r.metric === metric);
const sessions = (rs: CanonicalRecord[], kind: string) => rs.filter((r): r is CanonicalSession => r.kind === "session" && r.session_kind === kind);

async function load(b: ImportBatch) {
  const sql = freshStore();
  for (const s of b.sources) upsertSource(sql, USER, s);
  const res = await ingest(sql, USER, b.records);
  return { sql, res };
}

function* chunked(s: string, n: number) {
  for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n);
}

describe("CSV parser", () => {
  it("handles quotes, doubled quotes, CRLF and chunk boundaries", () => {
    const text = 'a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,,"multi\nline"\n3,z,end';
    const whole = parseCsv(text);
    expect(whole).toEqual([
      { a: "1", b: "x, y", c: 'he said "hi"' },
      { a: "2", b: "", c: "multi\nline" },
      { a: "3", b: "z", c: "end" },
    ]);
    for (const n of [1, 2, 3, 5]) {
      const p = new CsvStream();
      const rows: string[][] = [];
      for (const c of chunked(text, n)) rows.push(...p.push(c));
      rows.push(...p.end());
      expect(rows).toEqual([["a", "b", "c"], ["1", "x, y", 'he said "hi"'], ["2", "", "multi\nline"], ["3", "z", "end"]]);
    }
  });
});

describe("local wall time to UTC", () => {
  it("uses the zone's offset, including across daylight saving", () => {
    expect(wallToUtc("2019-11-01 07:00:00", "Europe/Oslo")).toEqual({ iso: "2019-11-01T06:00:00.000Z", offset: 60 });
    expect(wallToUtc("2019-07-01 07:00:00", "Europe/Oslo")).toEqual({ iso: "2019-07-01T05:00:00.000Z", offset: 120 });
    // In the spring-forward gap the offset from before the change is used.
    expect(wallToUtc("2020-03-29 02:30:00", "Europe/Oslo")).toEqual({ iso: "2020-03-29T01:30:00.000Z", offset: 60 });
    // In the fall-back overlap the first (summer) instant is used.
    expect(wallToUtc("2019-10-27 02:30:00", "Europe/Oslo")).toEqual({ iso: "2019-10-27T00:30:00.000Z", offset: 120 });
    expect(wallToUtc("2019-11-01 07:00:00", -300).iso).toBe("2019-11-01T12:00:00.000Z");
  });
});

describe("PMData importer", () => {
  const dir = "pmdata/p99";
  const files = () => ({
    "steps.json": fx(`${dir}/fitbit/steps.json`),
    "heart_rate.json": fx(`${dir}/fitbit/heart_rate.json`),
    "resting_heart_rate.json": fx(`${dir}/fitbit/resting_heart_rate.json`),
    "sleep.json": fx(`${dir}/fitbit/sleep.json`),
    "exercise.json": fx(`${dir}/fitbit/exercise.json`),
    "reporting.csv": fx(`${dir}/googledocs/reporting.csv`),
  });

  it("scans minute arrays in chunks without parsing the whole document", async () => {
    const text = fx(`${dir}/fitbit/heart_rate.json`);
    const all: [string, number][] = [];
    await scanMinuteArray(chunked(text, 3), (w, v) => all.push([w, v]));
    expect(all).toEqual([["2019-11-01 00:00:05", 54], ["2019-11-01 00:00:10", 52], ["2019-11-01 00:00:20", 50], ["2019-11-01 00:01:05", 60]]);
  });

  it("maps the Fitbit files to canonical records", async () => {
    const b = await importPmdata(files(), { participant: "p99" });
    expect(b.sources).toEqual([expect.objectContaining({ id: "pmdata_p99", device_class: "watch", device_model: "Fitbit Versa 2" })]);
    const steps = samples(b.records, "steps");
    // Hourly sums, zero hours left out, Oslo offset (+60 in winter, +60 in the March gap).
    expect(steps.map((s) => [s.start, s.value, s.tz_offset_min])).toEqual([
      ["2019-11-01T06:00:00.000Z", 40, 60],
      ["2019-11-01T22:00:00.000Z", 100, 60],
      ["2020-03-29T01:00:00.000Z", 7, 60],
    ]);
    expect(b.stats.skipped.steps_zero_hour).toBe(1);
    expect(samples(b.records, "heart_rate").map((s) => s.value)).toEqual([52, 60]);
    expect(samples(b.records, "resting_hr")).toEqual([expect.objectContaining({ value: 53.74, method: "vendor_daily", start: "2019-10-31T23:00:00.000Z" })]);
    const sl = sessions(b.records, "sleep");
    expect(sl[0]).toMatchObject({ start: "2019-11-01T23:09:30.000Z", end: "2019-11-02T06:19:30.000Z", is_main: true, external_id: "sleep:24486013387" });
    expect(sl[0]!.detail).toEqual({ in_bed_min: 430, deep_min: 36, light_min: 259, rem_min: 83, awake_min: 52 });
    expect(sl[1]).toMatchObject({ is_main: false });
    expect(sl[1]!.detail).toEqual({ in_bed_min: 40, awake_min: 4 });
    const wo = sessions(b.records, "workout");
    expect(wo[0]).toMatchObject({ start: "2019-11-01T16:00:00.000Z", end: "2019-11-01T16:30:00.000Z" });
    expect(wo[0]!.detail).toEqual({ type: "Run", title: "Run", energy_kcal: 312, avg_hr: 151, distance_m: 5100 });
    expect(samples(b.records, "weight")).toEqual([expect.objectContaining({ value: 100, method: "manual" })]);
  });

  it("ingests cleanly; the main sleep wins over a nap and sleep lands on the wake date", async () => {
    const { sql, res } = await importPmdata(files(), { participant: "p99" }).then(load);
    expect(res.rejected).toEqual([]);
    const r = sql.all<{ value: number }>(`SELECT value FROM daily_rollups WHERE metric = 'sleep_duration' AND day = '2019-11-02'`);
    expect(r).toEqual([{ value: 378 }]);
    const res2 = compute({ sql, spec: { metrics: ["workout"], operation: "list_sessions", window: { start: "2019-11-01", end: "2019-11-01" } }, now: new Date("2019-11-03T00:00:00Z") });
    expect(res2.findings[0]!.l2.value).toBe(2);
  });
});

describe("LifeSnaps importer", () => {
  it("reads the daily CSV into one batch per participant", async () => {
    const out = await importLifeSnapsDaily(chunked(fx("lifesnaps-daily.csv"), 17));
    expect([...out.keys()]).toEqual(["aaa111", "bbb222"]);
    const a = out.get("aaa111")!;
    expect(a.sources[0]).toMatchObject({ id: "lifesnaps_aaa111", device_model: "Fitbit Sense", device_class: "watch" });
    const byMetric = (m: string) => samples(a.records, m).map((s) => [s.start.slice(0, 10), s.value]);
    expect(byMetric("hrv_rmssd")).toEqual([["2021-05-24", 89.603], ["2021-05-25", 94.303]]);
    expect(byMetric("spo2")).toEqual([["2021-05-25", 96.1]]);
    expect(byMetric("sleep_duration")).toEqual([["2021-05-24", 445], ["2021-05-25", 460]]);
    expect(byMetric("resting_hr")).toEqual([["2021-05-24", 62.0731], ["2021-05-25", 62.12]]);
    expect(byMetric("vo2max")).toEqual([["2021-05-24", 62.7921], ["2021-05-25", 62.6791]]);
    expect(a.records.filter((r) => r.kind === "vendor_score")).toHaveLength(1); // stress 0.0 means no score
    expect(samples(out.get("bbb222")!.records, "steps")).toHaveLength(1);
    const only = await importLifeSnapsDaily(fx("lifesnaps-daily.csv"), { participants: ["bbb222"] });
    expect([...only.keys()]).toEqual(["bbb222"]);
  });

  it("adds hourly steps and heart rate, and ingests without rejections", async () => {
    const out = await importLifeSnapsDaily(fx("lifesnaps-daily.csv"));
    await importLifeSnapsHourly(fx("lifesnaps-hourly.csv"), {}, out);
    const a = out.get("aaa111")!;
    expect(samples(a.records, "steps").filter((s) => s.method === "measured").map((s) => [s.start, s.value])).toEqual([["2021-05-24T00:00:00.000Z", 134]]);
    expect(samples(a.records, "heart_rate").map((s) => s.value)).toEqual([66.87, 58.71]);
    const { sql, res } = await load(a);
    expect(res.rejected).toEqual([]);
    // The vendor's daily steps total wins over the partial hourly samples.
    expect(sql.all(`SELECT value FROM daily_rollups WHERE metric = 'steps' AND day = '2021-05-24'`)).toEqual([{ value: 8833 }]);
    expect(sql.all(`SELECT value FROM daily_rollups WHERE metric = 'hrv_rmssd' AND day = '2021-05-25'`)).toEqual([{ value: 94.303 }]);
  });
});

describe("PHIA synthetic user importer", () => {
  it("maps summary and exercise rows", () => {
    const b = importPhia(fx("phia-summary.csv"), fx("phia-exercise.csv"));
    expect(b.sources).toHaveLength(1);
    expect(samples(b.records, "steps").map((s) => [s.start, s.value, s.method])).toEqual([
      ["2023-10-01T00:00:00.000Z", 5820.81, "vendor_daily"],
      ["2023-10-02T00:00:00.000Z", 12124.82, "vendor_daily"],
      ["2023-10-04T00:00:00.000Z", 9858.2, "vendor_daily"],
    ]);
    expect(samples(b.records, "hrv_rmssd")).toHaveLength(3);
    expect(samples(b.records, "resting_hr")).toHaveLength(2);
    expect(b.stats.skipped["missing:resting_heart_rate"]).toBe(1);
    const sl = sessions(b.records, "sleep");
    expect(sl).toHaveLength(2);
    expect(sl[0]).toMatchObject({ start: "2023-10-01T21:24:58.000Z", end: "2023-10-02T06:56:42.000Z" });
    expect(sl[0]!.detail).toEqual({ deep_min: 55.91, rem_min: 125.34, light_min: 316.31, awake_min: 74.19, in_bed_min: 571.75 });
    const wo = sessions(b.records, "workout");
    // End = start + duration (15.6 min), not the rounded endTime.
    expect(wo[1]).toMatchObject({ start: "2023-10-04T11:17:00.000Z", end: "2023-10-04T11:32:36.000Z" });
    expect(wo[1]!.detail).toMatchObject({ type: "Run", title: "Run", avg_hr: 124, energy_kcal: 111 });
  });

  it("ingests: sleep on the wake date, asleep minutes = deep + rem + light", async () => {
    const { sql, res } = await load(importPhia(fx("phia-summary.csv"), fx("phia-exercise.csv")));
    expect(res.rejected).toEqual([]);
    const rows = sql.all<{ day: string; value: number }>(`SELECT day, value FROM daily_rollups WHERE metric = 'sleep_duration' ORDER BY day`);
    expect(rows).toEqual([{ day: "2023-10-02", value: 497.56 }, { day: "2023-10-03", value: 438.77 }]);
    expect(sql.all(`SELECT value FROM daily_rollups WHERE metric = 'steps' AND day = '2023-10-02'`)).toEqual([{ value: 12124.82 }]);
  });
});
