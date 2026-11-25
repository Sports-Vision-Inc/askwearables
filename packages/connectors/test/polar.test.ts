import { describe, expect, it } from "vitest";
import { PolarConnector, isoDurationSeconds } from "../src/providers/polar.js";
import { ReauthRequired, WebhookAuthError } from "../src/connector.js";
import { hmacSha256, toHex } from "../src/webhook.js";
import { assertCanonical, assertScoresApart, clock, fakeFetch, fixture, fixtureText, json, noSleep, rawOf } from "./helpers.js";

const WH = "test-polar-signature-secret";
const UID = "10101010";
const S = "polar:u1";
const make = (extra: Record<string, unknown> = {}) =>
  new PolarConnector({ clientId: "test-polar-client", clientSecret: "test-polar-secret", webhookSecret: WH, clock, getTokens: async () => ({ access_token: "fake-polar-access-1", provider_user_id: UID }), ...extra });
const API = "https://www.polaraccesslink.com/v3";

describe("polar normalize", () => {
  it("parses ISO 8601 durations", () => {
    expect(isoDurationSeconds("PT1H2M30S")).toBe(3750);
    expect(isoDurationSeconds("PT45M")).toBe(2700);
    expect(isoDurationSeconds("PT12.5S")).toBe(12.5);
  });

  it("exercise: local start_time + start_time_utc_offset (minutes) -> UTC session", () => {
    expect(make().normalize(rawOf("polar", "exercise", fixture("polar", "exercises")[0]))).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-20T17:10:00.000Z", end: "2026-11-20T18:12:30.000Z", source_id: S, external_id: "polar:exercise:fake-ex-1", tz_offset_min: 60, detail: { type: "run", energy_kcal: 640, distance_m: 10500, avg_hr: 146 } },
    ]);
  });

  it("daily activity -> steps and active calories over the local day", () => {
    const day = { start: "2026-11-19T23:00:00.000Z", end: "2026-11-20T23:00:00.000Z" };
    expect(make().normalize(rawOf("polar", "activity", fixture("polar", "activities")[0], { tz_offset_min: 60 }))).toEqual([
      { kind: "sample", metric: "steps", ...day, value: 11203, unit: "count", source_id: S, method: "vendor_daily", external_id: "polar:activity:2026-11-20:steps", tz_offset_min: 60 },
      { kind: "sample", metric: "active_energy", ...day, value: 610, unit: "kcal", source_id: S, method: "vendor_daily", external_id: "polar:activity:2026-11-20:active_energy", tz_offset_min: 60 },
    ]);
  });

  it("sleep -> session with stages; sleep score is a vendor score", () => {
    const out = make().normalize(rawOf("polar", "sleep", fixture("polar", "sleep").nights[0]));
    expect(out).toEqual([
      { kind: "session", session_kind: "sleep", start: "2026-11-19T22:05:00.000Z", end: "2026-11-20T05:50:00.000Z", source_id: S, external_id: "polar:sleep:2026-11-20", tz_offset_min: 60, detail: { deep_min: 85, light_min: 240, rem_min: 95, awake_min: 45, in_bed_min: 465 }, is_main: true },
      { kind: "vendor_score", provider: "polar", name: "sleep_score", value: 82, day: "2026-11-20", source_id: S, external_id: "polar:sleep:2026-11-20:score" },
    ]);
  });

  it("nightly recharge -> HRV and breathing rate; recharge status and ANS charge stay vendor scores", () => {
    const out = make().normalize(rawOf("polar", "nightly_recharge", fixture("polar", "nightly_recharge").recharges[0], { tz_offset_min: 60 }));
    const day = { start: "2026-11-19T23:00:00.000Z", end: "2026-11-20T23:00:00.000Z" };
    expect(out).toEqual([
      { kind: "sample", metric: "hrv_rmssd", ...day, value: 48, unit: "ms", source_id: S, method: "vendor_daily", external_id: "polar:nightly_recharge:2026-11-20:hrv", tz_offset_min: 60 },
      { kind: "sample", metric: "respiratory_rate", ...day, value: 14.2, unit: "breaths/min", source_id: S, method: "vendor_daily", external_id: "polar:nightly_recharge:2026-11-20:breathing", tz_offset_min: 60 },
      { kind: "vendor_score", provider: "polar", name: "nightly_recharge", value: 4, day: "2026-11-20", source_id: S, external_id: "polar:nightly_recharge:2026-11-20:status" },
      { kind: "vendor_score", provider: "polar", name: "ans_charge", value: 3.6, day: "2026-11-20", source_id: S, external_id: "polar:nightly_recharge:2026-11-20:ans_charge" },
    ]);
    assertScoresApart(out, ["nightly_recharge", "ans_charge"]);
  });
});

describe("polar tokens", () => {
  it("exchangeCode uses Basic auth, keeps x_user_id and registers the user (409 = already registered)", async () => {
    const { fetch, calls } = fakeFetch({ "POST https://polarremote.com/v2/oauth2/token": json(fixture("polar", "token")), [`POST ${API}/users`]: json({}, 409) });
    const t = await make({ fetch }).exchangeCode("fake-code", { redirectUri: "https://example.invalid/cb", memberId: "opaque-member-1" });
    expect(t).toEqual({ access_token: "fake-polar-access-1", expires_at: "2027-11-24T11:59:59.000Z", provider_user_id: UID });
    expect(calls[0]!.headers.authorization).toBe(`Basic ${btoa("test-polar-client:test-polar-secret")}`);
    expect(JSON.parse(calls[1]!.body)).toEqual({ "member-id": "opaque-member-1" });
  });

  it("has no refresh grant: refresh demands re-authorization", async () => {
    await expect(make().refresh({ access_token: "x" })).rejects.toBeInstanceOf(ReauthRequired);
  });
});

describe("polar transactions commit only after a durable write", () => {
  const routes = () => ({
    [`POST ${API}/users/${UID}/exercise-transactions`]: json(fixture("polar", "transaction_create"), 201),
    [`GET ${API}/users/${UID}/exercise-transactions/424242/exercises/1`]: json(fixture("polar", "exercises")[0]),
    [`GET ${API}/users/${UID}/exercise-transactions/424242`]: json(fixture("polar", "transaction_list")),
    [`PUT ${API}/users/${UID}/exercise-transactions/424242`]: new Response(null, { status: 200 }),
  });

  it("writes first, then commits", async () => {
    const { fetch, calls } = fakeFetch(routes());
    const order: string[] = [];
    const n = await make({ fetch }).pullTransaction("u1", "exercise", async (recs) => {
      order.push(`write:${recs.length}`);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });
    order.push("done");
    expect(n).toBe(1);
    expect(order).toEqual(["write:1", "done"]);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "PUT"]);
  });

  it("never commits when the durable write fails, so Polar keeps the data", async () => {
    const { fetch, calls } = fakeFetch(routes());
    await expect(make({ fetch }).pullTransaction("u1", "exercise", async () => { throw new Error("d1_down"); })).rejects.toThrow("d1_down");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("returns 0 when no transaction is available (204)", async () => {
    const { fetch } = fakeFetch({ [`POST ${API}/users/${UID}/exercise-transactions`]: new Response(null, { status: 204 }) });
    expect(await make({ fetch }).pullTransaction("u1", "exercise", async () => { throw new Error("should not be called"); })).toBe(0);
  });
});

describe("polar webhooks", () => {
  const sign = async (b: string, k = WH) => toHex(await hmacSha256(k, b));
  const req = (b: string, sig: string | null) => new Request("https://example.invalid/hooks/polar", { method: "POST", headers: { "polar-webhook-event": "EXERCISE", ...(sig ? { "polar-webhook-signature": sig } : {}) }, body: b });

  it("accepts a valid hex HMAC-SHA256 of the raw body", async () => {
    const b = fixtureText("polar", "webhook_exercise");
    expect(await make().handleWebhook(req(b, await sign(b)))).toEqual([
      { provider: "polar", action: "fetch_url", provider_user_id: UID, data_type: "EXERCISE", url: `${API}/exercises/fake-ex-1`, object_id: "fake-ex-1", dedupe_key: "polar:EXERCISE:10101010:fake-ex-1:2026-11-20T18:20:00.000Z" },
    ]);
    const s = fixtureText("polar", "webhook_sleep");
    expect((await make().handleWebhook(req(s, await sign(s))))[0]).toMatchObject({ data_type: "SLEEP", object_id: "2026-11-20" });
  });

  it("acknowledges PING with no jobs", async () => {
    const b = fixtureText("polar", "webhook_ping");
    expect(await make().handleWebhook(req(b, await sign(b)))).toEqual([]);
  });

  it("rejects a wrong key, a tampered body, a missing header and off-host URLs", async () => {
    const b = fixtureText("polar", "webhook_exercise");
    await expect(make().handleWebhook(req(b, await sign(b, "wrong")))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(make().handleWebhook(req(b.replace("fake-ex-1", "fake-ex-2"), await sign(b)))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(make().handleWebhook(req(b, null))).rejects.toBeInstanceOf(WebhookAuthError);
    const evil = b.replace("https://www.polaraccesslink.com", "https://attacker.example.invalid");
    await expect(make().handleWebhook(req(evil, await sign(evil)))).rejects.toThrow("polar_url_host");
  });
});

describe("polar backfill", () => {
  const routes = () => ({
    [`GET ${API}/exercises`]: json(fixture("polar", "exercises")),
    [`GET ${API}/users/activities?`]: json(fixture("polar", "activities")),
    [`GET ${API}/users/sleep`]: json(fixture("polar", "sleep")),
    [`GET ${API}/users/nightly-recharge`]: json(fixture("polar", "nightly_recharge")),
  });

  it("clamps daily activity to 365 days in 28-day ranges", async () => {
    const { fetch, calls } = fakeFetch({ ...routes(), [`GET ${API}/users/activities?`]: (r) => json(new URL(r.url).searchParams.get("to") === "2026-11-24" ? fixture("polar", "activities") : []) });
    const c = make({ fetch, tzOffsetFor: () => 60 });
    const raws = [];
    for await (const r of c.backfill("u1", "2024-01-01")) raws.push(r);
    const acts = calls.filter((x) => x.url.includes("/users/activities?")).map((x) => Object.fromEntries(new URL(x.url).searchParams));
    expect(acts[0]).toEqual({ from: "2025-11-25", to: "2025-12-22" });
    expect(acts.at(-1)!.to).toBe("2026-11-24");
    expect(acts).toHaveLength(14);
    expect(raws.every((r) => r.tz_offset_min === 60)).toBe(true);
    assertCanonical(raws.flatMap((r) => c.normalize(r)));
  });

  it("backs off on 429", async () => {
    const { fetch } = fakeFetch({ ...routes(), [`GET ${API}/exercises`]: [json({}, 429, { "retry-after": "1" }), json(fixture("polar", "exercises"))] });
    const s = noSleep();
    for await (const _ of make({ fetch, sleep: s.sleep }).backfill("u1", "2026-11-20"));
    expect(s.waits).toEqual([1000]);
  });
});
