import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "@askwearables/core";
import { backoffDelay, fetchWithBackoff, parseRetryAfter } from "../src/http.js";
import { derToP1363, hmacSha256, p1363ToDer, timingSafeEqual, toBase64, toHex, verifyHmacSha256 } from "../src/webhook.js";
import { CAPABILITY_MATRIX, capabilitiesFor, renderMatrixMarkdown } from "../src/capabilities.js";
import { ConnectorRegistry, DEFAULT_FLAGS, parseFlags } from "../src/registry.js";
import { PROVIDER_IDS, ProviderDisabled } from "../src/connector.js";
import { needsRefresh } from "../src/refresh.js";
import { clock, fakeFetch, json, noSleep, NOW } from "./helpers.js";

describe("429 backoff", () => {
  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("7", NOW)).toBe(7000);
    expect(parseRetryAfter("Tue, 24 Nov 2026 12:00:30 GMT", NOW)).toBe(30_000);
    expect(parseRetryAfter("Tue, 24 Nov 2026 11:00:00 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
  });

  it("doubles from the base and caps at maxMs, including a huge Retry-After", () => {
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, null))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(10, null, { maxMs: 5000 })).toBe(5000);
    expect(backoffDelay(0, 3_600_000)).toBe(60_000);
  });

  it("gives up after maxRetries and returns the last 429", async () => {
    const { fetch, calls } = fakeFetch({ "GET https://api.example.invalid/": json({}, 429) });
    const s = noSleep();
    const res = await fetchWithBackoff({ fetch, clock, sleep: s.sleep, backoff: { maxRetries: 3, baseMs: 100 } }, "https://api.example.invalid/x");
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(4);
    expect(s.waits).toEqual([100, 200, 400]);
  });

  it("retries 503 too, but never 400/401", async () => {
    const s = noSleep();
    const a = fakeFetch({ "GET https://api.example.invalid/": [json({}, 503), json({ ok: true })] });
    expect((await fetchWithBackoff({ fetch: a.fetch, clock, sleep: s.sleep }, "https://api.example.invalid/")).status).toBe(200);
    const b = fakeFetch({ "GET https://api.example.invalid/": json({}, 401) });
    expect((await fetchWithBackoff({ fetch: b.fetch, clock, sleep: s.sleep }, "https://api.example.invalid/")).status).toBe(401);
    expect(b.calls).toHaveLength(1);
  });
});

describe("webhook helpers", () => {
  it("HMAC-SHA256 matches RFC 4231 test case 2", async () => {
    const mac = await hmacSha256("Jefe", "what do ya want for nothing?");
    expect(toHex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(await verifyHmacSha256({ secret: "Jefe", message: "what do ya want for nothing?", signature: toBase64(mac), encoding: "base64" })).toBe(true);
    expect(await verifyHmacSha256({ secret: "Jefe", message: "what do ya want for nothing?", signature: toHex(mac).toUpperCase(), encoding: "hex" })).toBe(true);
    expect(await verifyHmacSha256({ secret: "Jefe", message: "tampered", signature: toHex(mac), encoding: "hex" })).toBe(false);
    expect(await verifyHmacSha256({ secret: "Jefe", message: "x", signature: undefined, encoding: "hex" })).toBe(false);
  });

  it("timingSafeEqual and DER <-> P1363 round trip", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    const sig = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i));
    expect(derToP1363(p1363ToDer(sig))).toEqual(sig);
  });
});

describe("capabilities and registry", () => {
  it("every provider's metrics are catalogue metrics and its default tier exists", () => {
    for (const id of PROVIDER_IDS) {
      const p = CAPABILITY_MATRIX[id];
      for (const m of p.metrics) expect(CATALOGUE[m], `${id}:${m}`).toBeDefined();
      expect(() => capabilitiesFor(id)).not.toThrow();
      // Vendor scores are names, never catalogue metrics.
      for (const s of p.vendorScores) expect(Object.keys(CATALOGUE)).not.toContain(s);
    }
  });

  it("tier selects capabilities at runtime (Garmin backfill is Enterprise-only)", () => {
    expect(capabilitiesFor("garmin").backfill).toBe(false);
    expect(capabilitiesFor("garmin", "enterprise")).toMatchObject({ backfill: true, historyDays: 30 });
    expect(() => capabilitiesFor("garmin", "platinum")).toThrow("unknown_tier");
  });

  it("all providers default OFF", () => {
    expect(Object.values(DEFAULT_FLAGS).every((f) => !f.enabled)).toBe(true);
    const r = new ConnectorRegistry();
    expect(r.enabled()).toEqual([]);
    for (const id of PROVIDER_IDS) expect(() => r.get(id)).toThrow(ProviderDisabled);
  });

  it("parses env flags and builds an enabled connector with its tier", () => {
    const flags = parseFlags('{"oura":{"enabled":true,"tier":"sandbox"},"polar":{"enabled":"yes"},"nonsense":{"enabled":true}}');
    expect(flags.oura).toEqual({ enabled: true, tier: "sandbox" });
    expect(flags.polar.enabled).toBe(false);
    const r = new ConnectorRegistry(flags, { oura: { clientId: "c", clientSecret: "s", sandbox: true } });
    expect(r.enabled()).toEqual(["oura"]);
    const c = r.get("oura");
    expect(c.provider).toBe("oura");
    expect(c.capabilities.webhooks).toBe(false);
    expect(c.capabilities.termsFlags).toEqual({ no_ai: true, no_intermediary: true });
  });

  it("an enabled provider without options is still refused", () => {
    expect(() => new ConnectorRegistry({ whoop: { enabled: true } }).get("whoop")).toThrow("no_options");
  });

  it("docs/providers/README.md embeds the generated matrix verbatim", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const readme = readFileSync(join(here, "../../../docs/providers/README.md"), "utf8");
    const block = /<!-- BEGIN CAPABILITY MATRIX \(generated\) -->\n([\s\S]*?)\n<!-- END CAPABILITY MATRIX -->/.exec(readme)?.[1];
    expect(block).toBe(renderMatrixMarkdown());
  });

  it("needsRefresh uses the injected clock with a skew", () => {
    expect(needsRefresh({ access_token: "a", expires_at: "2026-11-24T12:04:00Z" }, NOW)).toBe(true);
    expect(needsRefresh({ access_token: "a", expires_at: "2026-11-24T13:00:00Z" }, NOW)).toBe(false);
    expect(needsRefresh({ access_token: "a" }, NOW)).toBe(false);
  });
});
