// WHOOP API v2. Docs read 2026-11-24: docs/providers/whoop.md (developer.whoop.com oauth, webhooks, api, rate limiting,
// v1->v2 migration, API terms effective 2026-10-06).
//
// REFRESH: "Existing access tokens are invalidated once your app uses the refresh token", and refresh tokens rotate.
// Callers MUST serialize refreshes per user (one in flight at a time; see serializeRefresh in ../refresh.ts and run it
// inside the user's Durable Object) and persist the new pair before any other request uses the old access token.
//
// WEBHOOKS: v1 webhooks are gone (changelog 2025-11-01). v2 recovery events carry the SLEEP UUID in `id`, not a cycle id:
// fetch the sleep, read its cycle_id, then GET /v2/cycle/{cycle_id}/recovery (fetchRecoveryForSleep).
import { mapWorkoutType, type CanonicalRecord } from "@askwearables/core";
import { capabilitiesFor } from "../capabilities.js";
import { WebhookAuthError, type AuthStart, type Capabilities, type Connector, type ConnectorOptions, type ExchangeContext, type RawRecord, type SyncJob, type Tokens } from "../connector.js";
import { fetchWithBackoff, formBody, getJson, HttpError, tokensFromResponse, type OAuthTokenResponse } from "../http.js";
import { verifyHmacSha256, withinTolerance } from "../webhook.js";
import { BaseConnector, localDay, num, offsetFromIso, round, sample, session, vendorScore } from "../base.js";

export const WHOOP = {
  authorize: "https://api.prod.whoop.com/oauth/oauth2/auth",
  token: "https://api.prod.whoop.com/oauth/oauth2/token",
  api: "https://api.prod.whoop.com/developer",
  /** Six data scopes plus `offline`, which is required for a refresh token. */
  scopes: ["read:recovery", "read:cycles", "read:workout", "read:sleep", "read:profile", "read:body_measurement", "offline"],
  pageLimit: 25,
} as const;

export interface WhoopOptions extends ConnectorOptions {
  /** Reject webhook timestamps further than this from now. WHOOP documents no window; default 5 minutes. */
  webhookToleranceMs?: number;
}

const KJ_TO_KCAL = 0.239006;
const MS_PER_MIN = 60_000;

export class WhoopConnector extends BaseConnector implements Connector {
  readonly provider = "whoop" as const;
  readonly capabilities: Capabilities;

  constructor(
    protected override readonly opts: WhoopOptions,
    tier?: string,
  ) {
    super(opts);
    this.capabilities = capabilitiesFor("whoop", tier);
  }

  async authUrl(_userId: string, redirectUri: string): Promise<AuthStart> {
    // WHOOP requires state to be exactly 8 characters.
    const state = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
    const q = new URLSearchParams({ response_type: "code", client_id: this.opts.clientId, redirect_uri: redirectUri, scope: WHOOP.scopes.join(" "), state });
    return { url: `${WHOOP.authorize}?${q}`, state };
  }

  async exchangeCode(code: string, ctx: ExchangeContext = {}): Promise<Tokens> {
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri, client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    try {
      const p = await getJson<{ user_id?: number }>(this.http, `${WHOOP.api}/v2/user/profile/basic`, { headers: { authorization: `Bearer ${t.access_token}` } });
      if (p?.user_id !== undefined) t.provider_user_id = String(p.user_id);
    } catch {
      // read:profile not granted
    }
    return t;
  }

  /** See the REFRESH note at the top: the old access token stops working as soon as this succeeds. */
  async refresh(tokens: Tokens): Promise<Tokens> {
    if (!tokens.refresh_token) throw new Error("whoop_no_refresh_token");
    const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: this.opts.clientId, client_secret: this.opts.clientSecret, scope: "offline" });
    if (tokens.provider_user_id) t.provider_user_id = tokens.provider_user_id;
    return t;
  }

  private async tokenRequest(fields: Record<string, string | undefined>): Promise<Tokens> {
    const res = await fetchWithBackoff(this.http, WHOOP.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: formBody(fields) });
    if (!res.ok) throw new HttpError(res.status, WHOOP.token, await res.text());
    return tokensFromResponse((await res.json()) as OAuthTokenResponse, this.clock());
  }

  private async *collection(path: string, since: string, accessToken: string): AsyncGenerator<Record<string, unknown>> {
    let next: string | undefined;
    do {
      const q = new URLSearchParams({ limit: String(WHOOP.pageLimit), start: new Date(`${since}T00:00:00Z`).toISOString() });
      if (next) q.set("nextToken", next);
      const page = await getJson<{ records: Record<string, unknown>[]; next_token?: string | null }>(this.http, `${WHOOP.api}${path}?${q}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      for (const r of page.records ?? []) yield r;
      next = page.next_token || undefined;
    } while (next);
  }

  async *backfill(userId: string, since: string): AsyncIterable<RawRecord> {
    const { access_token } = await this.tokensFor(userId);
    const sleeps = new Map<string, Record<string, unknown>>();
    for await (const s of this.collection("/v2/activity/sleep", since, access_token)) {
      sleeps.set(String(s.id), s);
      yield this.raw(userId, "sleep", s);
    }
    for await (const r of this.collection("/v2/recovery", since, access_token)) {
      const rec = this.raw(userId, "recovery", r);
      const s = sleeps.get(String(r.sleep_id));
      if (s) rec.context = { sleep: s };
      yield rec;
    }
    for await (const c of this.collection("/v2/cycle", since, access_token)) yield this.raw(userId, "cycle", c);
    for await (const w of this.collection("/v2/activity/workout", since, access_token)) yield this.raw(userId, "workout", w);
    try {
      const body = await getJson(this.http, `${WHOOP.api}/v2/user/measurement/body`, { headers: { authorization: `Bearer ${access_token}` } });
      yield this.raw(userId, "body_measurement", body);
    } catch (e) {
      if (!(e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 404))) throw e;
    }
  }

  /** Recovery webhook handling: the event id is a sleep UUID. */
  async fetchRecoveryForSleep(userId: string, sleepId: string): Promise<RawRecord> {
    const { access_token } = await this.tokensFor(userId);
    const h = { headers: { authorization: `Bearer ${access_token}` } };
    const sleep = await getJson<Record<string, unknown>>(this.http, `${WHOOP.api}/v2/activity/sleep/${encodeURIComponent(sleepId)}`, h);
    const rec = await getJson(this.http, `${WHOOP.api}/v2/cycle/${encodeURIComponent(String(sleep.cycle_id))}/recovery`, h);
    const raw = this.raw(userId, "recovery", rec);
    raw.context = { sleep };
    return raw;
  }

  async handleWebhook(request: Request): Promise<SyncJob[]> {
    const body = await request.text();
    const ts = request.headers.get("x-whoop-signature-timestamp") ?? "";
    const ok = await verifyHmacSha256({ secret: this.opts.clientSecret, message: ts + body, signature: request.headers.get("x-whoop-signature"), encoding: "base64" });
    if (!ok) throw new WebhookAuthError("whoop_signature");
    if (!withinTolerance(Number(ts), this.clock(), this.opts.webhookToleranceMs ?? 5 * 60_000)) throw new WebhookAuthError("whoop_timestamp");
    const e = JSON.parse(body) as { user_id: number; id: string; type: string; trace_id: string };
    const [dataType, verb] = e.type.split(".") as [string, string];
    return [
      {
        provider: "whoop",
        action: verb === "deleted" ? "delete" : "fetch",
        provider_user_id: String(e.user_id),
        data_type: dataType,
        // For recovery.*, this is the sleep UUID (fetch via fetchRecoveryForSleep).
        object_id: e.id,
        dedupe_key: `whoop:${e.type}:${e.id}:${e.trace_id}`,
      },
    ];
  }

  normalize(raw: RawRecord): CanonicalRecord[] {
    const d = raw.payload as Record<string, any>;
    const src = raw.source_id;
    const out: CanonicalRecord[] = [];
    const scored = d.score_state === "SCORED" && d.score;
    switch (raw.type) {
      case "cycle": {
        const tz = offsetFromIso(d.timezone_offset ?? "Z");
        // A cycle runs from sleep onset to the next sleep onset, so its start often falls on the previous local date.
        // Attribute it to the local day of its midpoint (or of its start while it is still open).
        // TODO(verify): WHOOP does not document which calendar day the app shows a cycle under.
        const mid = d.end ? new Date((Date.parse(d.start) + Date.parse(d.end)) / 2).toISOString() : d.start;
        const day = localDay(mid, tz);
        // Strain is WHOOP's proprietary load score: a vendor score, never a metric.
        if (scored && num(d.score.strain) !== undefined) out.push(vendorScore("whoop", "strain", num(d.score.strain)!, day, src, `whoop:cycle:${d.id}:strain`));
        // Not mapped: kilojoule is total (not active) energy; step_count (added 2026-09-23) covers a physiological cycle
        // (sleep onset to sleep onset), not a calendar day, so it cannot be attributed to one local day without double counting.
        break;
      }
      case "recovery": {
        if (!scored) break;
        const s = raw.context?.sleep as Record<string, any> | undefined;
        const tz = s?.timezone_offset ? offsetFromIso(s.timezone_offset) : (raw.tz_offset_min ?? 0);
        const start: string = s?.start ?? d.created_at;
        const end: string = s?.end ?? d.created_at;
        const key = `whoop:recovery:${d.sleep_id}`;
        out.push(vendorScore("whoop", "recovery", num(d.score.recovery_score)!, localDay(end, tz), src, key));
        const add = (metric: "resting_hr" | "hrv_rmssd" | "spo2", v: unknown, unit: string, method: "measured" | "vendor_daily") => {
          const n = num(v);
          if (n !== undefined) out.push(sample(metric, n, unit, start, end, tz, src, `${key}:${metric}`, method));
        };
        add("resting_hr", d.score.resting_heart_rate, "bpm", "vendor_daily");
        add("hrv_rmssd", d.score.hrv_rmssd_milli, "ms", "measured");
        add("spo2", d.score.spo2_percentage, "percent", "measured");
        // skin_temp_celsius is an absolute skin temperature, not a deviation from baseline; not mapped.
        break;
      }
      case "sleep": {
        const tz = offsetFromIso(d.timezone_offset ?? "Z");
        const ext = `whoop:sleep:${d.id}`;
        const ss = scored ? d.score.stage_summary : undefined;
        const m = (v: unknown) => (num(v) === undefined ? undefined : round(num(v)! / MS_PER_MIN));
        const detail = ss
          ? Object.fromEntries(
              Object.entries({ deep_min: m(ss.total_slow_wave_sleep_time_milli), light_min: m(ss.total_light_sleep_time_milli), rem_min: m(ss.total_rem_sleep_time_milli), awake_min: m(ss.total_awake_time_milli), in_bed_min: m(ss.total_in_bed_time_milli) }).filter(([, v]) => v !== undefined),
            )
          : {};
        out.push(session("sleep", d.start, d.end, tz, src, ext, detail, !d.nap));
        if (scored && !d.nap) {
          const eff = num(d.score.sleep_efficiency_percentage);
          if (eff !== undefined) out.push(sample("sleep_efficiency", eff, "percent", d.start, d.end, tz, src, `${ext}:sleep_efficiency`, "vendor_daily"));
          const rr = num(d.score.respiratory_rate);
          if (rr !== undefined) out.push(sample("respiratory_rate", rr, "breaths/min", d.start, d.end, tz, src, `${ext}:respiratory_rate`));
          const perf = num(d.score.sleep_performance_percentage);
          if (perf !== undefined) out.push(vendorScore("whoop", "sleep_performance", perf, localDay(d.end, tz), src, `${ext}:sleep_performance`));
        }
        break;
      }
      case "workout": {
        const tz = offsetFromIso(d.timezone_offset ?? "Z");
        const detail: Record<string, unknown> = { type: mapWorkoutType(d.sport_name) };
        if (scored) {
          if (num(d.score.average_heart_rate) !== undefined) detail.avg_hr = num(d.score.average_heart_rate);
          if (num(d.score.distance_meter) !== undefined) detail.distance_m = num(d.score.distance_meter);
          if (num(d.score.kilojoule) !== undefined) detail.energy_kcal = round(num(d.score.kilojoule)! * KJ_TO_KCAL, 1);
        }
        out.push(session("workout", d.start, d.end, tz, src, `whoop:workout:${d.id}`, detail as { type: string }));
        break;
      }
      case "body_measurement": {
        // No id or timestamp: one row per user, overwritten on each sync (latest value wins).
        const kg = num(d.weight_kilogram);
        if (kg !== undefined) out.push(sample("weight", kg, "kg", raw.received_at, raw.received_at, raw.tz_offset_min ?? 0, src, "whoop:body_measurement:weight", "manual"));
        break;
      }
    }
    return out;
  }
}
