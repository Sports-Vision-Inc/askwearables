import { describe, expect, it } from "vitest";
import { OuraConnector, OURA_DAILY_TYPES } from "../src/providers/oura.js";
import { WebhookAuthError } from "../src/connector.js";
import { hmacSha256, toHex } from "../src/webhook.js";
import { assertCanonical, assertScoresApart, clock, fakeFetch, fixture, fixtureText, json, noSleep, NOW, rawOf } from "./helpers.js";

const SECRET = "test-oura-client-secret";
const make = (fetch?: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  new OuraConnector({ clientId: "test-oura-client", clientSecret: SECRET, clock, ...(fetch ? { fetch } : {}), getTokens: async () => ({ access_token: "fake-oura-access-1" }), ...extra });

const norm = (type: string, file: string, i = 0, tz?: number) => {
  const c = make();
  return c.normalize(rawOf("oura", type, fixture("oura", file).data[i], tz === undefined ? {} : { tz_offset_min: tz }));
};

const DAY = { start: "2026-11-19T23:00:00.000Z", end: "2026-11-20T23:00:00.000Z" };
const S = "oura:u1";

describe("oura normalize", () => {
  it("daily_activity -> steps, active energy, and the activity score kept apart", () => {
    const out = norm("daily_activity", "daily_activity");
    expect(out).toEqual([
      { kind: "sample", metric: "steps", ...DAY, value: 9412, unit: "count", source_id: S, method: "vendor_daily", external_id: "oura:daily_activity:da-0001:steps", tz_offset_min: 60 },
      { kind: "sample", metric: "active_energy", ...DAY, value: 412, unit: "kcal", source_id: S, method: "vendor_daily", external_id: "oura:daily_activity:da-0001:active_energy", tz_offset_min: 60 },
      { kind: "vendor_score", provider: "oura", name: "activity_score", value: 81, day: "2026-11-20", source_id: S, external_id: "oura:daily_activity:da-0001:score" },
    ]);
    assertCanonical(out);
  });

  it("daily_readiness -> skin temp deviation; readiness is a vendor score, not a metric", () => {
    const out = norm("daily_readiness", "daily_readiness");
    expect(out).toEqual([
      { kind: "sample", metric: "skin_temp_deviation", ...DAY, value: -0.21, unit: "degC", source_id: S, method: "vendor_daily", external_id: "oura:daily_readiness:dr-0001:temperature_deviation", tz_offset_min: 60 },
      { kind: "vendor_score", provider: "oura", name: "readiness", value: 78, day: "2026-11-20", source_id: S, external_id: "oura:daily_readiness:dr-0001" },
    ]);
    assertScoresApart(out, ["readiness"]);
  });

  it("daily_sleep -> sleep score only", () => {
    expect(norm("daily_sleep", "daily_sleep")).toEqual([{ kind: "vendor_score", provider: "oura", name: "sleep_score", value: 76, day: "2026-11-20", source_id: S, external_id: "oura:daily_sleep:ds-0001" }]);
  });

  it("sleep (long_sleep) -> session with stages in minutes, plus night metrics at the local offset", () => {
    const out = norm("sleep", "sleep", 0);
    const win = { start: "2026-11-19T22:10:00.000Z", end: "2026-11-20T06:05:00.000Z" };
    expect(out).toEqual([
      { kind: "session", session_kind: "sleep", ...win, source_id: S, external_id: "oura:sleep:sl-0001", tz_offset_min: 60, detail: { deep_min: 90, light_min: 240, rem_min: 100, awake_min: 45, in_bed_min: 475 }, is_main: true },
      { kind: "sample", metric: "sleep_efficiency", ...win, value: 90, unit: "percent", source_id: S, method: "vendor_daily", external_id: "oura:sleep:sl-0001:sleep_efficiency", tz_offset_min: 60 },
      { kind: "sample", metric: "hrv_rmssd", ...win, value: 45, unit: "ms", source_id: S, method: "measured", external_id: "oura:sleep:sl-0001:hrv_rmssd", tz_offset_min: 60 },
      { kind: "sample", metric: "resting_hr", ...win, value: 48, unit: "bpm", source_id: S, method: "vendor_daily", external_id: "oura:sleep:sl-0001:resting_hr", tz_offset_min: 60 },
      { kind: "sample", metric: "respiratory_rate", ...win, value: 14.5, unit: "breaths/min", source_id: S, method: "measured", external_id: "oura:sleep:sl-0001:respiratory_rate", tz_offset_min: 60 },
    ]);
    assertCanonical(out);
  });

  it("naps become non-main sessions without night metrics; deleted periods are dropped", () => {
    expect(norm("sleep", "sleep", 1)).toEqual([
      { kind: "session", session_kind: "sleep", start: "2026-11-20T14:00:00.000Z", end: "2026-11-20T14:40:00.000Z", source_id: S, external_id: "oura:sleep:sl-0002", tz_offset_min: 60, detail: { deep_min: 0, light_min: 25, rem_min: 5, awake_min: 10, in_bed_min: 40 }, is_main: false },
    ]);
    expect(norm("sleep", "sleep", 2)).toEqual([]);
  });

  it("heartrate (UTC timestamps) takes the user's offset from the raw record", () => {
    const out = norm("heartrate", "heartrate", 0, 60);
    expect(out).toEqual([{ kind: "sample", metric: "heart_rate", start: "2026-11-20T06:00:00.000Z", end: "2026-11-20T06:00:00.000Z", value: 52, unit: "bpm", source_id: S, method: "measured", external_id: "oura:heartrate:2026-11-20T06:00:00.000Z", tz_offset_min: 60 }]);
  });

  it("daily_spo2 maps the average and skips nulls; breathing disturbance index is not mapped", () => {
    expect(norm("daily_spo2", "daily_spo2", 0, 60)).toEqual([{ kind: "sample", metric: "spo2", ...DAY, value: 96.4, unit: "percent", source_id: S, method: "vendor_daily", external_id: "oura:daily_spo2:sp-0001", tz_offset_min: 60 }]);
    expect(norm("daily_spo2", "daily_spo2", 1, 60)).toEqual([]);
  });

  it("workout -> workout session with mapped type", () => {
    expect(norm("workout", "workout")).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-20T16:30:00.000Z", end: "2026-11-20T17:05:00.000Z", source_id: S, external_id: "oura:workout:wo-0001", tz_offset_min: 60, detail: { type: "run", energy_kcal: 412.5, distance_m: 6020 } },
    ]);
  });

  it("vO2_max -> vo2max in ml/kg/min", () => {
    expect(norm("vO2_max", "vo2_max")).toEqual([{ kind: "sample", metric: "vo2max", ...DAY, value: 47, unit: "ml/kg/min", source_id: S, method: "vendor_daily", external_id: "oura:vo2_max:vo-0001", tz_offset_min: 60 }]);
  });

  it("is idempotent: normalizing the same document twice yields identical ids", () => {
    expect(norm("sleep", "sleep", 0)).toEqual(norm("sleep", "sleep", 0));
  });
});

describe("oura tokens", () => {
  it("refresh is single-use: posts the old refresh token once and returns a new pair", async () => {
    const { fetch, calls } = fakeFetch({ "POST https://api.ouraring.com/oauth/token": json(fixture("oura", "token_refresh")) });
    const c = make(fetch);
    const next = await c.refresh({ access_token: "fake-oura-access-1", refresh_token: "fake-oura-refresh-1", provider_user_id: "fake-oura-user-1" });
    expect(next).toEqual({ access_token: "fake-oura-access-2", refresh_token: "fake-oura-refresh-2", expires_at: "2026-11-25T12:00:00.000Z", provider_user_id: "fake-oura-user-1" });
    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("fake-oura-refresh-1");
    expect(calls[0]!.headers.authorization).toBe(`Basic ${btoa(`test-oura-client:${SECRET}`)}`);
  });

  it("authUrl uses PKCE S256 and the requested scopes", async () => {
    const a = await make().authUrl("u1", "https://example.invalid/cb");
    const u = new URL(a.url);
    expect(u.origin + u.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(a.code_verifier).toBeTruthy();
    expect(u.searchParams.get("scope")).toBe("personal daily heartrate workout spo2");
  });
});

describe("oura webhooks", () => {
  const body = fixtureText("oura", "webhook_event");
  const sign = async (ts: string, b: string, secret = SECRET) => toHex(await hmacSha256(secret, ts + b)).toUpperCase();
  const req = (headers: Record<string, string>, b = body) => new Request("https://example.invalid/hooks/oura", { method: "POST", headers, body: b });

  it("accepts a valid uppercase-hex HMAC-SHA256 over timestamp + body", async () => {
    const ts = "1795161600";
    const jobs = await make().handleWebhook(req({ "x-oura-timestamp": ts, "x-oura-signature": await sign(ts, body) }));
    expect(jobs).toEqual([{ provider: "oura", action: "fetch", provider_user_id: "fake-oura-user-1", data_type: "sleep", object_id: "sl-0001", dedupe_key: "oura:sleep:sl-0001:update:2026-11-20T08:00:00+00:00" }]);
  });

  it("rejects a wrong secret, a tampered body and a missing signature", async () => {
    const ts = "1795161600";
    await expect(make().handleWebhook(req({ "x-oura-timestamp": ts, "x-oura-signature": await sign(ts, body, "wrong") }))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(make().handleWebhook(req({ "x-oura-timestamp": ts, "x-oura-signature": await sign(ts, body) }, body.replace("sl-0001", "sl-9999")))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(make().handleWebhook(req({ "x-oura-timestamp": ts }))).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("answers the verification challenge only with the right token", async () => {
    const c = make(undefined, { webhookVerificationToken: "test-verify" });
    const ok = await c.challenge!(new Request("https://example.invalid/hooks/oura?verification_token=test-verify&challenge=abc123"));
    expect(await ok!.json()).toEqual({ challenge: "abc123" });
    const bad = await c.challenge!(new Request("https://example.invalid/hooks/oura?verification_token=nope&challenge=abc123"));
    expect(bad!.status).toBe(403);
  });

  it("renews only subscriptions expiring within the window", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.ouraring.com/v2/webhook/subscription": json(fixture("oura", "subscriptions")),
      "PUT https://api.ouraring.com/v2/webhook/subscription/renew/": (r) => json({ ...fixture("oura", "subscriptions")[0], expiration_time: "2027-01-23T00:00:00+00:00", id: r.url.split("/").pop() }),
    });
    const renewed = await make(fetch).renewExpiringSubscriptions();
    expect(renewed.map((s) => s.id)).toEqual(["sub-aaaa"]);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual(["https://api.ouraring.com/v2/webhook/subscription/renew/sub-aaaa"]);
    expect(calls[0]!.headers["x-client-id"]).toBe("test-oura-client");
  });
});

describe("oura backfill", () => {
  const routes = (prefix: string) => {
    const r: Record<string, Response> = {};
    const files: Record<string, string> = { vO2_max: "vo2_max" };
    for (const t of OURA_DAILY_TYPES) r[`GET https://api.ouraring.com${prefix}/${t}?`] = json(fixture("oura", files[t] ?? t));
    r[`GET https://api.ouraring.com${prefix}/heartrate?`] = json(fixture("oura", "heartrate"));
    return r;
  };

  it("reads every collection with a bearer token and User-Agent, and normalizes cleanly", async () => {
    const { fetch, calls } = fakeFetch(routes("/v2/usercollection"));
    const c = make(fetch);
    const raws = [];
    for await (const r of c.backfill("u1", "2026-11-20")) raws.push(r);
    expect(raws.map((r) => r.type)).toEqual(["daily_activity", "daily_readiness", "daily_sleep", "sleep", "sleep", "sleep", "daily_spo2", "daily_spo2", "workout", "vO2_max", "heartrate", "heartrate"]);
    expect(calls.every((x) => x.headers.authorization === "Bearer fake-oura-access-1" && x.headers["user-agent"])).toBe(true);
    expect(calls[0]!.url).toContain("start_date=2026-11-20");
    assertCanonical(raws.flatMap((r) => c.normalize(r)));
  });

  it("sandbox mode reads the same routes under /v2/sandbox/usercollection", async () => {
    const { fetch, calls } = fakeFetch(routes("/v2/sandbox/usercollection"));
    const c = make(fetch, { sandbox: true });
    for await (const _ of c.backfill("u1", "2026-11-20"));
    expect(calls.every((x) => x.url.startsWith("https://api.ouraring.com/v2/sandbox/usercollection/"))).toBe(true);
  });

  it("backs off on 429 honouring Retry-After, then succeeds", async () => {
    const r = routes("/v2/usercollection");
    const { fetch, calls } = fakeFetch({ ...r, "GET https://api.ouraring.com/v2/usercollection/daily_activity?": [json({}, 429, { "retry-after": "3" }), json(fixture("oura", "daily_activity"))] });
    const s = noSleep();
    const c = make(fetch, { sleep: s.sleep });
    for await (const _ of c.backfill("u1", "2026-11-20"));
    expect(s.waits).toEqual([3000]);
    expect(calls.filter((x) => x.url.includes("/daily_activity?"))).toHaveLength(2);
    expect(NOW.toISOString()).toBe("2026-11-24T12:00:00.000Z");
  });
});
