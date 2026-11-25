// Polar AccessLink API v3. Docs read 2026-11-24: docs/providers/polar.md (polar.com/accesslink-api, API agreement 2025-08-22).
//
// - OAuth2, scope accesslink.read_all. No refresh grant: tokens last about a year or until revoked; a 401 means re-authorize.
// - The user must be registered (POST /v3/users) before any data is visible; 409 means already registered.
// - Non-transactional endpoints (exercises, activities, sleep, nightly recharge) are current. Transactional endpoints are
//   deprecated (2025-08-18 / 2026-01-13) and DISCARD data on commit, so pullTransaction commits only after the caller's
//   durable-write callback resolves.
// - Webhooks: Polar-Webhook-Signature, HMAC-SHA256 of the raw body with the signature_secret_key from webhook creation.
//   TODO(verify): the docs show a 64-hex-char example but do not name the algorithm or input; check against a live PING.
// - Terms: credit "Polar Ecosystem" wherever data is displayed. AI use is not addressed; TODO(verify) with Polar.
import { mapWorkoutType, type CanonicalRecord, type SleepStagesDetail } from "@askwearables/core";
import { capabilitiesFor } from "../capabilities.js";
import { ReauthRequired, WebhookAuthError, type AuthStart, type Capabilities, type Connector, type ConnectorOptions, type ExchangeContext, type RawRecord, type SyncJob, type Tokens } from "../connector.js";
import { basicAuth, fetchWithBackoff, formBody, getJson, HttpError, randomToken, tokensFromResponse, type OAuthTokenResponse } from "../http.js";
import { verifyHmacSha256 } from "../webhook.js";
import { BaseConnector, localDayWindow, localToUtc, num, offsetFromIso, round, sample, session, vendorScore } from "../base.js";

export const POLAR = {
  authorize: "https://flow.polar.com/oauth2/authorization",
  token: "https://polarremote.com/v2/oauth2/token",
  api: "https://www.polaraccesslink.com/v3",
  scope: "accesslink.read_all",
  /** Per-endpoint history limits from the docs. */
  limits: { exercisesDays: 30, activityDays: 365, activityRangeDays: 28, sleepDays: 28 },
} as const;

export interface PolarOptions extends ConnectorOptions {
  /** signature_secret_key returned once by POST /v3/webhooks. */
  webhookSecret?: string;
}

export type PolarTransactionKind = "exercise" | "activity" | "physical-information";

/** ISO 8601 duration ("PT1H2M3.5S") -> seconds. */
export function isoDurationSeconds(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d);
  if (!m) throw new Error(`bad_duration:${d}`);
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

const LIST_KEYS: Record<PolarTransactionKind, string> = { exercise: "exercises", activity: "activity-log", "physical-information": "physical-informations" };

export class PolarConnector extends BaseConnector implements Connector {
  readonly provider = "polar" as const;
  readonly capabilities: Capabilities;

  constructor(
    protected override readonly opts: PolarOptions,
    tier?: string,
  ) {
    super(opts);
    this.capabilities = capabilitiesFor("polar", tier);
  }

  async authUrl(_userId: string, redirectUri: string): Promise<AuthStart> {
    const state = randomToken();
    const q = new URLSearchParams({ response_type: "code", client_id: this.opts.clientId, redirect_uri: redirectUri, scope: POLAR.scope, state });
    return { url: `${POLAR.authorize}?${q}`, state };
  }

  /** Exchange, then register the user (required before data is visible). `memberId` should be an opaque id, never an email. */
  async exchangeCode(code: string, ctx: ExchangeContext & { memberId?: string } = {}): Promise<Tokens> {
    const res = await fetchWithBackoff(this.http, POLAR.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(this.opts.clientId, this.opts.clientSecret), accept: "application/json" },
      body: formBody({ grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri }),
    });
    if (!res.ok) throw new HttpError(res.status, POLAR.token, await res.text());
    const body = (await res.json()) as OAuthTokenResponse & { x_user_id?: number };
    const t: Tokens = tokensFromResponse(body, this.clock());
    if (body.x_user_id !== undefined) t.provider_user_id = String(body.x_user_id);
    const reg = await fetchWithBackoff(this.http, `${POLAR.api}/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ "member-id": ctx.memberId ?? randomToken(12) }),
    });
    if (!reg.ok && reg.status !== 409) throw new HttpError(reg.status, `${POLAR.api}/users`, await reg.text());
    return t;
  }

  /** Polar documents no refresh grant. */
  async refresh(_tokens: Tokens): Promise<Tokens> {
    throw new ReauthRequired("polar", "no_refresh_grant");
  }

  private auth(t: Tokens) {
    return { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/json" } };
  }

  async *backfill(userId: string, since: string): AsyncIterable<RawRecord> {
    const t = await this.tokensFor(userId);
    const now = this.clock();
    const today = now.toISOString().slice(0, 10);
    const exercises = await getJson<unknown[]>(this.http, `${POLAR.api}/exercises`, this.auth(t)); // last 30 days only
    for (const e of exercises ?? []) yield this.raw(userId, "exercise", e);

    const floor = new Date(now.getTime() - (POLAR.limits.activityDays - 1) * 86_400_000).toISOString().slice(0, 10);
    let from = since > floor ? since : floor;
    while (from <= today) {
      const toMs = Math.min(Date.parse(`${from}T00:00:00Z`) + (POLAR.limits.activityRangeDays - 1) * 86_400_000, Date.parse(`${today}T00:00:00Z`));
      const to = new Date(toMs).toISOString().slice(0, 10);
      const days = await getJson<unknown[]>(this.http, `${POLAR.api}/users/activities?${new URLSearchParams({ from, to })}`, this.auth(t));
      for (const d of days ?? []) yield this.raw(userId, "activity", d);
      from = new Date(toMs + 86_400_000).toISOString().slice(0, 10);
    }

    const sleep = await getJson<{ nights?: unknown[] }>(this.http, `${POLAR.api}/users/sleep`, this.auth(t)); // last 28 days
    for (const n of sleep?.nights ?? []) yield this.raw(userId, "sleep", n);
    const nr = await getJson<{ recharges?: unknown[] }>(this.http, `${POLAR.api}/users/nightly-recharge`, this.auth(t));
    for (const r of nr?.recharges ?? []) yield this.raw(userId, "nightly_recharge", r);
  }

  /**
   * Deprecated transactional pull. Polar deletes the data on commit, so the commit (PUT) is sent only after
   * `onDurableWrite` resolves. If it throws, the transaction is left open and Polar keeps the data for a retry.
   * Returns the number of documents committed (0 when nothing was available).
   */
  async pullTransaction(userId: string, kind: PolarTransactionKind, onDurableWrite: (records: RawRecord[]) => Promise<void>): Promise<number> {
    const t = await this.tokensFor(userId);
    if (!t.provider_user_id) throw new Error("polar_no_user_id");
    const base = `${POLAR.api}/users/${encodeURIComponent(t.provider_user_id)}/${kind}-transactions`;
    const res = await fetchWithBackoff(this.http, base, { method: "POST", ...this.auth(t) });
    if (res.status === 204) return 0;
    if (!res.ok) throw new HttpError(res.status, base, await res.text());
    const tx = (await res.json()) as { "transaction-id": number; "resource-uri": string };
    const list = await getJson<Record<string, string[]>>(this.http, tx["resource-uri"], this.auth(t));
    const records: RawRecord[] = [];
    for (const url of list?.[LIST_KEYS[kind]] ?? []) records.push(this.raw(userId, kind, await getJson(this.http, url, this.auth(t))));
    await onDurableWrite(records); // throws -> no commit
    const commitUrl = `${base}/${tx["transaction-id"]}`;
    const c = await fetchWithBackoff(this.http, commitUrl, { method: "PUT", ...this.auth(t) });
    if (!c.ok) throw new HttpError(c.status, commitUrl, await c.text());
    return records.length;
  }

  async handleWebhook(request: Request): Promise<SyncJob[]> {
    const body = await request.text();
    if (!this.opts.webhookSecret) throw new WebhookAuthError("polar_no_secret");
    const ok = await verifyHmacSha256({ secret: this.opts.webhookSecret, message: body, signature: request.headers.get("polar-webhook-signature"), encoding: "hex" });
    if (!ok) throw new WebhookAuthError("polar_signature");
    const e = JSON.parse(body) as { event: string; user_id?: number; entity_id?: string; date?: string; timestamp: string; url?: string };
    if (e.event === "PING") return [];
    if (e.url && !/^https:\/\/www\.polaraccesslink\.com\/v3\//.test(e.url)) throw new WebhookAuthError("polar_url_host");
    const job: SyncJob = {
      provider: "polar",
      action: e.url ? "fetch_url" : "fetch",
      provider_user_id: String(e.user_id ?? ""),
      data_type: e.event,
      dedupe_key: `polar:${e.event}:${e.user_id}:${e.entity_id ?? e.date ?? ""}:${e.timestamp}`,
    };
    if (e.url) job.url = e.url;
    if (e.entity_id) job.object_id = e.entity_id;
    else if (e.date) job.object_id = e.date;
    return [job];
  }

  normalize(raw: RawRecord): CanonicalRecord[] {
    const d = raw.payload as Record<string, any>;
    const src = raw.source_id;
    const tz0 = raw.tz_offset_min ?? 0;
    const out: CanonicalRecord[] = [];
    switch (raw.type) {
      case "exercise": {
        const tz = num(d.start_time_utc_offset) ?? tz0;
        const start = localToUtc(d.start_time, tz);
        const end = new Date(Date.parse(start) + isoDurationSeconds(d.duration) * 1000).toISOString();
        const detail: Record<string, unknown> = { type: mapWorkoutType(d.detailed_sport_info ?? d.sport) };
        if (num(d.calories) !== undefined) detail.energy_kcal = num(d.calories);
        if (num(d.distance) !== undefined) detail.distance_m = num(d.distance);
        if (num(d.heart_rate?.average) !== undefined) detail.avg_hr = num(d.heart_rate.average);
        out.push(session("workout", start, end, tz, src, `polar:exercise:${d.id}`, detail as { type: string }));
        break;
      }
      case "activity": {
        // TODO(verify): start_time/end_time appear to be local wall time without an offset; use the user's offset.
        const day = String(d.start_time).slice(0, 10);
        const w = localDayWindow(day, tz0);
        if (num(d.steps) !== undefined) out.push(sample("steps", num(d.steps)!, "count", w.start, w.end, tz0, src, `polar:activity:${day}:steps`, "vendor_daily"));
        if (num(d.active_calories) !== undefined) out.push(sample("active_energy", num(d.active_calories)!, "kcal", w.start, w.end, tz0, src, `polar:activity:${day}:active_energy`, "vendor_daily"));
        break;
      }
      case "sleep": {
        const tz = offsetFromIso(d.sleep_start_time);
        const m = (v: unknown) => (num(v) === undefined ? undefined : round(num(v)! / 60));
        const detail: SleepStagesDetail = {};
        const stages = { deep_min: m(d.deep_sleep), light_min: m(d.light_sleep), rem_min: m(d.rem_sleep), awake_min: m(d.total_interruption_duration) };
        for (const [k, v] of Object.entries(stages)) if (v !== undefined) (detail as Record<string, number>)[k] = v;
        detail.in_bed_min = round((Date.parse(d.sleep_end_time) - Date.parse(d.sleep_start_time)) / 60_000);
        out.push(session("sleep", d.sleep_start_time, d.sleep_end_time, tz, src, `polar:sleep:${d.date}`, detail, true));
        if (num(d.sleep_score) !== undefined) out.push(vendorScore("polar", "sleep_score", num(d.sleep_score)!, d.date, src, `polar:sleep:${d.date}:score`));
        break;
      }
      case "nightly_recharge": {
        const w = localDayWindow(d.date, tz0);
        // TODO(verify): heart_rate_variability_avg is assumed to be RMSSD in ms (Polar's Nightly Recharge uses RMSSD).
        if (num(d.heart_rate_variability_avg) !== undefined) out.push(sample("hrv_rmssd", num(d.heart_rate_variability_avg)!, "ms", w.start, w.end, tz0, src, `polar:nightly_recharge:${d.date}:hrv`, "vendor_daily"));
        if (num(d.breathing_rate_avg) !== undefined) out.push(sample("respiratory_rate", num(d.breathing_rate_avg)!, "breaths/min", w.start, w.end, tz0, src, `polar:nightly_recharge:${d.date}:breathing`, "vendor_daily"));
        if (num(d.nightly_recharge_status) !== undefined) out.push(vendorScore("polar", "nightly_recharge", num(d.nightly_recharge_status)!, d.date, src, `polar:nightly_recharge:${d.date}:status`));
        if (num(d.ans_charge) !== undefined) out.push(vendorScore("polar", "ans_charge", num(d.ans_charge)!, d.date, src, `polar:nightly_recharge:${d.date}:ans_charge`));
        break;
      }
    }
    return out;
  }
}
