// MMASH HRV: RMSSD and SDNN from beat-to-beat intervals stay separate metrics. Skips without eval/data.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanRr, parseRr } from "@askwearables/importers";
import { mmashAvailable, mmashDir, runMmash } from "../src/mmash.js";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
const have = mmashAvailable(dataDir);

/** Textbook formulas, written independently of the importer. */
function reference(rr: number[], consecutive: boolean[]) {
  const diffs: number[] = [];
  for (let i = 1; i < rr.length; i++) if (consecutive[i]) diffs.push(rr[i]! - rr[i - 1]!);
  const rmssd = Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length);
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  const sdnn = Math.sqrt(rr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rr.length - 1));
  return { rmssd, sdnn };
}

describe("MMASH HRV check", () => {
  it.skipIf(!have)("computes RMSSD and SDNN per night; they differ and each matches the reference formula", async () => {
    const { nights } = await runMmash(dataDir);
    expect(nights.length).toBeGreaterThanOrEqual(10);
    for (const n of nights) {
      // Recompute from the raw file with the reference formulas over the same in-bed beats.
      const sleep = readFileSync(join(mmashDir(dataDir), n.user, "sleep.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
      const periods = sleep.map((c) => {
        const t = (d: string, hm: string) => ((Number(d) - 1) * 1440 + Number(hm.split(":")[0]) * 60 + Number(hm.split(":")[1])) * 60_000;
        return [t(c[1]!, c[2]!), t(c[3]!, c[4]!)] as const;
      });
      const beats = parseRr(readFileSync(join(mmashDir(dataDir), n.user, "RR.csv"), "utf8")).filter((b) => periods.some(([a, z]) => b.t >= a && b.t <= z));
      const clean = cleanRr(beats);
      const ref = reference(clean.map((c) => c.beat.rr), clean.map((c) => c.consecutive));
      expect(n.rmssd).toBeCloseTo(ref.rmssd, 6);
      expect(n.sdnn).toBeCloseTo(ref.sdnn, 6);
      // Separate metrics: different values, each stored under its own id for the same night.
      expect(Math.abs(n.rmssd - n.sdnn)).toBeGreaterThan(1);
      expect(n.store_rmssd).toBeCloseTo(n.rmssd, 2);
      expect(n.store_sdnn).toBeCloseTo(n.sdnn, 2);
      expect(n.store_rmssd).not.toBe(n.store_sdnn);
    }
  }, 120_000);
});
