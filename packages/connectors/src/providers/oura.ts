// Oura API v2. Docs read 2026-11-24: docs/providers/oura.md (OpenAPI 1.43, authentication page, API agreement).
//
// Tokens: OAuth2 only (personal access tokens retired Dec 2025). Refresh tokens are SINGLE-USE: a refresh consumes the
// old refresh token and returns a new pair. Callers must write the new access and refresh tokens in one transaction under
// a per-user row lock (or a Durable Object), and must never run two refreshes for one user at once; see serializeRefresh().
//
// Terms: the API agreement (effective 2026-06-08) s.4(d) bans providing Oura data to any AI model except through Oura's
// own MCP server, so this provider carries termsFlags {no_ai, no_intermediary} and ships disabled.
import { mapWorkoutType, type CanonicalRecord } from "@askwearables/core";
import { capabilitiesFor } from "../capabilities.js";
import { WebhookAuthError, type AuthStart, type Capabilities, type Connector, type ConnectorOptions, type ExchangeContext, type RawRecord, type SyncJob, type Tokens } from "../connector.js";
import { basicAuth, fetchWithBackoff, formBody, getJson, HttpError, pkcePair, randomToken, tokensFromResponse, type OAuthTokenResponse } from "../http.js";
import { verifyHmacSha256 } from "../webhook.js";
import { BaseConnector, localDayWindow, num, offsetFromIso, round, sample, session, vendorScore } from "../base.js";

export const OURA = {
  authorize: "https://cloud.ouraring.com/oauth/authorize",
  token: "https://api.ouraring.com/oauth/token",
  api: "https://api.ouraring.com",
  /** Same routes with fake data; any non-empty Authorization works. Shares the real rate limit. */
  sandboxPrefix: "/v2/sandbox/usercollection",
  prefix: "/v2/usercollection",
  defaultScopes: ["personal", "daily", "heartrate", "workout", "spo2"],
  userAgent: "AskWearables-connector/0.1",
} as const;

/** Day-keyed collections fetched by start_date/end_date. */
export const OURA_DAILY_TYPES = ["daily_activity", "daily_readiness", "daily_sleep", "sleep", "daily_spo2", "workout", "vO2_max"] as const;

export interface OuraOptions extends ConnectorOptions {
  /** Use /v2/sandbox/usercollection (fake data). */
  sandbox?: boolean;
  scopes?: string[];
  /** The verification_token sent when creating webhook subscriptions. */
  webhookVerificationToken?: string;
}

export interface OuraSubscription {
  id: string;
  callback_url: string;
  event_type: "create" | "update" | "delete";
  data_type: string;
  expiration_time: string;
}

interface OuraPage<T> {
  data: T[];
  next_token: string | null;
}

export class OuraConnector extends BaseConnector implements Connector {
  readonly provider = "oura" as const;
  readonly capabilities: Capabilities;

  constructor(
    protected override readonly opts: OuraOptions,
    tier?: string,
  ) {
    super(opts);
    this.capabilities = capabilitiesFor("oura", tier ?? (opts.sandbox ? "sandbox" : undefined));
  }

  async authUrl(_userId: string, redirectUri: string): Promise<AuthStart> {
    const state = randomToken();
    const { verifier, challenge } = await pkcePair();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.opts.clientId,
      redirect_uri: redirectUri,
      scope: (this.opts.scopes ?? OURA.defaultScopes).join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { url: `${OURA.authorize}?${q}`, state, code_verifier: verifier };
  }

  async exchangeCode(code: string, ctx: ExchangeContext = {}): Promise<Tokens> {
    const tokens = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri, code_verifier: ctx.codeVerifier });
    try {
      const info = await getJson<{ id?: string }>(this.http, `${OURA.api}/v2/usercollection/personal_info`, { headers: this.headers(tokens.access_token) });
      if (info?.id) tokens.provider_user_id = info.id;
    } catch {
      // personal scope not granted; webhooks still carry user_id, which the host maps on first event.
    }
    return tokens;
  }

  /**
   * Single-use refresh. The returned refresh_token replaces the old one, which is now dead.
   * Persist both tokens atomically before using the new access token.
   */
  async refresh(tokens: Tokens): Promise<Tokens> {
    if (!tokens.refresh_token) throw new Error("oura_no_refresh_token");
    const next = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    if (tokens.provider_user_id) next.provider_user_id = tokens.provider_user_id;
    return next;
  }

  private async tokenRequest(fields: Record<string, string | undefined>): Promise<Tokens> {
    const res = await fetchWithBackoff(this.http, OURA.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(this.opts.clientId, this.opts.clientSecret), "user-agent": OURA.userAgent },
      body: formBody(fields),
    });
    if (!res.ok) throw new HttpError(res.status, OURA.token, await res.text());
    return tokensFromResponse((await res.json()) as OAuthTokenResponse, this.clock());
  }

  private headers(accessToken: string): Record<string, string> {
    // Oura can 403 a request without a User-Agent.
    return { authorization: `Bearer ${accessToken}`, "user-agent": OURA.userAgent };
  }

  private collectionUrl(type: string): string {
    return `${OURA.api}${this.opts.sandbox ? OURA.sandboxPrefix : OURA.prefix}/${type}`;
  }

  private async *pages<T>(url: string, params: Record<string, string>, accessToken: string): AsyncGenerator<T> {
    let next: string | null = null;
    do {
      const q = new URLSearchParams(params);
      if (next) q.set("next_token", next);
      const page: OuraPage<T> = await getJson<OuraPage<T>>(this.http, `${url}?${q}`, { headers: this.headers(accessToken) });
      for (const d of page.data ?? []) yield d;
      next = page.next_token ?? null;
    } while (next);
  }

  async *backfill(userId: string, since: string): AsyncIterable<RawRecord> {
    const { access_token } = await this.tokensFor(userId);
    const today = this.clock().toISOString().slice(0, 10);
    // TODO(verify): the sandbox looked end_date-exclusive; ask for one day past today to be safe.
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    for (const type of OURA_DAILY_TYPES) {
      for await (const doc of this.pages(this.collectionUrl(type), { start_date: since, end_date: end }, access_token)) {
        yield this.raw(userId, type, doc);
      }
    }
    // Heart rate is a datetime-keyed time series; fetch in 30-day windows.
    const stop = this.clock().getTime();
    for (let t = Date.parse(`${since}T00:00:00Z`); t < stop; t += 30 * 86_400_000) {
      const params = { start_datetime: new Date(t).toISOString(), end_datetime: new Date(Math.min(stop, t + 30 * 86_400_000)).toISOString() };
      for await (const s of this.pages(this.collectionUrl("heartrate"), params, access_token)) yield this.raw(userId, "heartrate", s);
    }
  }

  /** Fetch a single document named by a webhook (object_id). */
  async fetchDocument(userId: string, dataType: string, objectId: string): Promise<RawRecord> {
    const { access_token } = await this.tokensFor(userId);
    const path = dataType === "vo2_max" ? "vO2_max" : dataType;
    const doc = await getJson(this.http, `${this.collectionUrl(path)}/${encodeURIComponent(objectId)}`, { headers: this.headers(access_token) });
    return this.raw(userId, path, doc);
  }

  // ---------- webhooks ----------

  /** Endpoint verification: GET ?verification_token=&challenge= -> {"challenge": ...}. */
  async challenge(request: Request): Promise<Response | null> {
    if (request.method !== "GET") return null;
    const u = new URL(request.url);
    const challenge = u.searchParams.get("challenge");
    if (challenge === null) return null;
    const token = u.searchParams.get("verification_token") ?? "";
    if (!this.opts.webhookVerificationToken || token !== this.opts.webhookVerificationToken) return new Response("forbidden", { status: 403 });
    return Response.json({ challenge });
  }

  async handleWebhook(request: Request): Promise<SyncJob[]> {
    const body = await request.text();
    const ts = request.headers.get("x-oura-timestamp") ?? "";
    const sig = request.headers.get("x-oura-signature");
    // Signature = uppercase hex HMAC-SHA256(client_secret, timestamp + body). The docs' example signs
    // JSON.stringify(req.body); TODO(verify) whether Oura signs the raw bytes, so accept either form.
    let ok = await verifyHmacSha256({ secret: this.opts.clientSecret, message: ts + body, signature: sig, encoding: "hex" });
    if (!ok) {
      try {
        ok = await verifyHmacSha256({ secret: this.opts.clientSecret, message: ts + JSON.stringify(JSON.parse(body)), signature: sig, encoding: "hex" });
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new WebhookAuthError("oura_signature");
    const e = JSON.parse(body) as { event_type: string; data_type: string; object_id: string; event_time: string; user_id: string };
    return [
      {
        provider: "oura",
        action: e.event_type === "delete" ? "delete" : "fetch",
        provider_user_id: e.user_id,
        data_type: e.data_type,
        object_id: e.object_id,
        dedupe_key: `oura:${e.data_type}:${e.object_id}:${e.event_type}:${e.event_time}`,
      },
    ];
  }

  private appHeaders(): Record<string, string> {
    return { "x-client-id": this.opts.clientId, "x-client-secret": this.opts.clientSecret, "content-type": "application/json", "user-agent": OURA.userAgent };
  }

  async listSubscriptions(): Promise<OuraSubscription[]> {
    return getJson<OuraSubscription[]>(this.http, `${OURA.api}/v2/webhook/subscription`, { headers: this.appHeaders() });
  }

  /** One subscription per (event_type, data_type). Note data_type "vo2_max" is lowercase here. */
  async createSubscription(callbackUrl: string, eventType: OuraSubscription["event_type"], dataType: string): Promise<OuraSubscription> {
    if (!this.opts.webhookVerificationToken) throw new Error("oura_no_verification_token");
    return getJson<OuraSubscription>(this.http, `${OURA.api}/v2/webhook/subscription`, {
      method: "POST",
      headers: this.appHeaders(),
      body: JSON.stringify({ callback_url: callbackUrl, verification_token: this.opts.webhookVerificationToken, event_type: eventType, data_type: dataType }),
    });
  }

  /**
   * Renew every subscription expiring within `withinMs` (default 7 days). Run from a daily cron.
   * TODO(verify): the docs do not state the subscription lifetime, so renew early and often.
   */
  async renewExpiringSubscriptions(withinMs = 7 * 86_400_000): Promise<OuraSubscription[]> {
    const now = this.clock().getTime();
    const renewed: OuraSubscription[] = [];
    for (const s of await this.listSubscriptions()) {
      const exp = Date.parse(s.expiration_time);
      if (Number.isNaN(exp) || exp - now > withinMs) continue;
      renewed.push(await getJson<OuraSubscription>(this.http, `${OURA.api}/v2/webhook/subscription/renew/${encodeURIComponent(s.id)}`, { method: "PUT", headers: this.appHeaders() }));
    }
    return renewed;
  }

  // ---------- normalize ----------

  normalize(raw: RawRecord): CanonicalRecord[] {
    const d = raw.payload as Record<string, unknown>;
    const src = raw.source_id;
    const fallbackTz = raw.tz_offset_min ?? 0;
    const tzOf = (s: unknown) => (typeof s === "string" ? offsetFromIso(s) : fallbackTz);
    const id = String(d.id ?? "");
    const out: CanonicalRecord[] = [];
    switch (raw.type) {
      case "daily_activity": {
        const day = d.day as string;
        const tz = tzOf(d.timestamp);
        const w = localDayWindow(day, tz);
        const steps = num(d.steps);
        const kcal = num(d.active_calories);
        if (steps !== undefined) out.push(sample("steps", steps, "count", w.start, w.end, tz, src, `oura:daily_activity:${id}:steps`, "vendor_daily"));
        if (kcal !== undefined) out.push(sample("active_energy", kcal, "kcal", w.start, w.end, tz, src, `oura:daily_activity:${id}:active_energy`, "vendor_daily"));
        const score = num(d.score);
        if (score !== undefined) out.push(vendorScore("oura", "activity_score", score, day, src, `oura:daily_activity:${id}:score`));
        break;
      }
      case "daily_readiness": {
        const day = d.day as string;
        const tz = tzOf(d.timestamp);
        const w = localDayWindow(day, tz);
        const dev = num(d.temperature_deviation);
        if (dev !== undefined) out.push(sample("skin_temp_deviation", dev, "degC", w.start, w.end, tz, src, `oura:daily_readiness:${id}:temperature_deviation`, "vendor_daily"));
        const score = num(d.score);
        if (score !== undefined) out.push(vendorScore("oura", "readiness", score, day, src, `oura:daily_readiness:${id}`));
        break;
      }
      case "daily_sleep": {
        const score = num(d.score);
        if (score !== undefined) out.push(vendorScore("oura", "sleep_score", score, d.day as string, src, `oura:daily_sleep:${id}`));
        break;
      }
      case "sleep": {
        const type = d.type as string;
        if (type === "deleted") break;
        const start = d.bedtime_start as string;
        const end = d.bedtime_end as string;
        if (!start || !end || Date.parse(end) <= Date.parse(start)) break; // sandbox can return start == end
        const tz = tzOf(start);
        const min = (k: string) => (num(d[k]) === undefined ? undefined : round(num(d[k])! / 60));
        const detail = Object.fromEntries(
          Object.entries({ deep_min: min("deep_sleep_duration"), light_min: min("light_sleep_duration"), rem_min: min("rem_sleep_duration"), awake_min: min("awake_time"), in_bed_min: min("time_in_bed") }).filter(([, v]) => v !== undefined),
        );
        const main = type === "long_sleep";
        out.push(session("sleep", start, end, tz, src, `oura:sleep:${id}`, detail, main));
        // Night metrics only from real sleeps, not naps or rest periods, so night means are not skewed.
        if (type === "long_sleep" || type === "sleep") {
          const add = (metric: "sleep_efficiency" | "hrv_rmssd" | "resting_hr" | "respiratory_rate", key: string, unit: string, method: "measured" | "vendor_daily" = "measured") => {
            const v = num(d[key]);
            if (v !== undefined) out.push(sample(metric, v, unit, start, end, tz, src, `oura:sleep:${id}:${metric}`, method));
          };
          add("sleep_efficiency", "efficiency", "percent", "vendor_daily");
          add("hrv_rmssd", "average_hrv", "ms"); // Oura reports RMSSD
          add("resting_hr", "lowest_heart_rate", "bpm", "vendor_daily"); // Oura's resting HR is the night's lowest
          add("respiratory_rate", "average_breath", "breaths/min");
        }
        break;
      }
      case "heartrate": {
        const ts = d.timestamp as string;
        const bpm = num(d.bpm);
        if (!ts || bpm === undefined) break;
        // Heart-rate timestamps are UTC; the local offset comes from the user's profile or nearest sleep.
        out.push(sample("heart_rate", bpm, "bpm", ts, ts, fallbackTz, src, `oura:heartrate:${new Date(ts).toISOString()}`));
        break;
      }
      case "daily_spo2": {
        const avg = num((d.spo2_percentage as { average?: unknown } | null)?.average);
        if (avg === undefined) break;
        const w = localDayWindow(d.day as string, fallbackTz);
        out.push(sample("spo2", avg, "percent", w.start, w.end, fallbackTz, src, `oura:daily_spo2:${id}`, "vendor_daily"));
        // breathing_disturbance_index is not mapped: a sensitive category, and the index is not events/hour.
        break;
      }
      case "workout": {
        const start = d.start_datetime as string;
        const end = d.end_datetime as string;
        const detail = {
          type: mapWorkoutType(d.activity as string),
          ...(num(d.calories) !== undefined ? { energy_kcal: num(d.calories)! } : {}),
          ...(num(d.distance) !== undefined ? { distance_m: num(d.distance)! } : {}),
          ...(typeof d.label === "string" ? { title: d.label } : {}),
        };
        out.push(session("workout", start, end, tzOf(start), src, `oura:workout:${id}`, detail));
        break;
      }
      case "vO2_max": {
        const v = num(d.vo2_max);
        if (v === undefined) break;
        const tz = typeof d.timestamp === "string" && /(Z|[+-]\d{2}:?\d{2})$/.test(d.timestamp) ? offsetFromIso(d.timestamp) : fallbackTz;
        const w = localDayWindow(d.day as string, tz);
        out.push(sample("vo2max", v, "ml/kg/min", w.start, w.end, tz, src, `oura:vo2_max:${id}`, "vendor_daily"));
        break;
      }
    }
    return out;
  }
}
