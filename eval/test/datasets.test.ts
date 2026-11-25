// Real-data smoke import for PMData and LifeSnaps. Skips cleanly when eval/data is absent.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importLifeSnaps, importPmdataParticipants, lifesnapsCsvDir, pmdataDir } from "../src/datasets.js";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
const havePm = existsSync(join(pmdataDir(dataDir), "p01/fitbit/sleep.json"));
const haveLs = existsSync(join(lifesnapsCsvDir(dataDir), "daily_fitbit_sema_df_unprocessed.csv"));

describe("real datasets import cleanly", () => {
  it.skipIf(!havePm)("PMData p01 and p02: nothing rejected, months of days rolled up", async () => {
    const out = await importPmdataParticipants(dataDir, ["p01", "p02"]);
    for (const s of out) {
      expect(s.rejected).toEqual({});
      expect(s.days).toBeGreaterThan(100);
      // Upstream repeats some sleep logs and weight reports; upserts on (source, external_id) keep one.
      expect(s.written).toBeGreaterThan(s.records * 0.95);
    }
  }, 300_000);

  it.skipIf(!haveLs)("LifeSnaps daily + hourly CSV: under 0.1% of records rejected as implausible", async () => {
    const out = await importLifeSnaps(dataDir);
    expect(out.length).toBe(71);
    const records = out.reduce((a, s) => a + s.records, 0);
    const rejected = out.reduce((a, s) => a + Object.values(s.rejected).reduce((x, y) => x + y, 0), 0);
    expect(records).toBeGreaterThan(100_000);
    expect(rejected / records).toBeLessThan(0.001);
  }, 300_000);
});
