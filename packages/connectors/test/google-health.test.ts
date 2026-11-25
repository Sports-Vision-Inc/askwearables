import { describe, expect, it } from "vitest";
import { GoogleHealthConnector, GOOGLE_HEALTH, GOOGLE_HEALTH_TYPES, durationToMinutes } from "../src/providers/google-health.js";
import { WebhookAuthError } from "../src/connector.js";
import { fromBase64, p1363ToDer, toBase64 } from "../src/webhook.js";
import { assertCanonical, clock, fakeFetch, fixture, fixtureText, json, noSleep, rawOf } from "./helpers.js";

const HUID = "123456789012345678";
const U = `users/${HUID}/dataTypes`;
const SECRET = "Bearer test-google-webhook-secret";
const S = "google-health:u1";
const make = (extra: Record<string, unknown> = {}) =>
  new GoogleHealthConnector({ clientId: "test-google-client", clientSecret: "test-google-secret", clock, webhookSecret: SECRET, getTokens: async () => ({ access_token: "fake-google-access-1", provider_user_id: HUID }), ...extra });
const file = (t: string) => t.replace(/-/g, "_");
const norm = (type: string, tz = -480) => make().normalize(rawOf("google-health", type, fixture("google-health", file(type)).dataPoints[0], { tz_offset_min: tz }));
const DAY = { start: "2026-11-20T08:00:00.000Z", end: "2026-11-21T08:00:00.000Z" };
const daily = (metric: string, value: number, unit: string, id: string, type: string) => ({
  kind: "sample", metric, ...DAY, value, unit, source_id: S, method: "vendor_daily", external_id: `google-health:${U}/${type}/dataPoints/${id}`, tz_offset_min: -480,
});

describe("google health normalize (reconciled stream)", () => {
  it("parses Duration offsets", () => {
    expect(durationToMinutes("-28800s")).toBe(-480);
    expect(durationToMinutes("19800s")).toBe(330);
    expect(durationToMinutes(undefined)).toBeUndefined();
  });

  it("steps, active energy, heart rate and weight keep their own offsets; string int64s become numbers", () => {
    expect(norm("steps")).toEqual([{ kind: "sample", metric: "steps", start: "2026-11-20T15:05:00.000Z", end: "2026-11-20T15:06:00.000Z", value: 42, unit: "count", source_id: S, method: "measured", external_id: `google-health:${U}/steps/dataPoints/fake-steps-1`, tz_offset_min: -480 }]);
    expect(norm("active-energy-burned")).toEqual([{ kind: "sample", metric: "active_energy", start: "2026-11-20T15:05:00.000Z", end: "2026-11-20T15:06:00.000Z", value: 3.2, unit: "kcal", source_id: S, method: "measured", external_id: `google-health:${U}/active-energy-burned/dataPoints/fake-ae-1`, tz_offset_min: -480 }]);
    expect(norm("heart-rate", 0)).toEqual([{ kind: "sample", metric: "heart_rate", start: "2026-11-20T15:05:10.000Z", end: "2026-11-20T15:05:10.000Z", value: 64, unit: "bpm", source_id: S, method: "measured", external_id: `google-health:${U}/heart-rate/dataPoints/fake-hr-1`, tz_offset_min: -480 }]);
    expect(norm("weight")).toEqual([{ kind: "sample", metric: "weight", start: "2026-11-20T14:30:00.000Z", end: "2026-11-20T14:30:00.000Z", value: 72400, unit: "g", source_id: S, method: "measured", external_id: `google-health:${U}/weight/dataPoints/fake-weight-1`, tz_offset_min: -480 }]);
  });

  it("daily types span the local day at the user's offset", () => {
    expect(norm("daily-resting-heart-rate")).toEqual([daily("resting_hr", 58, "bpm", "fake-rhr-1", "daily-resting-heart-rate")]);
    expect(norm("daily-heart-rate-variability")).toEqual([daily("hrv_rmssd", 38.5, "ms", "fake-hrv-1", "daily-heart-rate-variability")]);
    expect(norm("daily-oxygen-saturation")).toEqual([daily("spo2", 95.2, "percent", "fake-spo2-1", "daily-oxygen-saturation")]);
    expect(norm("daily-respiratory-rate")).toEqual([daily("respiratory_rate", 14.8, "breaths/min", "fake-rr-1", "daily-respiratory-rate")]);
    expect(norm("daily-vo2-max")).toEqual([daily("vo2max", 44.1, "ml/kg/min", "fake-vo2-1", "daily-vo2-max")]);
  });

  it("skin temperature becomes a deviation from the personal baseline", () => {
    expect(norm("daily-sleep-temperature-derivations")).toEqual([daily("skin_temp_deviation", -0.28, "degC", "fake-temp-1", "daily-sleep-temperature-derivations")]);
  });

  it("sleep -> session with stage minutes from stagesSummary", () => {
    expect(norm("sleep")).toEqual([
      { kind: "session", session_kind: "sleep", start: "2026-11-20T06:30:00.000Z", end: "2026-11-20T14:10:00.000Z", source_id: S, external_id: `google-health:${U}/sleep/dataPoints/fake-sleep-1`, tz_offset_min: -480, detail: { deep_min: 70, light_min: 230, rem_min: 110, awake_min: 50, in_bed_min: 460 }, is_main: true },
    ]);
  });

  it("exercise -> workout session", () => {
    expect(norm("exercise")).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-20T16:00:00.000Z", end: "2026-11-20T16:40:00.000Z", source_id: S, external_id: `google-health:${U}/exercise/dataPoints/fake-ex-1`, tz_offset_min: -480, detail: { type: "run", title: "Morning run" } },
    ]);
  });
});

describe("google health tokens and identity", () => {
  it("exchangeCode stores healthUserId from /users/me/identity", async () => {
    const { fetch, calls } = fakeFetch({
      "POST https://oauth2.googleapis.com/token": json(fixture("google-health", "token_exchange")),
      "GET https://health.googleapis.com/v4/users/me/identity": json(fixture("google-health", "identity")),
    });
    const t = await make({ fetch }).exchangeCode("fake-code", { redirectUri: "https://example.invalid/cb" });
    expect(t).toMatchObject({ access_token: "fake-google-access-1", refresh_token: "fake-google-refresh-1", provider_user_id: HUID });
    expect(calls[1]!.headers.authorization).toBe("Bearer fake-google-access-1");
  });

  it("refresh keeps the existing refresh token when Google does not return one", async () => {
    const { fetch } = fakeFetch({ "POST https://oauth2.googleapis.com/token": json(fixture("google-health", "token_refresh")) });
    const t = await make({ fetch }).refresh({ access_token: "old", refresh_token: "fake-google-refresh-1", provider_user_id: HUID });
    expect(t).toEqual({ access_token: "fake-google-access-2", refresh_token: "fake-google-refresh-1", expires_at: "2026-11-24T12:59:59.000Z", scope: "https://www.googleapis.com/auth/googlehealth.sleep.readonly", provider_user_id: HUID });
  });

  it("authUrl asks for offline access and the Restricted read scopes", async () => {
    const u = new URL((await make().authUrl("u1", "https://example.invalid/cb")).url);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("scope")).toBe(GOOGLE_HEALTH.scopes.join(" "));
  });
});

describe("google health backfill", () => {
  const routes = () => {
    const r: Record<string, ReturnType<typeof json>> = {};
    for (const t of Object.keys(GOOGLE_HEALTH_TYPES)) r[`GET https://health.googleapis.com/v4/users/${HUID}/dataTypes/${t}/dataPoints:reconcile?`] = json(fixture("google-health", file(t)));
    return r;
  };

  it("reads only the reconciled stream, by healthUserId, with a time filter", async () => {
    const { fetch, calls } = fakeFetch(routes());
    const c = make({ fetch });
    const raws = [];
    for await (const r of c.backfill("u1", "2026-11-20")) raws.push(r);
    expect(raws).toHaveLength(Object.keys(GOOGLE_HEALTH_TYPES).length);
    expect(calls.every((x) => x.url.includes(":reconcile?"))).toBe(true);
    expect(new URL(calls[0]!.url).searchParams.get("filter")).toBe('steps.interval.start_time >= "2026-11-20T00:00:00.000Z" AND steps.interval.start_time < "2026-11-25T12:00:00.000Z"');
    expect(new URL(calls.find((x) => x.url.includes("daily-resting"))!.url).searchParams.get("filter")).toBe('daily_resting_heart_rate.date >= "2026-11-20" AND daily_resting_heart_rate.date < "2026-11-25"');
    assertCanonical(raws.flatMap((r) => c.normalize(r)));
  });

  it("honours an HTTP-date Retry-After on 429", async () => {
    const r = routes();
    const k = `GET https://health.googleapis.com/v4/users/${HUID}/dataTypes/steps/dataPoints:reconcile?`;
    const { fetch } = fakeFetch({ ...r, [k]: [json({ error: { status: "RESOURCE_EXHAUSTED" } }, 429, { "retry-after": "Tue, 24 Nov 2026 12:00:05 GMT" }), json(fixture("google-health", "steps"))] });
    const s = noSleep();
    for await (const _ of make({ fetch, sleep: s.sleep }).backfill("u1", "2026-11-20"));
    expect(s.waits).toEqual([5000]);
  });
});

describe("google health webhooks", () => {
  const KEY_ID = 0x1a2b3c4d;
  async function setup() {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const x = fromBase64(jwk.x!);
    const y = fromBase64(jwk.y!);
    // Tink EcdsaPublicKey proto: version=0, params{hash=SHA256, curve=P256, encoding=DER}, x, y (with a leading 0x00 like Tink).
    const params = [0x08, 0x03, 0x10, 0x03, 0x18, 0x02];
    const proto = Uint8Array.of(0x08, 0x00, 0x12, params.length, ...params, 0x1a, 33, 0x00, ...x, 0x22, 33, 0x00, ...y);
    const keyset = { primaryKeyId: KEY_ID, key: [{ keyData: { typeUrl: "type.googleapis.com/google.crypto.tink.EcdsaPublicKey", value: toBase64(proto), keyMaterialType: "ASYMMETRIC_PUBLIC" }, status: "ENABLED", keyId: KEY_ID, outputPrefixType: "TINK" }] };
    const sign = async (body: string, keyId = KEY_ID) => {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(body)));
      return toBase64(Uint8Array.of(0x01, (keyId >>> 24) & 255, (keyId >>> 16) & 255, (keyId >>> 8) & 255, keyId & 255, ...p1363ToDer(raw)));
    };
    const ff = fakeFetch({ [`GET ${GOOGLE_HEALTH.keyset}`]: json(keyset) });
    return { sign, ...ff, c: make({ fetch: ff.fetch }) };
  }
  const body = fixtureText("google-health", "webhook_steps");
  const req = (h: Record<string, string>, b = body) => new Request("https://example.invalid/hooks/google-health", { method: "POST", headers: h, body: b });

  it("accepts a valid secret + Tink ECDSA signature and turns intervals into fetch/delete jobs", async () => {
    const { c, sign } = await setup();
    const jobs = await c.handleWebhook(req({ authorization: SECRET, "google-health-api-signature": await sign(body) }));
    expect(jobs).toEqual([
      { provider: "google-health", action: "fetch", provider_user_id: HUID, data_type: "steps", window: { start: "2026-11-20T15:00:00Z", end: "2026-11-20T15:05:00Z" }, dedupe_key: `google-health:${HUID}:steps:UPSERT:2026-11-20T15:00:00Z:2026-11-20T15:05:00Z:` },
      { provider: "google-health", action: "delete", provider_user_id: HUID, data_type: "sleep", object_id: "fake-sleep-0", window: { start: "2026-11-18T23:00:00.000Z", end: "2026-11-21T06:00:00.000Z" }, dedupe_key: `google-health:${HUID}:sleep:DELETE:2026-11-18T23:00:00.000Z:2026-11-21T06:00:00.000Z:fake-sleep-0` },
    ]);
  });

  it("rejects a missing secret, a tampered body, and an unknown key id (after one keyset refetch)", async () => {
    const { c, sign, calls } = await setup();
    await expect(c.handleWebhook(req({ "google-health-api-signature": await sign(body) }))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(c.handleWebhook(req({ authorization: SECRET, "google-health-api-signature": await sign(body) }, body.replace("UPSERT", "DELETE")))).rejects.toThrow("google_health_signature");
    const before = calls.length;
    await expect(c.handleWebhook(req({ authorization: SECRET, "google-health-api-signature": await sign(body, 7) }))).rejects.toThrow("google_health_signature");
    expect(calls.length).toBe(before + 1);
  });

  it("answers endpoint verification: 200 with the secret, 401 without", async () => {
    const c = make();
    const v = JSON.stringify({ type: "verification" });
    expect((await c.challenge!(req({ authorization: SECRET }, v)))!.status).toBe(200);
    expect((await c.challenge!(req({}, v)))!.status).toBe(401);
    expect(await c.challenge!(req({ authorization: SECRET }))).toBeNull();
  });
});
