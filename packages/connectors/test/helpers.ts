// Test helpers: recorded-fixture fetch, fixed clock, and canonical-output invariants. No network, no real data.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { CATALOGUE, type CanonicalRecord } from "@askwearables/core";
import type { RawRecord } from "../src/connector.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture<T = any>(provider: string, name: string): T {
  return JSON.parse(readFileSync(join(here, "fixtures", provider, `${name}.json`), "utf8")) as T;
}

export function fixtureText(provider: string, name: string): string {
  return readFileSync(join(here, "fixtures", provider, `${name}.json`), "utf8");
}

export const NOW = new Date("2026-11-24T12:00:00Z");
export const clock = () => NOW;

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = Response | ((req: Recorded) => Response | Promise<Response>);

/**
 * A fetch that answers from a route table: "METHOD url-prefix" -> response(s). An array is consumed in order
 * (last one repeats). Unmatched requests throw, so a test can never reach the network.
 */
export function fakeFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: Recorded[] = [];
  const counters = new Map<string, number>();
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const f = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body === undefined || init.body === null ? "" : String(init.body);
    const rec = { method, url, headers, body };
    calls.push(rec);
    const key = keys.find((k) => {
      const [m, prefix] = k.split(" ", 2) as [string, string];
      return m === method && url.startsWith(prefix);
    });
    if (!key) throw new Error(`unrouted request: ${method} ${url}`);
    const r = routes[key]!;
    let resp: Responder;
    if (Array.isArray(r)) {
      const i = counters.get(key) ?? 0;
      counters.set(key, i + 1);
      resp = r[Math.min(i, r.length - 1)]!;
    } else resp = r;
    const out = typeof resp === "function" ? await resp(rec) : resp;
    return out.clone();
  };
  return { fetch: f as typeof fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const noSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

export function rawOf(provider: RawRecord["provider"], type: string, payload: unknown, extra: Partial<RawRecord> = {}): RawRecord {
  return { provider, type, user_id: "u1", source_id: `${provider}:u1`, payload, received_at: NOW.toISOString(), ...extra };
}

/** Invariants every connector's output must satisfy. */
export function assertCanonical(records: CanonicalRecord[]): void {
  const seen = new Set<string>();
  for (const r of records) {
    expect(r.external_id, "external_id must be set").toBeTruthy();
    const k = `${r.source_id}|${r.external_id}`;
    expect(seen.has(k), `duplicate external_id ${k}`).toBe(false);
    seen.add(k);
    if (r.kind === "sample") {
      const def = CATALOGUE[r.metric];
      expect(def, `unknown metric ${r.metric}`).toBeDefined();
      expect(r.unit === def.unit || def.accepts[r.unit] !== undefined, `unit ${r.unit} not accepted for ${r.metric}`).toBe(true);
      expect(Number.isInteger(r.tz_offset_min)).toBe(true);
      expect(Math.abs(r.tz_offset_min)).toBeLessThanOrEqual(14 * 60);
      expect(r.start <= r.end).toBe(true);
    }
    if (r.kind === "session") {
      expect(r.start < r.end).toBe(true);
      expect(Number.isInteger(r.tz_offset_min)).toBe(true);
    }
    if (r.kind === "vendor_score") expect(Number.isFinite(r.value)).toBe(true);
  }
}

/** Vendor scores must never appear as metric samples. */
export function assertScoresApart(records: CanonicalRecord[], scoreNames: string[]): void {
  for (const r of records) {
    if (r.kind === "sample") expect(scoreNames).not.toContain(r.metric as string);
  }
}
