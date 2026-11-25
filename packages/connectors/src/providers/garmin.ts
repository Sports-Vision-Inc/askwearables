// Garmin Connect Developer Program: Health API + Activity API. Docs read 2026-11-24: docs/providers/garmin.md.
// Garmin's full API spec is behind the partner login and was NOT readable; payload field names come from django-garmin
// and Open Wearables code. Anything not confirmed there is marked TODO(verify) and left unmapped.
//
// - OAuth 2.0 PKCE (Garmin PDF 2025-06-11). Access tokens ~24h; refresh tokens ~90 days and rotate on every refresh.
// - Delivery: push (full summaries in the POST) on every tier; ping (callbackURL to pull) and backfill are Enterprise-only.
// - Backfill is asynchronous: GET /backfill/{type} returns 202 and the data arrives later through the SAME webhook
//   endpoints. So handleWebhook and normalize are idempotent: external ids come from summaryId, and job dedupe keys hash
//   the entry so redeliveries collapse while updated summaries (same summaryId, new content) still go through.
// - Webhooks carry no signature. We require a secret token in the callback URL and only fetch callbackURLs on apis.garmin.com.
import { canonicalJson, mapWorkoutType, sha256Hex, type CanonicalRecord, type SleepStagesDetail } from "@askwearables/core";
import { capabilitiesFor } from "../capabilities.js";
import { ProviderDisabled, WebhookAuthError, type AuthStart, type Capabilities, type Connector, type ConnectorOptions, type ExchangeContext, type RawRecord, type SyncJob, type Tokens } from "../connector.js";
import { fetchWithBackoff, formBody, getJson, HttpError, pkcePair, randomToken, tokensFromResponse, type OAuthTokenResponse } from "../http.js";
import { timingSafeEqual } from "../webhook.js";
import { BaseConnector, fromEpochSeconds, num, round, sample, session, vendorScore } from "../base.js";

export const GARMIN = {
  authorize: "https://connect.garmin.com/oauth2Confirm",
  // TODO(verify): Garmin's PDF says connectapi.garmin.com; django-garmin and community code use diauth.garmin.com.
  token: "https://connectapi.garmin.com/di-oauth2-service/oauth/token",
  api: "https://apis.garmin.com/wellness-api/rest",
  callbackHost: "apis.garmin.com",
  backfillTypes: ["dailies", "sleeps", "activities", "pulseox", "bodyComps"],
} as const;

export interface GarminOptions extends ConnectorOptions {
  /** Secret in the webhook URL (?token= or last path segment). Garmin has no signature, so this is required. */
  webhookToken: string;
  /**
   * Days per backfill request. TODO(verify): django-garmin allows 90; Open Wearables reports one day per request.
   * Default 1, the conservative reading.
   */
  backfillChunkDays?: number;
}

const ENTRY_ID_FIELDS = ["summaryId", "activityId"] as const;

export class GarminConnector extends BaseConnector implements Connector {
  readonly provider = "garmin" as const;
  readonly capabilities: Capabilities;

  constructor(
    protected override readonly opts: GarminOptions,
    tier?: string,
  ) {
    super(opts);
    this.capabilities = capabilitiesFor("garmin", tier);
  }

  async authUrl(_userId: string, redirectUri: string): Promise<AuthStart> {
    const state = randomToken();
    const { verifier, challenge } = await pkcePair();
    const q = new URLSearchParams({ response_type: "code", client_id: this.opts.clientId, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: redirectUri, state });
    return { url: `${GARMIN.authorize}?${q}`, state, code_verifier: verifier };
  }

  async exchangeCode(code: string, ctx: ExchangeContext = {}): Promise<Tokens> {
    if (!ctx.codeVerifier) throw new Error("garmin_requires_pkce_verifier");
    const t = await this.tokenRequest({ grant_type: "authorization_code", client_id: this.opts.clientId, client_secret: this.opts.clientSecret, code, code_verifier: ctx.codeVerifier, redirect_uri: ctx.redirectUri });
    const id = await getJson<{ userId: string }>(this.http, `${GARMIN.api}/user/id`, { headers: { authorization: `Bearer ${t.access_token}` } });
    t.provider_user_id = id.userId;
    return t;
  }

  /** Rotating refresh: store the new pair together; refresh at least 600 s before expiry. */
  async refresh(tokens: Tokens): Promise<Tokens> {
    if (!tokens.refresh_token) throw new Error("garmin_no_refresh_token");
    const t = await this.tokenRequest({ grant_type: "refresh_token", client_id: this.opts.clientId, client_secret: this.opts.clientSecret, refresh_token: tokens.refresh_token });
    if (tokens.provider_user_id) t.provider_user_id = tokens.provider_user_id;
    return t;
  }

  private async tokenRequest(fields: Record<string, string | undefined>): Promise<Tokens> {
    const res = await fetchWithBackoff(this.http, GARMIN.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: formBody(fields) });
    if (!res.ok) throw new HttpError(res.status, GARMIN.token, await res.text());
    return tokensFromResponse((await res.json()) as OAuthTokenResponse, this.clock());
  }

  /**
   * Request asynchronous backfill (Enterprise only, needs the HISTORICAL_DATA_EXPORT permission). Yields nothing:
   * Garmin answers 202 and later pushes the summaries to the webhook, where handleWebhook dedupes them.
   */
  async *backfill(userId: string, since: string): AsyncIterable<RawRecord> {
    if (!this.capabilities.backfill) throw new ProviderDisabled("garmin", "backfill_requires_enterprise");
    const { access_token } = await this.tokensFor(userId);
    const now = this.clock().getTime();
    const floor = this.capabilities.historyDays === null ? 0 : now - this.capabilities.historyDays * 86_400_000;
    const startMs = Math.max(Date.parse(`${since}T00:00:00Z`), floor);
    const step = (this.opts.backfillChunkDays ?? 1) * 86_400_000;
    for (const type of GARMIN.backfillTypes) {
      for (let t = startMs; t < now; t += step) {
        const q = new URLSearchParams({ summaryStartTimeInSeconds: String(Math.floor(t / 1000)), summaryEndTimeInSeconds: String(Math.floor(Math.min(now, t + step) / 1000)) });
        const url = `${GARMIN.api}/backfill/${type}?${q}`;
        const res = await fetchWithBackoff(this.http, url, { headers: { authorization: `Bearer ${access_token}` } });
        // 409: a backfill for this window was already requested; fine, it is idempotent.
        if (res.status !== 202 && res.status !== 200 && res.status !== 409) throw new HttpError(res.status, url, await res.text());
      }
    }
  }

  /** Pull a ping's callbackURL. Only apis.garmin.com/wellness-api URLs are fetched, so a forged ping cannot steal a token. */
  async fetchCallback(userId: string, dataType: string, callbackUrl: string): Promise<RawRecord[]> {
    if (!isGarminCallback(callbackUrl)) throw new WebhookAuthError("garmin_callback_host");
    const { access_token } = await this.tokensFor(userId);
    const list = await getJson<unknown[]>(this.http, callbackUrl, { headers: { authorization: `Bearer ${access_token}` } });
    return (list ?? []).map((e) => this.raw(userId, dataType, e));
  }

  async handleWebhook(request: Request): Promise<SyncJob[]> {
    const u = new URL(request.url);
    const token = u.searchParams.get("token") ?? u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (!this.opts.webhookToken || !timingSafeEqual(token, this.opts.webhookToken)) throw new WebhookAuthError("garmin_token");
    const body = (await request.json()) as Record<string, Record<string, unknown>[]>;
    const jobs: SyncJob[] = [];
    for (const [type, entries] of Object.entries(body)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const userId = String(entry.userId ?? "");
        if (type === "deregistrations") {
          jobs.push({ provider: "garmin", action: "deregister", provider_user_id: userId, data_type: type, dedupe_key: `garmin:deregistration:${userId}` });
          continue;
        }
        if (typeof entry.callbackURL === "string") {
          if (!isGarminCallback(entry.callbackURL)) throw new WebhookAuthError("garmin_callback_host");
          const cu = new URL(entry.callbackURL);
          jobs.push({
            provider: "garmin",
            action: "fetch_url",
            provider_user_id: userId,
            data_type: type,
            url: entry.callbackURL,
            dedupe_key: `garmin:ping:${type}:${userId}:${cu.searchParams.get("uploadStartTimeInSeconds")}:${cu.searchParams.get("uploadEndTimeInSeconds")}`,
          });
          continue;
        }
        // Push: data inline. Drop the legacy OAuth1 userAccessToken before the payload reaches a queue.
        const { userAccessToken: _drop, ...clean } = entry;
        const id = ENTRY_ID_FIELDS.map((k) => clean[k]).find((v) => v !== undefined);
        const hash = (await sha256Hex(canonicalJson(clean))).slice(0, 16);
        jobs.push({ provider: "garmin", action: "ingest", provider_user_id: userId, data_type: type, payload: clean, ...(id !== undefined ? { object_id: String(id) } : {}), dedupe_key: `garmin:${type}:${id ?? "noid"}:${hash}` });
      }
    }
    return jobs;
  }

  // ---------- normalize ----------

  normalize(raw: RawRecord): CanonicalRecord[] {
    const d = raw.payload as Record<string, any>;
    const src = raw.source_id;
    const out: CanonicalRecord[] = [];
    const tz = num(d.startTimeOffsetInSeconds) !== undefined ? Math.round(num(d.startTimeOffsetInSeconds)! / 60) : (raw.tz_offset_min ?? 0);
    const startS = num(d.startTimeInSeconds);
    const durS = num(d.durationInSeconds);
    const sid = d.summaryId ?? d.activityId;
    const ext = `garmin:${raw.type}:${sid}`;
    switch (raw.type) {
      case "dailies": {
        if (startS === undefined || durS === undefined) break;
        const start = fromEpochSeconds(startS);
        const end = fromEpochSeconds(startS + durS);
        const add = (metric: "steps" | "active_energy" | "resting_hr", v: unknown, unit: string) => {
          const n = num(v);
          if (n !== undefined) out.push(sample(metric, n, unit, start, end, tz, src, `${ext}:${metric}`, "vendor_daily"));
        };
        add("steps", d.steps, "count");
        add("active_energy", d.activeKilocalories, "kcal");
        add("resting_hr", d.restingHeartRateInBeatsPerMinute, "bpm");
        for (const [off, bpm] of Object.entries((d.timeOffsetHeartRateSamples ?? {}) as Record<string, number>)) {
          const t = fromEpochSeconds(startS + Number(off));
          out.push(sample("heart_rate", bpm, "bpm", t, t, tz, src, `${ext}:hr:${off}`));
        }
        // Garmin's stress level is a proprietary 0-100 score.
        const stress = num(d.averageStressLevel);
        if (stress !== undefined && stress >= 0 && d.calendarDate) out.push(vendorScore("garmin", "stress", stress, d.calendarDate, src, `${ext}:stress`));
        // TODO(verify): Body Battery field names (e.g. bodyBatteryChargedValue) were not in any readable source; not mapped.
        break;
      }
      case "sleeps": {
        if (startS === undefined || durS === undefined) break;
        const detail: SleepStagesDetail = {};
        const levels = (d.sleepLevelsMap ?? {}) as Record<string, { startTimeInSeconds: number; endTimeInSeconds: number }[]>;
        const mins = (k: string) => (levels[k] ? round(levels[k].reduce((a, r) => a + (r.endTimeInSeconds - r.startTimeInSeconds), 0) / 60) : undefined);
        const stages = { deep_min: mins("deep"), light_min: mins("light"), rem_min: mins("rem"), awake_min: mins("awake") };
        for (const [k, v] of Object.entries(stages)) if (v !== undefined) (detail as Record<string, number>)[k] = v;
        detail.in_bed_min = round(durS / 60);
        out.push(session("sleep", fromEpochSeconds(startS), fromEpochSeconds(startS + durS), tz, src, ext, detail));
        break;
      }
      case "pulseox": {
        if (startS === undefined) break;
        for (const [off, v] of Object.entries((d.timeOffsetSpo2Values ?? {}) as Record<string, number>)) {
          const t = fromEpochSeconds(startS + Number(off));
          out.push(sample("spo2", v, "percent", t, t, tz, src, `${ext}:${off}`));
        }
        break;
      }
      case "bodyComps": {
        const t = num(d.measurementTimeInSeconds);
        const g = num(d.weightInGrams);
        if (t === undefined || g === undefined) break;
        const btz = num(d.measurementTimeOffsetInSeconds) !== undefined ? Math.round(num(d.measurementTimeOffsetInSeconds)! / 60) : (raw.tz_offset_min ?? 0);
        out.push(sample("weight", g, "g", fromEpochSeconds(t), fromEpochSeconds(t), btz, src, `${ext}:weight`));
        break;
      }
      case "activities":
      case "manuallyUpdatedActivities": {
        if (startS === undefined || durS === undefined) break;
        const detail: Record<string, unknown> = { type: mapWorkoutType(d.activityType) };
        if (num(d.averageHeartRateInBeatsPerMinute) !== undefined) detail.avg_hr = num(d.averageHeartRateInBeatsPerMinute);
        if (num(d.distanceInMeters) !== undefined) detail.distance_m = num(d.distanceInMeters);
        if (num(d.activeKilocalories) !== undefined) detail.energy_kcal = num(d.activeKilocalories);
        if (typeof d.activityName === "string") detail.title = d.activityName;
        // Both activity types share one id space, so updates overwrite the original.
        out.push(session("workout", fromEpochSeconds(startS), fromEpochSeconds(startS + durS), tz, src, `garmin:activities:${sid}`, detail as { type: string }));
        break;
      }
      // hrv, userMetrics, skinTemp, respiration, stressDetails, healthSnapshot: field names TODO(verify); not mapped.
    }
    return out;
  }
}

export function isGarminCallback(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === GARMIN.callbackHost && u.pathname.startsWith("/wellness-api/rest/");
  } catch {
    return false;
  }
}
