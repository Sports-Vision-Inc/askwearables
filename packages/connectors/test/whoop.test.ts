import { describe, expect, it } from "vitest";
import { WhoopConnector } from "../src/providers/whoop.js";
import { WebhookAuthError } from "../src/connector.js";
import { serializeRefresh } from "../src/refresh.js";
import { hmacSha256, toBase64 } from "../src/webhook.js";
import { assertCanonical, assertScoresApart, clock, fakeFetch, fixture, fixtureText, json, noSleep, NOW, rawOf } from "./helpers.js";

const SECRET = "test-whoop-client-secret";
const make = (extra: Record<string, unknown> = {}) =>
  new WhoopConnector({ clientId: "test-whoop-client", clientSecret: SECRET, clock, getTokens: async () => ({ access_token: "fake-whoop-access-1" }), ...extra });
const S = "whoop:u1";
const rec = (file: string, i = 0) => fixture("whoop", file).records[i];
const SLEEP_WIN = { start: "2026-11-20T04:15:00.000Z", end: "2026-11-20T12:05:00.000Z" };

describe("whoop normalize", () => {
  it("sleep -> session (milli -> minutes, offset from timezone_offset) and night metrics; performance is a vendor score", () => {
    const out = make().normalize(rawOf("whoop", "sleep", rec("sleep")));
    const ext = "whoop:sleep:00000000-0000-4000-8000-000000000001";
    expect(out).toEqual([
      { kind: "session", session_kind: "sleep", ...SLEEP_WIN, source_id: S, external_id: ext, tz_offset_min: -300, detail: { deep_min: 95, light_min: 230, rem_min: 105, awake_min: 40, in_bed_min: 470 }, is_main: true },
      { kind: "sample", metric: "sleep_efficiency", ...SLEEP_WIN, value: 91.48936, unit: "percent", source_id: S, method: "vendor_daily", external_id: `${ext}:sleep_efficiency`, tz_offset_min: -300 },
      { kind: "sample", metric: "respiratory_rate", ...SLEEP_WIN, value: 15.2, unit: "breaths/min", source_id: S, method: "measured", external_id: `${ext}:respiratory_rate`, tz_offset_min: -300 },
      { kind: "vendor_score", provider: "whoop", name: "sleep_performance", value: 92, day: "2026-11-20", source_id: S, external_id: `${ext}:sleep_performance` },
    ]);
    assertCanonical(out);
  });

  it("an unscored nap is a non-main session with no metrics", () => {
    expect(make().normalize(rawOf("whoop", "sleep", rec("sleep", 1)))).toEqual([
      { kind: "session", session_kind: "sleep", start: "2026-11-20T19:30:00.000Z", end: "2026-11-20T20:05:00.000Z", source_id: S, external_id: "whoop:sleep:00000000-0000-4000-8000-000000000002", tz_offset_min: -300, detail: {}, is_main: false },
    ]);
  });

  it("recovery uses its sleep for time and offset; recovery score stays a vendor score; skin temp (absolute) is not mapped", () => {
    const out = make().normalize(rawOf("whoop", "recovery", rec("recovery"), { context: { sleep: rec("sleep") } }));
    const key = "whoop:recovery:00000000-0000-4000-8000-000000000001";
    expect(out).toEqual([
      { kind: "vendor_score", provider: "whoop", name: "recovery", value: 66, day: "2026-11-20", source_id: S, external_id: key },
      { kind: "sample", metric: "resting_hr", ...SLEEP_WIN, value: 52, unit: "bpm", source_id: S, method: "vendor_daily", external_id: `${key}:resting_hr`, tz_offset_min: -300 },
      { kind: "sample", metric: "hrv_rmssd", ...SLEEP_WIN, value: 61.237, unit: "ms", source_id: S, method: "measured", external_id: `${key}:hrv_rmssd`, tz_offset_min: -300 },
      { kind: "sample", metric: "spo2", ...SLEEP_WIN, value: 95.6875, unit: "percent", source_id: S, method: "measured", external_id: `${key}:spo2`, tz_offset_min: -300 },
    ]);
    assertScoresApart(out, ["recovery"]);
    expect(out.some((r) => r.kind === "sample" && r.metric === "skin_temp_deviation")).toBe(false);
  });

  it("recovery without its sleep falls back to created_at and the user's offset", () => {
    const out = make().normalize(rawOf("whoop", "recovery", rec("recovery"), { tz_offset_min: -300 }));
    expect(out[0]).toEqual({ kind: "vendor_score", provider: "whoop", name: "recovery", value: 66, day: "2026-11-20", source_id: S, external_id: "whoop:recovery:00000000-0000-4000-8000-000000000001" });
    expect(out[1]).toMatchObject({ start: "2026-11-20T12:30:00.000Z", end: "2026-11-20T12:30:00.000Z", tz_offset_min: -300 });
  });

  it("cycle -> strain vendor score on the local day of the cycle midpoint, and nothing else", () => {
    expect(make().normalize(rawOf("whoop", "cycle", rec("cycle")))).toEqual([
      { kind: "vendor_score", provider: "whoop", name: "strain", value: 12.4, day: "2026-11-20", source_id: S, external_id: "whoop:cycle:93845:strain" },
    ]);
  });

  it("workout -> session with kJ converted to kcal", () => {
    expect(make().normalize(rawOf("whoop", "workout", rec("workout")))).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-20T22:00:00.000Z", end: "2026-11-20T22:45:00.000Z", source_id: S, external_id: "whoop:workout:00000000-0000-4000-8000-000000000010", tz_offset_min: -300, detail: { type: "run", avg_hr: 148, distance_m: 7012.5, energy_kcal: 400 } },
    ]);
  });

  it("body measurement -> weight with a stable per-user id", () => {
    expect(make().normalize(rawOf("whoop", "body_measurement", fixture("whoop", "body_measurement")))).toEqual([
      { kind: "sample", metric: "weight", start: NOW.toISOString(), end: NOW.toISOString(), value: 72.5, unit: "kg", source_id: S, method: "manual", external_id: "whoop:body_measurement:weight", tz_offset_min: 0 },
    ]);
  });
});

describe("whoop tokens", () => {
  it("refresh sends scope=offline and returns the rotated pair", async () => {
    const { fetch, calls } = fakeFetch({ "POST https://api.prod.whoop.com/oauth/oauth2/token": json(fixture("whoop", "token_refresh")) });
    const t = await make({ fetch }).refresh({ access_token: "fake-whoop-access-1", refresh_token: "fake-whoop-refresh-1" });
    expect(t.access_token).toBe("fake-whoop-access-2");
    expect(t.refresh_token).toBe("fake-whoop-refresh-2");
    expect(t.expires_at).toBe("2026-11-24T13:00:00.000Z");
    const b = new URLSearchParams(calls[0]!.body);
    expect([b.get("grant_type"), b.get("refresh_token"), b.get("scope")]).toEqual(["refresh_token", "fake-whoop-refresh-1", "offline"]);
  });

  it("concurrent refreshes for one user are serialized into one request (old access token dies on refresh)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch, calls } = fakeFetch({ "POST https://api.prod.whoop.com/oauth/oauth2/token": async () => (await gate, json(fixture("whoop", "token_refresh"))) });
    const persisted: string[] = [];
    const refresh = serializeRefresh(make({ fetch }), async (k, t) => void persisted.push(`${k}:${t.refresh_token}`));
    const old = { access_token: "fake-whoop-access-1", refresh_token: "fake-whoop-refresh-1" };
    const a = refresh("whoop:u1", old);
    const b = refresh("whoop:u1", old);
    release();
    const [ta, tb] = await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
    expect(ta).toBe(tb);
    expect(persisted).toEqual(["whoop:u1:fake-whoop-refresh-2"]);
  });

  it("authUrl requests the six scopes plus offline and an 8-character state", async () => {
    const a = await make().authUrl("u1", "https://example.invalid/cb");
    const u = new URL(a.url);
    expect(u.searchParams.get("scope")).toBe("read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement offline");
    expect(a.state).toHaveLength(8);
  });
});

describe("whoop webhooks", () => {
  const body = fixtureText("whoop", "webhook_recovery");
  const sign = async (ts: string, b: string, secret = SECRET) => toBase64(await hmacSha256(secret, ts + b));
  const req = (h: Record<string, string>, b = body) => new Request("https://example.invalid/hooks/whoop", { method: "POST", headers: h, body: b });

  it("accepts a valid signature; a recovery event's id is the sleep UUID", async () => {
    const ts = String(NOW.getTime());
    const jobs = await make().handleWebhook(req({ "x-whoop-signature-timestamp": ts, "x-whoop-signature": await sign(ts, body) }));
    expect(jobs).toEqual([{ provider: "whoop", action: "fetch", provider_user_id: "10129", data_type: "recovery", object_id: "00000000-0000-4000-8000-000000000001", dedupe_key: "whoop:recovery.updated:00000000-0000-4000-8000-000000000001:fake-trace-0001" }]);
  });

  it("rejects bad signatures, tampered bodies and stale timestamps", async () => {
    const ts = String(NOW.getTime());
    await expect(make().handleWebhook(req({ "x-whoop-signature-timestamp": ts, "x-whoop-signature": await sign(ts, body, "wrong") }))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(make().handleWebhook(req({ "x-whoop-signature-timestamp": ts, "x-whoop-signature": await sign(ts, body) }, body.replace("10129", "10130")))).rejects.toBeInstanceOf(WebhookAuthError);
    const old = String(NOW.getTime() - 60 * 60_000);
    await expect(make().handleWebhook(req({ "x-whoop-signature-timestamp": old, "x-whoop-signature": await sign(old, body) }))).rejects.toThrow("whoop_timestamp");
  });

  it("fetchRecoveryForSleep goes sleep -> cycle_id -> cycle recovery", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://api.prod.whoop.com/developer/v2/activity/sleep/": json(rec("sleep")),
      "GET https://api.prod.whoop.com/developer/v2/cycle/93845/recovery": json(rec("recovery")),
    });
    const c = make({ fetch });
    const raw = await c.fetchRecoveryForSleep("u1", "00000000-0000-4000-8000-000000000001");
    expect(calls.map((x) => x.url)).toEqual([
      "https://api.prod.whoop.com/developer/v2/activity/sleep/00000000-0000-4000-8000-000000000001",
      "https://api.prod.whoop.com/developer/v2/cycle/93845/recovery",
    ]);
    expect(c.normalize(raw)[1]).toMatchObject({ metric: "resting_hr", ...SLEEP_WIN, tz_offset_min: -300 });
  });
});

describe("whoop backfill", () => {
  const routes = {
    "GET https://api.prod.whoop.com/developer/v2/activity/sleep?": json(fixture("whoop", "sleep")),
    "GET https://api.prod.whoop.com/developer/v2/recovery?": json(fixture("whoop", "recovery")),
    "GET https://api.prod.whoop.com/developer/v2/cycle?": json(fixture("whoop", "cycle")),
    "GET https://api.prod.whoop.com/developer/v2/activity/workout?": json(fixture("whoop", "workout")),
    "GET https://api.prod.whoop.com/developer/v2/user/measurement/body": json(fixture("whoop", "body_measurement")),
  };

  it("pages every collection (limit 25) and attaches each recovery's sleep", async () => {
    const { fetch, calls } = fakeFetch(routes);
    const c = make({ fetch });
    const raws = [];
    for await (const r of c.backfill("u1", "2026-11-20")) raws.push(r);
    expect(raws.map((r) => r.type)).toEqual(["sleep", "sleep", "recovery", "cycle", "workout", "body_measurement"]);
    expect(raws[2]!.context?.sleep).toEqual(rec("sleep"));
    expect(calls[0]!.url).toContain("limit=25");
    assertCanonical(raws.flatMap((r) => c.normalize(r)));
  });

  it("backs off exponentially on 429 without Retry-After", async () => {
    const { fetch } = fakeFetch({ ...routes, "GET https://api.prod.whoop.com/developer/v2/activity/sleep?": [json({}, 429), json({}, 429), json(fixture("whoop", "sleep"))] });
    const s = noSleep();
    for await (const _ of make({ fetch, sleep: s.sleep }).backfill("u1", "2026-11-20"));
    expect(s.waits).toEqual([1000, 2000]);
  });
});
