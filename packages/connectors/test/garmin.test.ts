import { describe, expect, it } from "vitest";
import { GarminConnector } from "../src/providers/garmin.js";
import { ProviderDisabled, WebhookAuthError, type SyncJob } from "../src/connector.js";
import { assertCanonical, assertScoresApart, clock, fakeFetch, fixture, json, noSleep, NOW, rawOf } from "./helpers.js";

const TOKEN = "test-garmin-path-token";
const U = "fake-garmin-user-1";
const S = "garmin:u1";
const make = (extra: Record<string, unknown> = {}, tier?: string) =>
  new GarminConnector({ clientId: "test-garmin-client", clientSecret: "test-garmin-secret", webhookToken: TOKEN, clock, getTokens: async () => ({ access_token: "fake-garmin-access-1", provider_user_id: U }), ...extra }, tier);
const post = (body: unknown, url = `https://example.invalid/hooks/garmin?token=${TOKEN}`) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ingest = (c: GarminConnector, jobs: SyncJob[]) => jobs.flatMap((j) => c.normalize(rawOf("garmin", j.data_type, j.payload)));

describe("garmin push -> ingest -> normalize", () => {
  it("dailies: steps, active energy, resting HR and HR samples at the summary's offset; stress kept apart", async () => {
    const c = make();
    const jobs = await c.handleWebhook(post(fixture("garmin", "push_dailies")));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ provider: "garmin", action: "ingest", provider_user_id: U, data_type: "dailies", object_id: "x-fake-daily-1" });
    expect(JSON.stringify(jobs[0]!.payload)).not.toContain("userAccessToken");
    const out = ingest(c, jobs);
    const day = { start: "2026-11-19T23:00:00.000Z", end: "2026-11-20T23:00:00.000Z" };
    const ext = "garmin:dailies:x-fake-daily-1";
    expect(out).toEqual([
      { kind: "sample", metric: "steps", ...day, value: 9120, unit: "count", source_id: S, method: "vendor_daily", external_id: `${ext}:steps`, tz_offset_min: 60 },
      { kind: "sample", metric: "active_energy", ...day, value: 455, unit: "kcal", source_id: S, method: "vendor_daily", external_id: `${ext}:active_energy`, tz_offset_min: 60 },
      { kind: "sample", metric: "resting_hr", ...day, value: 51, unit: "bpm", source_id: S, method: "vendor_daily", external_id: `${ext}:resting_hr`, tz_offset_min: 60 },
      { kind: "sample", metric: "heart_rate", start: "2026-11-19T23:00:00.000Z", end: "2026-11-19T23:00:00.000Z", value: 58, unit: "bpm", source_id: S, method: "measured", external_id: `${ext}:hr:0`, tz_offset_min: 60 },
      { kind: "sample", metric: "heart_rate", start: "2026-11-19T23:00:15.000Z", end: "2026-11-19T23:00:15.000Z", value: 57, unit: "bpm", source_id: S, method: "measured", external_id: `${ext}:hr:15`, tz_offset_min: 60 },
      { kind: "vendor_score", provider: "garmin", name: "stress", value: 32, day: "2026-11-20", source_id: S, external_id: `${ext}:stress` },
    ]);
    assertCanonical(out);
    assertScoresApart(out, ["stress"]);
  });

  it("sleeps: stage minutes summed from sleepLevelsMap", async () => {
    const c = make();
    expect(ingest(c, await c.handleWebhook(post(fixture("garmin", "push_sleeps"))))).toEqual([
      { kind: "session", session_kind: "sleep", start: "2026-11-19T22:20:00.000Z", end: "2026-11-20T05:50:00.000Z", source_id: S, external_id: "garmin:sleeps:x-fake-sleep-1", tz_offset_min: 60, detail: { deep_min: 90, light_min: 230, rem_min: 100, awake_min: 30, in_bed_min: 450 } },
    ]);
  });

  it("activities, pulse ox and body composition", async () => {
    const c = make();
    expect(ingest(c, await c.handleWebhook(post(fixture("garmin", "push_activities"))))).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-20T16:30:00.000Z", end: "2026-11-20T17:15:00.000Z", source_id: S, external_id: "garmin:activities:x-fake-activity-1", tz_offset_min: 60, detail: { type: "run", avg_hr: 151, distance_m: 7830.5, energy_kcal: 512, title: "Evening Run" } },
    ]);
    expect(ingest(c, await c.handleWebhook(post(fixture("garmin", "push_pulseox"))))).toEqual([
      { kind: "sample", metric: "spo2", start: "2026-11-20T01:00:00.000Z", end: "2026-11-20T01:00:00.000Z", value: 96, unit: "percent", source_id: S, method: "measured", external_id: "garmin:pulseox:x-fake-pulseox-1:0", tz_offset_min: 60 },
      { kind: "sample", metric: "spo2", start: "2026-11-20T01:01:00.000Z", end: "2026-11-20T01:01:00.000Z", value: 95, unit: "percent", source_id: S, method: "measured", external_id: "garmin:pulseox:x-fake-pulseox-1:60", tz_offset_min: 60 },
    ]);
    expect(ingest(c, await c.handleWebhook(post(fixture("garmin", "push_bodycomps"))))).toEqual([
      { kind: "sample", metric: "weight", start: "2026-11-20T06:45:00.000Z", end: "2026-11-20T06:45:00.000Z", value: 72350, unit: "g", source_id: S, method: "measured", external_id: "garmin:bodyComps:x-fake-body-1:weight", tz_offset_min: 60 },
    ]);
  });

  it("is idempotent: a redelivered push (e.g. from backfill) collapses; an updated summary gets a new job but the same record ids", async () => {
    const c = make();
    const a = await c.handleWebhook(post(fixture("garmin", "push_dailies")));
    const b = await c.handleWebhook(post(fixture("garmin", "push_dailies")));
    expect(b.map((j) => j.dedupe_key)).toEqual(a.map((j) => j.dedupe_key));
    const updated = fixture("garmin", "push_dailies");
    updated.dailies[0].steps = 9500;
    const u = await c.handleWebhook(post(updated));
    expect(u[0]!.dedupe_key).not.toBe(a[0]!.dedupe_key);
    expect(ingest(c, u).map((r) => r.external_id)).toEqual(ingest(c, a).map((r) => r.external_id));
  });
});

describe("garmin webhook authenticity", () => {
  it("rejects requests without the secret URL token (Garmin sends no signature)", async () => {
    await expect(make().handleWebhook(post(fixture("garmin", "push_dailies"), "https://example.invalid/hooks/garmin?token=wrong"))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(make().handleWebhook(post(fixture("garmin", "push_dailies"), "https://example.invalid/hooks/garmin"))).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("accepts the token as the last path segment too", async () => {
    expect(await make().handleWebhook(post(fixture("garmin", "deregistration"), `https://example.invalid/hooks/garmin/${TOKEN}`))).toEqual([
      { provider: "garmin", action: "deregister", provider_user_id: U, data_type: "deregistrations", dedupe_key: `garmin:deregistration:${U}` },
    ]);
  });

  it("ping -> fetch_url job; a callbackURL off apis.garmin.com is rejected", async () => {
    const jobs = await make().handleWebhook(post(fixture("garmin", "ping_sleeps")));
    expect(jobs).toEqual([
      { provider: "garmin", action: "fetch_url", provider_user_id: U, data_type: "sleeps", url: fixture("garmin", "ping_sleeps").sleeps[0].callbackURL, dedupe_key: `garmin:ping:sleeps:${U}:1795158000:1795161600` },
    ]);
    await expect(make().handleWebhook(post(fixture("garmin", "ping_forged")))).rejects.toThrow("garmin_callback_host");
    await expect(make().fetchCallback("u1", "sleeps", fixture("garmin", "ping_forged").sleeps[0].callbackURL)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("fetchCallback pulls an allowed callback URL with the user's token", async () => {
    const url = fixture("garmin", "ping_sleeps").sleeps[0].callbackURL;
    const { fetch, calls } = fakeFetch({ "GET https://apis.garmin.com/wellness-api/rest/sleeps": json(fixture("garmin", "push_sleeps").sleeps) });
    const raws = await make({ fetch }).fetchCallback("u1", "sleeps", url);
    expect(raws).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer fake-garmin-access-1");
  });
});

describe("garmin backfill and tokens", () => {
  it("is refused on the Starter tier", async () => {
    const it = make().backfill("u1", "2026-11-01")[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(ProviderDisabled);
  });

  it("Enterprise: requests async backfill per type and window, clamped to the history limit, yielding nothing", async () => {
    const { fetch, calls } = fakeFetch({ "GET https://apis.garmin.com/wellness-api/rest/backfill/": new Response(null, { status: 202 }) });
    const c = make({ fetch, backfillChunkDays: 30 }, "enterprise");
    const yielded = [];
    for await (const r of c.backfill("u1", "2026-01-01")) yielded.push(r);
    expect(yielded).toEqual([]);
    expect(calls.map((x) => x.url.split("?")[0]!.split("/").pop())).toEqual(["dailies", "sleeps", "activities", "pulseox", "bodyComps"]);
    const q = new URL(calls[0]!.url).searchParams;
    expect(Number(q.get("summaryStartTimeInSeconds"))).toBe(Math.floor((NOW.getTime() - 30 * 86_400_000) / 1000));
    expect(Number(q.get("summaryEndTimeInSeconds"))).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it("backs off on 429 during backfill requests", async () => {
    const { fetch } = fakeFetch({ "GET https://apis.garmin.com/wellness-api/rest/backfill/": [new Response(null, { status: 429, headers: { "retry-after": "2" } }), new Response(null, { status: 202 })] });
    const s = noSleep();
    for await (const _ of make({ fetch, sleep: s.sleep, backfillChunkDays: 30 }, "enterprise").backfill("u1", "2026-11-20"));
    expect(s.waits).toEqual([2000]);
  });

  it("refresh rotates both tokens and records the refresh-token expiry", async () => {
    const { fetch, calls } = fakeFetch({ "POST https://connectapi.garmin.com/di-oauth2-service/oauth/token": json(fixture("garmin", "token_refresh")) });
    const t = await make({ fetch }).refresh({ access_token: "a1", refresh_token: "fake-garmin-refresh-1", provider_user_id: U });
    expect(t).toEqual({ access_token: "fake-garmin-access-2", refresh_token: "fake-garmin-refresh-2", expires_at: "2026-11-25T12:00:00.000Z", refresh_expires_at: "2027-02-22T11:59:58.000Z", scope: "PARTNER_WRITE PARTNER_READ CONNECT_READ CONNECT_WRITE", provider_user_id: U });
    expect(new URLSearchParams(calls[0]!.body).get("grant_type")).toBe("refresh_token");
  });

  it("exchangeCode requires the PKCE verifier", async () => {
    await expect(make().exchangeCode("code")).rejects.toThrow("garmin_requires_pkce_verifier");
  });
});
