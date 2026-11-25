import { describe, expect, it } from "vitest";
import { StravaConnector } from "../src/providers/strava.js";
import { ConnectorRegistry } from "../src/registry.js";
import { ProviderDisabled, WebhookAuthError } from "../src/connector.js";
import { clock, fakeFetch, fixture, fixtureText, json, noSleep, rawOf } from "./helpers.js";

const S = "strava:u1";
const base = { clientId: "test-strava-client", clientSecret: "test-strava-secret", clock, getTokens: async () => ({ access_token: "fake-strava-access-1" }) };
const approved = (extra: Record<string, unknown> = {}) => new StravaConnector({ ...base, writtenApproval: "TEST-ONLY", verifyToken: "test-verify", subscriptionId: 120475, webhookToken: "test-path-token", ...extra });

describe("strava ships disabled", () => {
  it("carries no_ai, no_intermediary and display_to_user_only", () => {
    expect(new StravaConnector(base).capabilities.termsFlags).toEqual({ no_ai: true, no_intermediary: true, display_to_user_only: true });
    expect(new ConnectorRegistry().termsFlags("strava")).toEqual({ no_ai: true, no_intermediary: true, display_to_user_only: true });
  });

  it("the registry keeps it off and refuses to turn it on without written approval", () => {
    const r = new ConnectorRegistry();
    expect(r.isEnabled("strava")).toBe(false);
    expect(() => r.get("strava")).toThrow(ProviderDisabled);
    expect(() => new ConnectorRegistry({ strava: { enabled: true } })).toThrow("requires_written_approval");
  });

  it("without approval it fetches nothing: authUrl, backfill and webhooks refuse", async () => {
    const c = new StravaConnector(base);
    await expect(c.authUrl("u1", "https://example.invalid/cb")).rejects.toBeInstanceOf(ProviderDisabled);
    await expect(c.backfill("u1", "2026-11-01")[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ProviderDisabled);
    await expect(c.handleWebhook(new Request("https://example.invalid/hooks/strava/x", { method: "POST", body: "{}" }))).rejects.toBeInstanceOf(ProviderDisabled);
  });
});

describe("strava normalize (contract only)", () => {
  it("activity -> workout session; offset from utc_offset seconds or start_date_local", () => {
    const c = new StravaConnector(base);
    const [run, ride] = fixture("strava", "activities");
    expect(c.normalize(rawOf("strava", "activity", run))).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-20T12:15:00.000Z", end: "2026-11-20T13:00:30.000Z", source_id: S, external_id: "strava:activity:900000000001", tz_offset_min: -300, detail: { type: "run", distance_m: 8046.7, avg_hr: 152.3 } },
    ]);
    expect(c.normalize(rawOf("strava", "activity", ride))).toEqual([
      { kind: "session", session_kind: "workout", start: "2026-11-21T14:00:00.000Z", end: "2026-11-21T15:00:00.000Z", source_id: S, external_id: "strava:activity:900000000002", tz_offset_min: 60, detail: { type: "cycle", distance_m: 25000 } },
    ]);
  });
});

describe("strava with written approval", () => {
  const req = (body: string, path = "test-path-token") => new Request(`https://example.invalid/hooks/strava/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("webhooks: no signature exists, so the secret path and subscription_id are checked", async () => {
    const c = approved();
    expect(await c.handleWebhook(req(fixtureText("strava", "webhook_activity")))).toEqual([
      { provider: "strava", provider_user_id: "4242", data_type: "activity", dedupe_key: "strava:activity:900000000001:create:1795180000", action: "fetch", object_id: "900000000001" },
    ]);
    expect((await c.handleWebhook(req(fixtureText("strava", "webhook_deauth"))))[0]!.action).toBe("deregister");
    await expect(c.handleWebhook(req(fixtureText("strava", "webhook_activity"), "guess"))).rejects.toBeInstanceOf(WebhookAuthError);
    await expect(c.handleWebhook(req(fixtureText("strava", "webhook_activity").replace("120475", "999")))).rejects.toThrow("strava_subscription");
  });

  it("answers hub.challenge only with the verify token", async () => {
    const c = approved();
    const ok = await c.challenge!(new Request("https://example.invalid/hooks/strava/test-path-token?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=test-verify"));
    expect(await ok!.json()).toEqual({ "hub.challenge": "abc" });
    expect((await c.challenge!(new Request("https://example.invalid/hooks/strava/x?hub.challenge=abc&hub.verify_token=no")))!.status).toBe(403);
  });

  it("refresh rotates the refresh token", async () => {
    const { fetch, calls } = fakeFetch({ "POST https://www.strava.com/oauth/token": json(fixture("strava", "token_refresh")) });
    const t = await approved({ fetch }).refresh({ access_token: "a", refresh_token: "fake-strava-refresh-1" });
    expect(t).toEqual({ access_token: "fake-strava-access-2", refresh_token: "fake-strava-refresh-2", expires_at: "2026-11-24T18:00:00.000Z" });
    expect(new URLSearchParams(calls[0]!.body).get("refresh_token")).toBe("fake-strava-refresh-1");
  });

  it("backfill pages until empty and backs off on 429", async () => {
    const { fetch, calls } = fakeFetch({
      "GET https://www.strava.com/api/v3/athlete/activities?": (r) =>
        new URL(r.url).searchParams.get("page") === "1" ? (calls.length === 1 ? json({}, 429, { "retry-after": "4" }) : json(fixture("strava", "activities"))) : json([]),
    });
    const s = noSleep();
    const raws = [];
    for await (const r of approved({ fetch, sleep: s.sleep }).backfill("u1", "2026-11-01")) raws.push(r);
    expect(raws).toHaveLength(2);
    expect(s.waits).toEqual([4000]);
  });
});
