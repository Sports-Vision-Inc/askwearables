import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ingest, upsertSource } from "@askwearables/core";
import { USER, freshStore } from "@askwearables/core/testing";
import { cleanRr, hrvFromBeats, importMmash, parseRr } from "../src/mmash.js";

const fx = (p: string) => readFileSync(new URL(`./fixtures/mmash/${p}`, import.meta.url), "utf8");

describe("MMASH RR intervals to HRV", () => {
  it("cleans artefacts and computes RMSSD and SDNN by the textbook formulas", () => {
    const beats = parseRr(fx("RR.csv")).filter((b) => b.t >= 22 * 3_600_000);
    const clean = cleanRr(beats);
    expect(clean.map((c) => c.beat.rr)).toEqual([800, 810, 790, 820, 805, 815]);
    const h = hrvFromBeats(beats);
    // Successive differences between consecutive clean beats: 10, -20, 30 and (after the dropped 3000 ms beat) 10.
    expect(h.pairs).toBe(4);
    expect(h.rmssd).toBeCloseTo(Math.sqrt((100 + 400 + 900 + 100) / 4), 9);
    expect(h.rmssd).toBeCloseTo(19.3649, 4);
    expect(h.sdnn).toBeCloseTo(Math.sqrt(583.3333333 / 5), 6);
    expect(h.sdnn).toBeCloseTo(10.8012, 4);
    expect(h.rejected).toBe(1);
  });

  it("imports one night with RMSSD and SDNN as separate metrics that stay separate in the store", async () => {
    const b = importMmash(fx("RR.csv"), fx("sleep.csv"), { user: "user_x", baseDate: "2026-02-01" });
    expect(b.records.map((r) => (r.kind === "sample" ? r.metric : r.kind))).toEqual(["session", "hrv_rmssd", "hrv_sdnn"]);
    const sql = freshStore();
    for (const s of b.sources) upsertSource(sql, USER, s);
    const res = await ingest(sql, USER, b.records);
    expect(res.rejected).toEqual([]);
    const rows = sql.all<{ metric: string; day: string; value: number }>(`SELECT metric, day, value FROM daily_rollups WHERE metric LIKE 'hrv_%' ORDER BY metric`);
    expect(rows).toEqual([
      { metric: "hrv_rmssd", day: "2026-02-02", value: 19.365 },
      { metric: "hrv_sdnn", day: "2026-02-02", value: 10.801 },
    ]);
  });
});
