// Adapter to a self-hosted Open Wearables instance (MIT, pre-1.0). Read 2026-11-24 from the repo at HEAD 6811b28 and
// openwearables.io docs: docs/providers/open-wearables.md.
//
// Open Wearables already runs the provider OAuth and the phone sync SDKs; this adapter reads its unified API.
// - Auth: X-Open-Wearables-API-Key (the instance API key, passed as clientSecret). No OAuth with us: the owner maps each
//   AskWearables user to an Open Wearables user UUID, which authUrl/exchangeCode carry through as provider_user_id.
// - Every record keeps its upstream source: source_id becomes `${source_id}/${source.provider}/${device}` so values from
//   different devices never merge (spec: "every value keeps its source").
// - Upstream terms still apply. Records whose source.provider is "strava" are DROPPED: Strava's 2026 API Policy bans AI use
//   and intermediaries, and Open Wearables is an intermediary.
// - Outgoing webhooks go through Svix (off by default on the instance): svix-id, svix-timestamp, svix-signature.
import { CATALOGUE, mapWorkoutType, type CanonicalRecord, type MetricId, type SleepStagesDetail } from "@askwearables/core";
import { capabilitiesFor } from "../capabilities.js";
import { WebhookAuthError, type AuthStart, type Capabilities, type Connector, type ConnectorOptions, type ExchangeContext, type RawRecord, type SyncJob, type Tokens } from "../connector.js";
import { getJson, randomToken } from "../http.js";
import { fromBase64, hmacSha256, timingSafeEqual, toBase64, withinTolerance } from "../webhook.js";
import { BaseConnector, num, offsetFromIso, round, sample, session } from "../base.js";

export interface OpenWearablesOptions extends ConnectorOptions {
  /** e.g. "http://localhost:8000". "/api/v1" is appended. */
  baseUrl: string;
  /** Svix endpoint secret ("whsec_..."). */
  webhookSecret?: string;
  webhookToleranceMs?: number;
}

/** Upstream providers whose data must never pass through this adapter. */
export const OW_BLOCKED_UPSTREAM = new Set(["strava"]);

/** Open Wearables series type -> catalogue metric. */
export const OW_SERIES: Record<string, MetricId> = {
  steps: "steps",
  active_energy: "active_energy",
  heart_rate: "heart_rate",
  resting_heart_rate: "resting_hr",
  heart_rate_variability_rmssd: "hrv_rmssd",
  heart_rate_variability_sdnn: "hrv_sdnn",
  oxygen_saturation: "spo2",
  respiratory_rate: "respiratory_rate",
  weight: "weight",
  vo2_max: "vo2max",
};

/** Open Wearables unit spellings that differ from the catalogue's. */
const UNIT_ALIASES: Record<string, string> = { brpm: "breaths/min", "mL/kg/min": "ml/kg/min", "ml/kg/min": "ml/kg/min", celsius: "degC", kilograms: "kg" };

interface OwSource {
  provider?: string;
  device?: string | null;
}

export class OpenWearablesConnector extends BaseConnector implements Connector {
  readonly provider = "open-wearables" as const;
  readonly capabilities: Capabilities;

  constructor(
    protected override readonly opts: OpenWearablesOptions,
    tier?: string,
  ) {
    super(opts);
    this.capabilities = capabilitiesFor("open-wearables", tier);
  }

  private get api() {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}/api/v1`;
  }

  private headers() {
    return { headers: { "x-open-wearables-api-key": this.opts.clientSecret, accept: "application/json" } };
  }

  /**
   * No OAuth: the owner links the AskWearables user to an Open Wearables user UUID. The returned URL is the redirect
   * target with `code` set to that UUID, so the same callback route works for every connector.
   * `userId` here is the Open Wearables user UUID chosen by the owner.
   */
  async authUrl(userId: string, redirectUri: string): Promise<AuthStart> {
    const state = randomToken();
    const u = new URL(redirectUri);
    u.searchParams.set("code", userId);
    u.searchParams.set("state", state);
    return { url: u.toString(), state };
  }

  /** `code` is the Open Wearables user UUID; checks it exists on the instance. */
  async exchangeCode(code: string, _ctx: ExchangeContext = {}): Promise<Tokens> {
    await getJson(this.http, `${this.api}/users/${encodeURIComponent(code)}`, this.headers());
    return { access_token: "api-key", provider_user_id: code };
  }

  /** API-key access: nothing to refresh. */
  async refresh(tokens: Tokens): Promise<Tokens> {
    return tokens;
  }

  private async *cursor(url: string, params: Record<string, string | string[]>): AsyncGenerator<unknown> {
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
      if (cursor) q.set("cursor", cursor);
      const page: { data: unknown[]; pagination?: { next_cursor: string | null; has_more: boolean } } = await getJson(this.http, `${url}?${q}`, this.headers());
      for (const d of page.data ?? []) yield d;
      cursor = page.pagination?.has_more ? page.pagination.next_cursor : null;
    } while (cursor);
  }

  async *backfill(userId: string, since: string): AsyncIterable<RawRecord> {
    const t = await this.tokensFor(userId);
    const ow = encodeURIComponent(t.provider_user_id ?? userId);
    const now = this.clock().toISOString();
    for await (const s of this.cursor(`${this.api}/users/${ow}/timeseries`, { start_time: `${since}T00:00:00Z`, end_time: now, types: Object.keys(OW_SERIES), resolution: "raw", limit: "1000" }))
      yield this.raw(userId, "timeseries", s);
    const today = now.slice(0, 10);
    for await (const w of this.cursor(`${this.api}/users/${ow}/events/workouts`, { start_date: since, end_date: today, limit: "1000" })) yield this.raw(userId, "workout", w);
    for await (const s of this.cursor(`${this.api}/users/${ow}/events/sleep`, { start_date: since, end_date: today, limit: "1000" })) yield this.raw(userId, "sleep", s);
  }

  async handleWebhook(request: Request): Promise<SyncJob[]> {
    const body = await request.text();
    const id = request.headers.get("svix-id") ?? "";
    const ts = request.headers.get("svix-timestamp") ?? "";
    const sigs = (request.headers.get("svix-signature") ?? "").split(" ");
    if (!this.opts.webhookSecret || !id || !ts) throw new WebhookAuthError("open_wearables_headers");
    const key = fromBase64(this.opts.webhookSecret.replace(/^whsec_/, ""));
    const expected = toBase64(await hmacSha256(key, `${id}.${ts}.${body}`));
    if (!sigs.some((s) => s.startsWith("v1,") && timingSafeEqual(s.slice(3), expected))) throw new WebhookAuthError("open_wearables_signature");
    if (!withinTolerance(Number(ts) * 1000, this.clock(), this.opts.webhookToleranceMs ?? 5 * 60_000)) throw new WebhookAuthError("open_wearables_timestamp");
    const e = JSON.parse(body) as { type: string; data?: { id?: string; user_id?: string; source?: OwSource } };
    if (e.data?.source?.provider && OW_BLOCKED_UPSTREAM.has(e.data.source.provider)) return [];
    const [kind, ...rest] = e.type.split(".");
    const dataType = kind === "series" ? rest.slice(0, -1).join(".") : (kind ?? e.type);
    const job: SyncJob = { provider: "open-wearables", action: "fetch", provider_user_id: e.data?.user_id ?? "", data_type: dataType, dedupe_key: `open-wearables:${id}` };
    if (e.data?.id) job.object_id = e.data.id;
    return [job];
  }

  private sourceFor(raw: RawRecord, s: OwSource | undefined): string {
    return `${raw.source_id}/${s?.provider ?? "unknown"}/${s?.device ?? "unknown"}`;
  }

  normalize(raw: RawRecord): CanonicalRecord[] {
    const d = raw.payload as Record<string, any>;
    const src: OwSource | undefined = d.source;
    if (src?.provider && OW_BLOCKED_UPSTREAM.has(src.provider)) return [];
    const sid = this.sourceFor(raw, src);
    const tzOf = (z: unknown) => (typeof z === "string" ? offsetFromIso(z) : (raw.tz_offset_min ?? 0));
    switch (raw.type) {
      case "timeseries": {
        const metric = OW_SERIES[d.type as string];
        const value = num(d.value);
        if (!metric || value === undefined) return [];
        const unit = UNIT_ALIASES[d.unit] ?? d.unit;
        if (unit !== CATALOGUE[metric].unit && CATALOGUE[metric].accepts[unit] === undefined) return []; // unknown unit: never land silently
        const start = d.timestamp as string;
        const end = num(d.window_seconds) ? new Date(Date.parse(start) + num(d.window_seconds)! * 1000).toISOString() : start;
        const ext = `open-wearables:${d.type}:${src?.provider ?? "unknown"}:${src?.device ?? "unknown"}:${new Date(start).toISOString()}`;
        return [sample(metric, value, unit, start, end, tzOf(d.zone_offset), sid, ext, d.is_daily_total ? "vendor_daily" : "measured")];
      }
      case "workout": {
        const detail: Record<string, unknown> = { type: mapWorkoutType(d.type) };
        if (num(d.calories_kcal) !== undefined) detail.energy_kcal = num(d.calories_kcal);
        if (num(d.distance_meters) !== undefined) detail.distance_m = num(d.distance_meters);
        if (num(d.avg_heart_rate_bpm) !== undefined) detail.avg_hr = num(d.avg_heart_rate_bpm);
        if (typeof d.name === "string") detail.title = d.name;
        return [session("workout", d.start_time, d.end_time, tzOf(d.zone_offset), sid, `open-wearables:workout:${d.id}`, detail as { type: string })];
      }
      case "sleep": {
        const tz = tzOf(d.zone_offset);
        const st = d.stages ?? {};
        const detail: SleepStagesDetail = {};
        const map = { deep_min: st.deep_minutes, light_min: st.light_minutes, rem_min: st.rem_minutes, awake_min: st.awake_minutes, in_bed_min: num(d.time_in_bed_seconds) !== undefined ? round(num(d.time_in_bed_seconds)! / 60) : undefined };
        for (const [k, v] of Object.entries(map)) if (num(v) !== undefined) (detail as Record<string, number>)[k] = num(v)!;
        const out: CanonicalRecord[] = [session("sleep", d.start_time, d.end_time, tz, sid, `open-wearables:sleep:${d.id}`, detail, !d.is_nap)];
        if (!d.is_nap && num(d.efficiency_percent) !== undefined) out.push(sample("sleep_efficiency", num(d.efficiency_percent)!, "percent", d.start_time, d.end_time, tz, sid, `open-wearables:sleep:${d.id}:efficiency`, "vendor_daily"));
        return out;
      }
    }
    return [];
  }
}
