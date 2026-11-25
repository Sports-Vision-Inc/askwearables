import { createReadStream, createWriteStream, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { compute, ingest, upsertSource } from "@askwearables/core";
import type { CanonicalRecord, CanonicalSample, CanonicalSession, Source } from "@askwearables/core";
import { USER, freshStore } from "@askwearables/core/testing";
import { AppleHealthImporter, importAppleHealth, parseDevice } from "../src/apple-health.js";
import { XmlStream, parseOffsetTimestamp } from "../src/index.js";

const FIXTURE = readFileSync(new URL("./fixtures/apple-health-export.xml", import.meta.url), "utf8");

function runAll(text: string, chunkSize: number) {
  const imp = new AppleHealthImporter({ connectedAt: "2026-01-05T00:00:00.000Z" });
  const sources: Source[] = [];
  const records: CanonicalRecord[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    const b = imp.push(text.slice(i, i + chunkSize));
    sources.push(...b.sources);
    records.push(...b.records);
  }
  const b = imp.end();
  sources.push(...b.sources);
  records.push(...b.records);
  return { imp, sources, records };
}

const samples = (rs: CanonicalRecord[], metric: string) => rs.filter((r): r is CanonicalSample => r.kind === "sample" && r.metric === metric);
const sessions = (rs: CanonicalRecord[], kind: string) => rs.filter((r): r is CanonicalSession => r.kind === "session" && r.session_kind === kind);

describe("Apple Health export.xml importer", () => {
  it("parses timestamps with their own offsets", () => {
    expect(parseOffsetTimestamp("2026-01-02 07:00:00 -0500")).toEqual({ iso: "2026-01-02T12:00:00.000Z", ms: Date.parse("2026-01-02T12:00:00Z"), offset: -300 });
    expect(parseOffsetTimestamp("2026-03-29 10:00:00 +0200").offset).toBe(120);
    expect(parseOffsetTimestamp("2026-03-29 10:00:00 +0530").offset).toBe(330);
  });

  it("parses the HKDevice description", () => {
    expect(parseDevice("<<HKDevice: 0x600001>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:10.1>")).toEqual({
      name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch", hardware: "Watch6,2", software: "10.1",
    });
  });

  it("gives the same output whatever the chunk size (tags split across chunks)", () => {
    const whole = runAll(FIXTURE, FIXTURE.length);
    for (const size of [1, 7, 64, 1000]) {
      const r = runAll(FIXTURE, size);
      expect(r.records).toEqual(whole.records);
      expect(r.sources).toEqual(whole.sources);
    }
  });

  it("registers one source per sourceName+device with an inferred class and no owner name", () => {
    const { sources } = runAll(FIXTURE, 4096);
    const byClass = Object.fromEntries(sources.map((s) => [s.device_class, s]));
    expect(Object.keys(byClass).sort()).toEqual(["other", "phone", "ring", "scale", "watch"]);
    // Records without a device attribute (resting HR, VO2 max) form their own source for the same app.
    expect(sources.filter((s) => s.device_class === "watch").map((s) => s.device_model).sort()).toEqual(["Apple Watch", "Watch6,2"]);
    expect(byClass.phone!.device_model).toBe("iPhone15,2");
    expect(byClass.ring!.device_model).toBe("Oura");
    expect(byClass.scale!.device_model).toBe("WBS05");
    for (const s of sources) {
      expect(s.provider).toBe("apple_health");
      expect(JSON.stringify(s)).not.toMatch(/Test User/);
      expect(s.id).toMatch(/^ah_(watch|phone|ring|scale|other)_[0-9a-f]{8}$/);
    }
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
  });

  it("maps quantity records to catalogue metrics with units, offsets and stable ids", () => {
    const { records, imp } = runAll(FIXTURE, 4096);
    const steps = samples(records, "steps");
    expect(steps.map((s) => s.value).sort()).toEqual([790, 812]);
    expect(steps[0]).toMatchObject({ start: "2026-01-02T12:00:00.000Z", end: "2026-01-02T12:10:00.000Z", tz_offset_min: -300, unit: "count", method: "measured" });
    expect(samples(records, "active_energy")[0]).toMatchObject({ value: 35.5, unit: "kcal" });
    expect(samples(records, "heart_rate")[0]).toMatchObject({ value: 72, unit: "count/min" });
    expect(samples(records, "resting_hr")[0]).toMatchObject({ value: 54, method: "vendor_daily" });
    expect(samples(records, "hrv_sdnn")[0]).toMatchObject({ value: 48.2, unit: "ms" });
    expect(samples(records, "hrv_rmssd")).toHaveLength(0);
    expect(samples(records, "spo2")[0]).toMatchObject({ value: 0.97, unit: "fraction" });
    expect(samples(records, "respiratory_rate")[0]).toMatchObject({ value: 14.5, unit: "count/min" });
    expect(samples(records, "vo2max")[0]).toMatchObject({ value: 44.1, unit: "mL/min·kg" });
    expect(samples(records, "weight")[0]).toMatchObject({ value: 165.3, unit: "lb" });
    expect(imp.stats.skipped["type_not_imported:DietaryWater"]).toBe(1);
    const again = runAll(FIXTURE, 333).records;
    expect(again.map((r) => r.external_id)).toEqual(records.map((r) => r.external_id));
  });

  it("merges sleep stage samples into one session per night per source", () => {
    const { records, sources } = runAll(FIXTURE, 4096);
    const sl = sessions(records, "sleep");
    const watch = sources.find((s) => s.device_class === "watch")!.id;
    const ring = sources.find((s) => s.device_class === "ring")!.id;
    const w = sl.filter((s) => s.source_id === watch).sort((a, b) => a.start.localeCompare(b.start));
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ start: "2026-01-02T04:00:00.000Z", end: "2026-01-02T11:45:00.000Z", tz_offset_min: -300 });
    expect(w[0]!.detail).toEqual({ deep_min: 60, rem_min: 90, light_min: 300, awake_min: 15 });
    expect(w[1]!.detail).toEqual({ deep_min: 0, rem_min: 0, light_min: 420, awake_min: 0 });
    const o = sl.filter((s) => s.source_id === ring);
    expect(o).toHaveLength(1);
    // Unstaged night: span of the asleep samples, in-bed time kept.
    expect(o[0]).toMatchObject({ start: "2026-01-02T04:10:00.000Z", end: "2026-01-02T11:40:00.000Z" });
    expect(o[0]!.detail).toEqual({ awake_min: 0, in_bed_min: 480 });
  });

  it("reads workouts with their statistics, in either export style", () => {
    const { records } = runAll(FIXTURE, 4096);
    const wo = sessions(records, "workout");
    expect(wo).toHaveLength(2);
    expect(wo[0]).toMatchObject({ start: "2026-01-02T23:00:00.000Z", end: "2026-01-02T23:30:30.000Z", tz_offset_min: -300 });
    expect(wo[0]!.detail).toEqual({ type: "HKWorkoutActivityTypeRunning", energy_kcal: 301.2, distance_m: 5200, avg_hr: 151 });
    expect(wo[1]).toMatchObject({ start: "2026-03-29T08:00:00.000Z", tz_offset_min: 120 });
    expect(wo[1]!.detail).toEqual({ type: "HKWorkoutActivityTypeCycling", energy_kcal: 410, distance_m: 18400 });
  });

  it("ingests into the store: rollups per source, sleep on the wake date, nothing rejected", async () => {
    const sql = freshStore();
    let rejected = 0;
    for await (const b of importAppleHealth(FIXTURE, { batchSize: 7, connectedAt: "2026-01-05T00:00:00.000Z" })) {
      for (const s of b.sources) upsertSource(sql, USER, s);
      const r = await ingest(sql, USER, b.records);
      rejected += r.rejected.length;
    }
    expect(rejected).toBe(0);
    const rows = sql.all<{ metric: string; day: string; value: number; source_id: string }>(`SELECT metric, day, value, source_id FROM daily_rollups WHERE value IS NOT NULL ORDER BY metric, day, source_id`);
    const watchSleep = rows.filter((r) => r.metric === "sleep_duration" && r.source_id.startsWith("ah_watch"));
    expect(watchSleep.map((r) => [r.day, r.value])).toEqual([["2026-01-02", 450], ["2026-01-03", 420]]);
    expect(rows.find((r) => r.metric === "spo2")!.value).toBe(97);
    expect(rows.find((r) => r.metric === "weight")!.value).toBeCloseTo(74.98, 2);
    const res = compute({ sql, spec: { metrics: ["workout"], operation: "list_sessions", window: { start: "2026-01-01", end: "2026-03-31" } }, now: new Date("2026-04-01T00:00:00Z"), includeRaw: true });
    expect(res.findings[0]!.l2.value).toBe(2);
    // Re-import is idempotent.
    for await (const b of importAppleHealth(FIXTURE, { batchSize: 1000 })) {
      const r = await ingest(sql, USER, b.records);
      expect(r.written).toBe(0);
    }
  });

  it("handles a DOCTYPE internal subset, comments and '>' inside attribute values", () => {
    const opened: string[] = [];
    const x = new XmlStream({ open: (n, a) => opened.push(`${n}:${a.v ?? ""}`), close: () => {} });
    x.push(`<?xml version="1.0"?><!DOCTYPE a [ <!ELEMENT a (b)> <!ATTLIST b v CDATA #IMPLIED> ]><!-- c > d --><a><b v="x>y"/><b v='&lt;&amp;&#65;&#x42;'/></a>\n`);
    x.end();
    expect(opened).toEqual(["a:", "b:x>y", "b:<&AB"]);
  });
});

/** Write a synthetic export of about `mb` megabytes, one record at a time (never held in memory). */
async function writeSyntheticExport(path: string, mb: number): Promise<number> {
  const out = createWriteStream(path);
  const write = async (s: string) => {
    if (!out.write(s)) await once(out, "drain");
  };
  await write(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData (Record)*>\n]>\n<HealthData locale="en_US">\n`);
  const dev = `device="&lt;&lt;HKDevice: 0x6000>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:10.1&gt;"`;
  let n = 0;
  let t = Date.parse("2020-01-01T00:00:00Z");
  const fmt = (ms: number) => new Date(ms - 5 * 3_600_000).toISOString().replace("T", " ").slice(0, 19) + " -0500";
  while (out.bytesWritten + out.writableLength < mb * 1e6) {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++, n++, t += 60_000) {
      const type = n % 3 === 0 ? "HKQuantityTypeIdentifierHeartRate" : "HKQuantityTypeIdentifierStepCount";
      const unit = n % 3 === 0 ? "count/min" : "count";
      lines.push(` <Record type="${type}" sourceName="Synthetic Watch" sourceVersion="10.1" ${dev} unit="${unit}" creationDate="${fmt(t)}" startDate="${fmt(t)}" endDate="${fmt(t + 60_000)}" value="${60 + (n % 40)}">\n  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="0"/>\n </Record>\n`);
    }
    await write(lines.join(""));
  }
  await write(`</HealthData>\n`);
  out.end();
  await once(out, "finish");
  return n;
}

describe("Apple Health streaming at scale", () => {
  it("streams a ~50 MB export with flat memory", async () => {
    const path = join(tmpdir(), `askwearables-export-${process.pid}.xml`);
    try {
      const written = await writeSyntheticExport(path, 50);
      expect(statSync(path).size).toBeGreaterThan(49e6);
      const imp = new AppleHealthImporter();
      const heap: number[] = [];
      let count = 0;
      let chunks = 0;
      const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 256 * 1024 });
      for await (const chunk of stream) {
        count += imp.push(chunk as string).records.length; // records are dropped: a real caller ingests them
        if (++chunks % 20 === 0) heap.push(process.memoryUsage().heapUsed);
      }
      count += imp.end().records.length;
      expect(count).toBe(written);
      // The parser keeps only an unfinished tag between chunks.
      expect(imp.maxBuffered).toBeLessThan(2 * 256 * 1024);
      // Heap after the first quarter never grows by more than 64 MB, while the file is 50 MB.
      const base = Math.min(...heap.slice(0, Math.ceil(heap.length / 4)));
      const peak = Math.max(...heap);
      expect(peak - base).toBeLessThan(64 * 1024 * 1024);
    } finally {
      rmSync(path, { force: true });
    }
  }, 120_000);
});
