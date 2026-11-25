// Phase 0 check: the bindings in each wrangler config match the four trust zones in the spec.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const cfg = (w: string) => JSON.parse(readFileSync(resolve(root, `workers/${w}/wrangler.jsonc`), "utf8"));
const DATA_KEYS = ["d1_databases", "kv_namespaces", "r2_buckets", "durable_objects", "queues", "vectorize", "hyperdrive", "analytics_engine_datasets"];
const services = (w: string): string[] => (cfg(w).services ?? []).map((s: { service: string }) => s.service.replace("askwearables-", ""));

describe("trust zones", () => {
  it("edge and planner have no binding to data or policy", () => {
    for (const w of ["edge", "planner"]) {
      const c = cfg(w);
      for (const k of DATA_KEYS) expect(c[k], `${w}.${k}`).toBeUndefined();
      expect(services(w)).not.toContain("vault");
    }
    expect(services("edge").sort()).toEqual(["auth", "gate", "planner"]);
    expect(services("planner")).toEqual([]);
    expect(cfg("planner").ai).toBeDefined();
  });
  it("public Workers cannot reach stored data or provider tokens", () => {
    for (const w of ["site", "console"]) {
      const c = cfg(w);
      for (const k of DATA_KEYS) expect(c[k], `${w}.${k}`).toBeUndefined();
      expect(services(w)).not.toContain("vault");
    }
    expect(services("site")).toEqual([]);
    expect(services("console")).toEqual(["gate"]);
  });
  it("auth reaches D1 and its OAuth KV, never health data", () => {
    const c = cfg("auth");
    expect(c.durable_objects).toBeUndefined();
    expect(c.r2_buckets).toBeUndefined();
    expect(services("auth")).toEqual(["gate"]);
  });
  it("gate and vault have no public route; only vault owns the user Durable Objects", () => {
    for (const w of ["gate", "vault", "planner"]) {
      expect(cfg(w).routes, w).toBeUndefined();
      expect(cfg(w).workers_dev, w).toBe(false);
    }
    for (const w of ["site", "console", "auth", "edge", "gate", "planner"]) expect(cfg(w).durable_objects, w).toBeUndefined();
    expect(cfg("vault").durable_objects.bindings[0].class_name).toBe("UserVault");
    expect(services("vault")).toEqual([]);
    expect(services("gate").sort()).toEqual(["auth", "vault"]);
  });
  it("the planner prompt never carries data: planner source imports no store or compute", () => {
    const src = readFileSync(resolve(root, "workers/planner/src/index.ts"), "utf8");
    expect(src).not.toMatch(/\b(compute|ingest|listSources|baselineAsOf|VAULT|DB)\b/);
  });
});
