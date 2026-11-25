import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AskWearables, AskWearablesError, parseRetryAfter, type ClientOptions } from "../src/index.js";

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

function mock(responses: (Response | ((c: Call) => Response))[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: (init?.body as string) ?? "" };
    calls.push(c);
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return typeof r === "function" ? r(c) : r;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const NOW = 1_764_000_000_000;

function client(f: typeof fetch, o: Partial<ClientOptions> = {}) {
  const sleeps: number[] = [];
  const c = new AskWearables({
    apiKey: "aw_dev_key", signingSecret: "awsig_secret", baseUrl: "https://api.example.test/", user: "user-42",
    fetch: f, now: () => NOW, sleep: async (ms) => void sleeps.push(ms), ...o,
  });
  return { c, sleeps };
}

/** Verify a captured request the way the gate does. */
function verify(c: Call, secret = "awsig_secret") {
  const u = new URL(c.url);
  const msg = [c.headers["X-AskWearables-Timestamp"], c.headers["X-AskWearables-Nonce"], c.method, u.pathname, createHash("sha256").update(c.body).digest("hex")].join("\n");
  return createHmac("sha256", secret).update(msg).digest("hex") === c.headers["X-AskWearables-Signature"];
}

const packet = { packet_version: "1", packet_id: "pk_0123456789abcdef01234567", level: 1, operation: "compare_to_baseline", metrics: ["sleep_duration"], window: { start: "2026-11-18", end: "2026-11-24" }, findings: [{ metric: "sleep_duration", statement: "Sleep moderately below usual, 3 nights", direction: "below", magnitude: "moderate" }], data_quality: { freshness_hours: 5, coverage: 0.9, sources: ["apple_health"], baseline_days: 28, caveats: [] }, as_of: "2026-11-24T10:00:00Z", data_version: "dv_1", not_medical_advice: true };

describe("AskWearables client", () => {
  it("asks with a signed request, bearer key and user header", async () => {
    const m = mock([json({ status: "ok", packet, receipt_id: "rc_1" })]);
    const { c } = client(m.fetch);
    const res = await c.ask("Am I rested?", { purpose: "scheduling" });
    expect(res.status).toBe("ok");
    expect(res.packet?.findings[0]?.statement).toContain("below usual");
    const call = m.calls[0]!;
    expect(call.url).toBe("https://api.example.test/v1/ask");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer aw_dev_key");
    expect(call.headers["X-AskWearables-User"]).toBe("user-42");
    expect(call.headers["X-AskWearables-Timestamp"]).toBe(String(NOW / 1000));
    expect(JSON.parse(call.body)).toEqual({ question: "Am I rested?", purpose: "scheduling" });
    expect(verify(call)).toBe(true);
  });

  it("returns a denial as a result, not an exception", async () => {
    const m = mock([json({ status: "denied", reasons: ["metric_not_in_grant:hrv_rmssd"], receipt_id: "rc_2" }, 403)]);
    const res = await client(m.fetch).c.ask("Is my HRV going up?");
    expect(res).toEqual({ status: "denied", reasons: ["metric_not_in_grant:hrv_rmssd"], receipt_id: "rc_2" });
  });

  it("signs GET requests over an empty body and lets a call override the user", async () => {
    const m = mock([json({ operations: [], metrics: [], levels: [], grant: null, examples: [] })]);
    const caps = await client(m.fetch).c.capabilities({ user: "other" });
    expect(caps.grant).toBeNull();
    expect(m.calls[0]!.body).toBe("");
    expect(m.calls[0]!.headers["X-AskWearables-User"]).toBe("other");
    expect(m.calls[0]!.headers["content-type"]).toBeUndefined();
    expect(verify(m.calls[0]!)).toBe(true);
  });

  it("does not sign when no signing secret is set (OAuth tokens, owner keys)", async () => {
    const m = mock([json({ status: "ok", packet })]);
    await new AskWearables({ apiKey: "oauth-token", fetch: m.fetch }).query({ metrics: ["steps"], operation: "trend", window: { start: "2026-11-01", end: "2026-11-24" } });
    expect(m.calls[0]!.url).toBe("https://api.askwearables.app/v1/query");
    expect(m.calls[0]!.headers["X-AskWearables-Signature"]).toBeUndefined();
    expect(m.calls[0]!.headers["X-AskWearables-User"]).toBeUndefined();
    expect(JSON.parse(m.calls[0]!.body)).toEqual({ spec: { metrics: ["steps"], operation: "trend", window: { start: "2026-11-01", end: "2026-11-24" } } });
  });

  it("retries on 429 honouring Retry-After, re-signing with a fresh nonce", async () => {
    const m = mock([json({ error: "rate_limited" }, 429, { "retry-after": "2" }), json({ error: "rate_limited" }, 429, { "retry-after": "1" }), json({ status: "ok", packet })]);
    const { c, sleeps } = client(m.fetch);
    const res = await c.ask("How much did I sleep this week?");
    expect(res.status).toBe("ok");
    expect(sleeps).toEqual([2000, 1000]);
    expect(m.calls).toHaveLength(3);
    const nonces = new Set(m.calls.map((x) => x.headers["X-AskWearables-Nonce"]));
    expect(nonces.size).toBe(3);
    for (const x of m.calls) expect(verify(x)).toBe(true);
  });

  it("accepts Retry-After as an HTTP date and falls back to backoff without one", async () => {
    expect(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000);
    expect(parseRetryAfter("garbage", NOW)).toBeUndefined();
    const m = mock([new Response("", { status: 429 }), json([])]);
    const { c, sleeps } = client(m.fetch);
    await c.usage();
    expect(sleeps).toEqual([1000]);
  });

  it("gives up after maxRetries, or when Retry-After is longer than allowed", async () => {
    const m = mock([json({}, 429, { "retry-after": "1" }), json({}, 429, { "retry-after": "1" })]);
    await expect(client(m.fetch, { maxRetries: 1 }).c.usage()).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    const m2 = mock([json({}, 429, { "retry-after": "600" })]);
    const { c, sleeps } = client(m2.fetch);
    await expect(c.usage()).rejects.toMatchObject({ status: 429, retryAfterMs: 600_000 });
    expect(sleeps).toEqual([]);
  });

  it("throws AskWearablesError with the API's error code", async () => {
    const m = mock([json({ error: "unknown_user" }, 400)]);
    const err = await client(m.fetch).c.capabilities().catch((e) => e);
    expect(err).toBeInstanceOf(AskWearablesError);
    expect(err).toMatchObject({ status: 400, code: "unknown_user" });
  });

  it("returns null for a missing packet", async () => {
    const m = mock([json({ error: "not_found" }, 404), json(packet)]);
    const { c } = client(m.fetch);
    expect(await c.getPacket("pk_000000000000000000000000")).toBeNull();
    expect(m.calls[0]!.url).toBe("https://api.example.test/v1/packets/pk_000000000000000000000000");
    expect((await c.getPacket(packet.packet_id))?.packet_id).toBe(packet.packet_id);
  });

  it("creates users without the user header", async () => {
    const m = mock([json({ user: "user-7", created: true })]);
    expect(await client(m.fetch).c.createUser("user-7", { tz: "Europe/London" })).toEqual({ user: "user-7", created: true });
    expect(JSON.parse(m.calls[0]!.body)).toEqual({ external_id: "user-7", tz: "Europe/London" });
    expect(m.calls[0]!.headers["X-AskWearables-User"]).toBeUndefined();
  });

  it("creates consent links, and surfaces invalid requests as errors", async () => {
    const req = { purpose: "sleep_coaching", metrics: ["sleep_duration"], max_level: 1, max_window_days: 30, daily_packet_budget: 20, days: 30 } as const;
    const m = mock([json({ url: "https://auth.askwearables.app/consent/cl_abc", expires_in: 3600 }), json({ error: "invalid_request", details: ["metrics_empty"] })]);
    const { c } = client(m.fetch);
    expect((await c.createGrantLink({ ...req, metrics: [...req.metrics] })).url).toContain("/consent/");
    expect(m.calls[0]!.url).toBe("https://api.example.test/v1/grants");
    expect(verify(m.calls[0]!)).toBe(true);
    await expect(c.createGrantLink({ ...req, metrics: [] })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("ingests with source defaults and splits large batches", async () => {
    const m = mock([
      (call) => json({ written: JSON.parse(call.body).records.length, unchanged: 0, rejected: [{ index: 3, reason: "implausible:steps" }], days_recomputed: 2, data_version: "dv_a" }),
      (call) => json({ written: JSON.parse(call.body).records.length, unchanged: 1, rejected: [{ index: 0, reason: "bad_offset" }], days_recomputed: 1, data_version: "dv_b" }),
    ]);
    const records = Array.from({ length: 2500 }, (_, i) => ({ kind: "sample" as const, metric: "steps" as const, start: `2026-11-01T00:00:00Z`, end: `2026-11-01T01:00:00Z`, value: i, unit: "count", source_id: "", method: "measured" as const, tz_offset_min: 0, external_id: `s${i}` }));
    const res = await client(m.fetch).c.ingest({ source: { id: "phone:1", provider: "apple_health", device_class: "watch" }, records });
    expect(m.calls).toHaveLength(2);
    const first = JSON.parse(m.calls[0]!.body);
    expect(first.records).toHaveLength(2000);
    expect(first.records[0].source_id).toBe("phone:1");
    expect(first.source).toEqual({ id: "phone:1", provider: "apple_health", device_class: "watch", device_model: null, earliest_readable: null, last_sync_at: null, terms_flags: {}, connected_at: new Date(NOW).toISOString() });
    expect(m.calls[0]!.headers["X-AskWearables-User"]).toBe("user-42");
    expect(res).toEqual({ written: 2500, unchanged: 1, rejected: [{ index: 3, reason: "implausible:steps" }, { index: 2000, reason: "bad_offset" }], days_recomputed: 3, data_version: "dv_b" });
  });

  it("signs the path without the query string", async () => {
    const m = mock([json({ receipts: [] })]);
    await client(m.fetch).c.request({ op: "receipts", query: { limit: 5 } });
    expect(m.calls[0]!.url).toBe("https://api.example.test/v1/receipts?limit=5");
    expect(verify(m.calls[0]!)).toBe(true);
  });
});
