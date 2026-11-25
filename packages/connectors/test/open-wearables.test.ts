import { describe, expect, it } from "vitest";
import { OpenWearablesConnector } from "../src/providers/open-wearables.js";
import { WebhookAuthError } from "../src/connector.js";
import { hmacSha256, toBase64 } from "../src/webhook.js";
import { assertCanonical, clock, fakeFetch, fixture, fixtureText, json, noSleep, NOW, rawOf } from "./helpers.js";

const BASE = "http://ow.example.invalid";
const OWU = "00000000-0000-4000-8000-0000000000aa";
const KEY = new Uint8Array(24).map((_, i) => i + 1);
const WHSEC = `whsec_${toBase64(KEY)}`;
const make = (extra: Record<string, unknown> = {}) =>
  new OpenWearablesConnector({ clientId: "unused", clientSecret: "sk-00000000000000000000000000000000", baseUrl: BASE, webhookSecret: WHSEC, clock, getTokens: async () => ({ access_token: "api-key", provider_user_id: OWU }), ...extra });
const ts = (file: string, i: number) => rawOf("open-wearables", "timeseries", fixture("open-wearables", file).data[i]);

describe("open wearables normalize", () => {
  it("keeps each upstream source apart and converts unit spellings", () => {
    const c = make();
    expect(c.normalize(ts("timeseries_page1", 0))).toEqual([
      { kind: "sample", metric: "heart_rate", start: "2026-11-20T07:00:00.000Z", end: "2026-11-20T07:00:00.000Z", value: 62, unit: "bpm", source_id: "open-wearables:u1/garmin/fr265", method: "measured", external_id: "open-wearables:heart_rate:garmin:fr265:2026-11-20T07:00:00.000Z", tz_offset_min: 60 },
    ]);
    expect(c.normalize(ts("timeseries_page1", 1))).toEqual([
      { kind: "sample", metric: "respiratory_rate", start: "2026-11-20T03:00:00.000Z", end: "2026-11-20T03:00:00.000Z", value: 14.6, unit: "breaths/min", source_id: "open-wearables:u1/oura/ring4", method: "measured", external_id: "open-wearables:respiratory_rate:oura:ring4:2026-11-20T03:00:00.000Z", tz_offset_min: 60 },
    ]);
    expect(c.normalize(ts("timeseries_page2", 0))).toEqual([
      { kind: "sample", metric: "steps", start: "2026-11-19T23:00:00.000Z", end: "2026-11-20T23:00:00.000Z", value: 10432, unit: "count", source_id: "open-wearables:u1/apple/watch9", method: "vendor_daily", external_id: "open-wearables:steps:apple:watch9:2026-11-19T23:00:00.000Z", tz_offset_min: 60 },
    ]);
  });

  it("drops Strava-sourced records (Strava bans AI use and intermediaries) and unknown units", () => {
    const c = make();
    expect(c.normalize(ts("timeseries_page2", 1))).toEqual([]);
    expect(c.normalize(ts("timeseries_page2", 2))).toEqual([]);
    expect(c.normalize(rawOf("open-wearables", "workout", fixture("open-wearables", "workouts").data[1]))).toEqual([]);
  });

  it("workouts and sleep sessions", () => {
    const c = make();
    expect(c.normalize(rawOf("open-wearables", "workout", fixture("open-wearables", "workouts").data[0]))).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-20T16:30:00.000Z", end: "2026-11-20T17:10:00.000Z", source_id: "open-wearables:u1/garmin/fr265", external_id: "open-wearables:workout:00000000-0000-4000-8000-000000000101", tz_offset_min: 60, detail: { type: "run", energy_kcal: 455, distance_m: 6800, avg_hr: 149, title: "Evening Run" } },
    ]);
    const win = { start: "2026-11-19T22:10:00.000Z", end: "2026-11-20T06:00:00.000Z" };
    expect(c.normalize(rawOf("open-wearables", "sleep", fixture("open-wearables", "sleep").data[0]))).toEqual([
      { kind: "session", session_kind: "sleep", ...win, source_id: "open-wearables:u1/oura/ring4", external_id: "open-wearables:sleep:00000000-0000-4000-8000-000000000201", tz_offset_min: 60, detail: { deep_min: 90, light_min: 235, rem_min: 105, awake_min: 40, in_bed_min: 470 }, is_main: true },
      { kind: "sample", metric: "sleep_efficiency", ...win, value: 91.5, unit: "percent", source_id: "open-wearables:u1/oura/ring4", method: "vendor_daily", external_id: "open-wearables:sleep:00000000-0000-4000-8000-000000000201:efficiency", tz_offset_min: 60 },
    ]);
  });
});

describe("open wearables API", () => {
  const routes = () => ({
    [`GET ${BASE}/api/v1/users/${OWU}/timeseries?`]: (r: { url: string }) => json(fixture("open-wearables", new URL(r.url).searchParams.get("cursor") ? "timeseries_page2" : "timeseries_page1")),
    [`GET ${BASE}/api/v1/users/${OWU}/events/workouts?`]: json(fixture("open-wearables", "workouts")),
    [`GET ${BASE}/api/v1/users/${OWU}/events/sleep?`]: json(fixture("open-wearables", "sleep")),
  });

  it("backfill follows cursors, sends the API key header, and normalizes cleanly", async () => {
    const { fetch, calls } = fakeFetch(routes());
    const c = make({ fetch });
    const raws = [];
    for await (const r of c.backfill("u1", "2026-11-20")) raws.push(r);
    expect(raws.map((r) => r.type)).toEqual(["timeseries", "timeseries", "timeseries", "timeseries", "timeseries", "workout", "workout", "sleep"]);
    expect(calls[0]!.headers["x-open-wearables-api-key"]).toBe("sk-00000000000000000000000000000000");
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("ZmFrZS1jdXJzb3ItMQ==");
    expect(new URL(calls[0]!.url).searchParams.getAll("types")).toContain("heart_rate_variability_rmssd");
    assertCanonical(raws.flatMap((r) => c.normalize(r)));
  });

  it("exchangeCode checks the user exists and keeps its UUID", async () => {
    const { fetch } = fakeFetch({ [`GET ${BASE}/api/v1/users/${OWU}`]: json(fixture("open-wearables", "user")) });
    expect(await make({ fetch }).exchangeCode(OWU)).toEqual({ access_token: "api-key", provider_user_id: OWU });
  });

  it("backs off on 429", async () => {
    const r = routes();
    const { fetch } = fakeFetch({ ...r, [`GET ${BASE}/api/v1/users/${OWU}/events/sleep?`]: [json({ code: "RATE_LIMITED" }, 429), json(fixture("open-wearables", "sleep"))] });
    const s = noSleep();
    for await (const _ of make({ fetch, sleep: s.sleep }).backfill("u1", "2026-11-20"));
    expect(s.waits).toEqual([1000]);
  });
});

describe("open wearables webhooks (Svix)", () => {
  const sign = async (id: string, t: string, b: string, key = KEY) => `v1,${toBase64(await hmacSha256(key, `${id}.${t}.${b}`))}`;
  const req = (h: Record<string, string>, b: string) => new Request("https://example.invalid/hooks/ow", { method: "POST", headers: h, body: b });
  const t = String(Math.floor(NOW.getTime() / 1000));

  it("accepts a valid Svix signature (any of several v1 signatures)", async () => {
    const b = fixtureText("open-wearables", "webhook_sleep");
    const jobs = await make().handleWebhook(req({ "svix-id": "msg_fake1", "svix-timestamp": t, "svix-signature": `v1,AAAA ${await sign("msg_fake1", t, b)}` }, b));
    expect(jobs).toEqual([{ provider: "open-wearables", action: "fetch", provider_user_id: OWU, data_type: "sleep", object_id: "00000000-0000-4000-8000-000000000201", dedupe_key: "open-wearables:msg_fake1" }]);
  });

  it("rejects a wrong secret, a tampered body and a stale timestamp", async () => {
    const b = fixtureText("open-wearables", "webhook_sleep");
    await expect(make().handleWebhook(req({ "svix-id": "msg_fake1", "svix-timestamp": t, "svix-signature": await sign("msg_fake1", t, b, new Uint8Array(24)) }, b))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(make().handleWebhook(req({ "svix-id": "msg_fake1", "svix-timestamp": t, "svix-signature": await sign("msg_fake1", t, b) }, b.replace("oura", "ouro")))).rejects.toBeInstanceOf(WebhookAuthError);
    const old = String(Number(t) - 3600);
    await expect(make().handleWebhook(req({ "svix-id": "msg_fake1", "svix-timestamp": old, "svix-signature": await sign("msg_fake1", old, b) }, b))).rejects.toThrow("open_wearables_timestamp");
  });

  it("drops events whose upstream is Strava", async () => {
    const b = fixtureText("open-wearables", "webhook_strava_workout");
    expect(await make().handleWebhook(req({ "svix-id": "msg_fake2", "svix-timestamp": t, "svix-signature": await sign("msg_fake2", t, b) }, b))).toEqual([]);
  });
});
