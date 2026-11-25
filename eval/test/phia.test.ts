// PHIA accuracy: skipped cleanly when eval/data has not been fetched (CI without datasets stays green).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type MappingEntry, buildMapping, dataAvailable, runPhiaEval, summarize } from "../src/phia.js";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
const have = dataAvailable(dataDir);
const mapping = (JSON.parse(readFileSync(new URL("../phia/mapping.json", import.meta.url), "utf8")) as { entries: MappingEntry[] }).entries;

describe("PHIA accuracy eval", () => {
  it.skipIf(!have)("the committed mapping matches a rebuild from the fetched questions", () => {
    const rebuilt = buildMapping(dataDir);
    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(mapping);
  });

  it.skipIf(!have)("reproduces PHIA's reference answers and explains every mismatch", async () => {
    const { results, rejected } = await runPhiaEval(dataDir, mapping, "question");
    expect(rejected).toBe(0);
    const t = summarize(results);
    expect(t.unsupported + t.total.mapped).toBe(4000);
    // Every unsupported question is classified and never answered.
    expect(results.filter((r) => r.status === "unsupported").every((r) => r.ours === null && r.reason)).toBe(true);
    // Every mismatch has a documented cause (definition differences listed in eval/phia/NOTES.md).
    expect(t.mismatch_causes.unexplained ?? 0).toBe(0);
    expect(t.total.accuracy_excl_explained).toBe(1);
  }, 300_000);

  it.skipIf(!have)("meets the 90% pass mark when run on PHIA's own windows (computation, not definitions)", async () => {
    const { results } = await runPhiaEval(dataDir, mapping, "reference");
    const t = summarize(results);
    expect(t.total.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(t.rows.find((r) => r.operation === "aggregate")!.accuracy).toBe(1);
  }, 300_000);
});
