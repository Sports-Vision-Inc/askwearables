// Runs without datasets: checks the committed PHIA mapping is well formed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateQuerySpec } from "@askwearables/core";
import type { MappingEntry } from "../src/phia.js";

const mapping = JSON.parse(readFileSync(new URL("../phia/mapping.json", import.meta.url), "utf8")) as { counts: { mapped: number; unsupported: number }; entries: MappingEntry[] };

describe("PHIA mapping (eval/phia/mapping.json)", () => {
  it("classifies every one of PHIA's 4000 objective questions exactly once", () => {
    expect(mapping.entries).toHaveLength(4000);
    expect(new Set(mapping.entries.map((e) => e.id)).size).toBe(4000);
    expect(mapping.counts.mapped + mapping.counts.unsupported).toBe(4000);
  });

  it("gives every mapped question a valid QuerySpec and an extraction rule", () => {
    for (const e of mapping.entries.filter((x) => x.status === "mapped")) {
      const v = validateQuerySpec(e.spec);
      expect(v.ok, `${e.id} ${JSON.stringify(v)}`).toBe(true);
      expect(e.extract).toBeDefined();
      expect(e.operation).toBe(e.spec!.operation);
    }
  });

  it("gives every unsupported question a reason and no spec, so nothing is guessed", () => {
    for (const e of mapping.entries.filter((x) => x.status === "unsupported")) {
      expect(e.reason, e.id).toBeTruthy();
      expect(e.spec).toBeUndefined();
      expect(e.extract).toBeUndefined();
    }
  });

  it("stores no question text or answers (PHIA is CC BY-NC; we keep ids and hashes only)", () => {
    const text = JSON.stringify(mapping.entries);
    expect(text).not.toMatch(/"question"|"label"|"code"/);
  });
});
