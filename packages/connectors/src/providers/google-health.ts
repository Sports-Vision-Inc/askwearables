// Google Health API v4 (successor to the Fitbit Web API, which returns HTTP 410 since 2026-11-02).
// Docs read 2026-11-24: docs/providers/google-health.md (developers.google.com/health/*, discovery revision 20261123).
//
// - Store healthUserId (GET /v4/users/me/identity); it replaces the 6-character Fitbit id (still returned as legacyUserId).
// - Read through `dataPoints:reconcile`, the reconciled stream, so values match what the user sees in the app.
// - All scopes are Restricted: unverified apps are capped at 100 users.
// - Webhooks carry no data, only intervals to re-read. Each delivery is authenticated with our endpointAuthorization secret
//   (Authorization header) and signed (GOOGLE-HEALTH-API-SIGNATURE, ECDSA P-256/SHA-256, Tink output prefix).
import { mapWorkoutType, type CanonicalRecord, type SleepStagesDetail } from "@askwearables/core";
import { capabilitiesFor } from "../capabilities.js";
import { WebhookAuthError, type AuthStart, type Capabilities, type Connector, type ConnectorOptions, type ExchangeContext, type RawRecord, type SyncJob, type Tokens } from "../connector.js";
import { fetchWithBackoff, formBody, getJson, HttpError, randomToken, tokensFromResponse, type OAuthTokenResponse } from "../http.js";
import { derToP1363, fromBase64, timingSafeEqual } from "../webhook.js";
import { BaseConnector, localDayWindow, num, sample, session } from "../base.js";

export const GOOGLE_HEALTH = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  api: "https://health.googleapis.com/v4",
  keyset: "https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json",
  scopes: [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  ],
} as const;

/** Data types read on backfill, with the AIP-160 filter field for the time bound. */
export const GOOGLE_HEALTH_TYPES: Record<string, { filter: string; kind: "interval" | "sample" | "daily" | "session" }> = {
  steps: { filter: "steps.interval.start_time", kind: "interval" },
  "active-energy-burned": { filter: "active_energy_burned.interval.start_time", kind: "interval" },
  "heart-rate": { filter: "heart_rate.sample_time.physical_time", kind: "sample" },
  "daily-resting-heart-rate": { filter: "daily_resting_heart_rate.date", kind: "daily" },
  "daily-heart-rate-variability": { filter: "daily_heart_rate_variability.date", kind: "daily" },
  "daily-oxygen-saturation": { filter: "daily_oxygen_saturation.date", kind: "daily" },
  "daily-respiratory-rate": { filter: "daily_respiratory_rate.date", kind: "daily" },
  "daily-sleep-temperature-derivations": { filter: "daily_sleep_temperature_derivations.date", kind: "daily" },
  "daily-vo2-max": { filter: "daily_vo2_max.date", kind: "daily" },
  weight: { filter: "weight.sample_time.physical_time", kind: "sample" },
  sleep: { filter: "sleep.interval.end_time", kind: "session" },
  exercise: { filter: "exercise.interval.start_time", kind: "session" },
};

export interface GoogleHealthOptions extends ConnectorOptions {
  /** The endpointAuthorization.secret configured on the subscriber, e.g. "Bearer <random>". */
  webhookSecret?: string;
  /** Verify the ECDSA signature as well as the Authorization secret. Default true. */
  verifySignature?: boolean;
  /** Restrict sources, e.g. "users/me/dataSourceFamilies/google-wearables". Default: all sources. */
  dataSourceFamily?: string;
}

interface TinkKeyset {
  primaryKeyId?: number;
  key: { keyData: { typeUrl: string; value: string }; status: string; keyId: number; outputPrefixType: string }[];
}

/** "-28800s" -> -480 minutes. */
export function durationToMinutes(d: unknown): number | undefined {
  if (typeof d !== "string") return undefined;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(d);
  return m ? Math.round(Number(m[1]) / 60) : undefined;
}

const dateStr = (d: { year: number; month: number; day: number }) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** Minimal protobuf read of a Tink EcdsaPublicKey: field 3 = x, field 4 = y. */
function ecdsaXY(value: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  let i = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    for (;;) {
      const b = value[i++]!;
      r += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return r;
      shift += 7;
    }
  };
  const fields: Record<number, Uint8Array> = {};
  while (i < value.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) varint();
    else if (wire === 2) {
      const len = varint();
      fields[field] = value.slice(i, i + len);
      i += len;
    } else throw new Error("tink_unsupported_wire_type");
  }
  const fix = (b: Uint8Array | undefined) => {
    if (!b) throw new Error("tink_missing_coordinate");
    let v = b;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  return { x: fix(fields[3]), y: fix(fields[4]) };
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Import the ENABLED ECDSA keys of a Tink public keyset, keyed by keyId. */
export async function importTinkKeyset(ks: TinkKeyset): Promise<Map<number, CryptoKey>> {
  const out = new Map<number, CryptoKey>();
  for (const k of ks.key) {
    if (k.status !== "ENABLED" || !k.keyData.typeUrl.endsWith("EcdsaPublicKey")) continue;
    const { x, y } = ecdsaXY(fromBase64(k.keyData.value));
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    out.set(k.keyId >>> 0, key);
  }
  return out;
}

/** Verify a Tink-prefixed (0x01 || keyId[4] || DER) ECDSA P-256/SHA-256 signature over the raw body. */
export async function verifyTinkSignature(keys: Map<number, CryptoKey>, header: string | null, body: Uint8Array): Promise<"ok" | "bad" | "unknown_key"> {
  if (!header) return "bad";
  let sig: Uint8Array;
  try {
    sig = fromBase64(header.trim());
  } catch {
    return "bad";
  }
  if (sig.length < 6 || sig[0] !== 0x01) return "bad";
  const keyId = ((sig[1]! << 24) | (sig[2]! << 16) | (sig[3]! << 8) | sig[4]!) >>> 0;
  const key = keys.get(keyId);
  if (!key) return "unknown_key";
  let p1363: Uint8Array;
  try {
    p1363 = derToP1363(sig.slice(5));
  } catch {
    return "bad";
  }
  return (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(p1363), new Uint8Array(body))) ? "ok" : "bad";
}

export class GoogleHealthConnector extends BaseConnector implements Connector {
  readonly provider = "google-health" as const;
  readonly capabilities: Capabilities;
  private keys: Map<number, CryptoKey> | null = null;

  constructor(
    protected override readonly opts: GoogleHealthOptions,
    tier?: string,
  ) {
    super(opts);
    this.capabilities = capabilitiesFor("google-health", tier);
  }

  async authUrl(_userId: string, redirectUri: string): Promise<AuthStart> {
    const state = randomToken();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.opts.clientId,
      redirect_uri: redirectUri,
      scope: GOOGLE_HEALTH.scopes.join(" "),
      access_type: "offline",
      // Needed to get a refresh token on (re)consent. The user must first link Google Health in the mobile app.
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return { url: `${GOOGLE_HEALTH.authorize}?${q}`, state };
  }

  async exchangeCode(code: string, ctx: ExchangeContext = {}): Promise<Tokens> {
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: ctx.redirectUri, client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    // Store healthUserId: every path is /users/{healthUserId}/...; ACCOUNT_NOT_LINKED (400) means the user has not linked the app.
    const id = await getJson<{ healthUserId: string }>(this.http, `${GOOGLE_HEALTH.api}/users/me/identity`, { headers: { authorization: `Bearer ${t.access_token}` } });
    t.provider_user_id = id.healthUserId;
    return t;
  }

  /** Google normally keeps the refresh token; keep the old one when none is returned. */
  async refresh(tokens: Tokens): Promise<Tokens> {
    if (!tokens.refresh_token) throw new Error("google_health_no_refresh_token");
    const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    if (!t.refresh_token) t.refresh_token = tokens.refresh_token;
    if (tokens.provider_user_id) t.provider_user_id = tokens.provider_user_id;
    return t;
  }

  private async tokenRequest(fields: Record<string, string | undefined>): Promise<Tokens> {
    const res = await fetchWithBackoff(this.http, GOOGLE_HEALTH.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: formBody(fields) });
    if (!res.ok) throw new HttpError(res.status, GOOGLE_HEALTH.token, await res.text());
    return tokensFromResponse((await res.json()) as OAuthTokenResponse, this.clock());
  }

  /** Read one data type from the reconciled stream for [start, end). */
  async *reconcile(userId: string, dataType: string, start: string, end: string): AsyncGenerator<RawRecord> {
    const t = await this.tokensFor(userId);
    const user = t.provider_user_id ?? "me";
    const spec = GOOGLE_HEALTH_TYPES[dataType];
    if (!spec) throw new Error(`google_health_unknown_type:${dataType}`);
    // TODO(verify): daily types filter on a civil date; the docs show `daily_resting_heart_rate.date >= "2026-11-01"`.
    const lo = spec.kind === "daily" ? start.slice(0, 10) : start;
    const hi = spec.kind === "daily" ? end.slice(0, 10) : end;
    const filter = `${spec.filter} >= "${lo}" AND ${spec.filter} < "${hi}"`;
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ filter });
      if (this.opts.dataSourceFamily) q.set("dataSourceFamily", this.opts.dataSourceFamily);
      if (pageToken) q.set("pageToken", pageToken);
      const url = `${GOOGLE_HEALTH.api}/users/${encodeURIComponent(user)}/dataTypes/${dataType}/dataPoints:reconcile?${q}`;
      const page = await getJson<{ dataPoints?: unknown[]; nextPageToken?: string }>(this.http, url, { headers: { authorization: `Bearer ${t.access_token}` } });
      for (const p of page.dataPoints ?? []) yield this.raw(userId, dataType, p);
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
  }

  async *backfill(userId: string, since: string): AsyncIterable<RawRecord> {
    const start = new Date(`${since}T00:00:00Z`).toISOString();
    const end = new Date(this.clock().getTime() + 86_400_000).toISOString();
    for (const type of Object.keys(GOOGLE_HEALTH_TYPES)) yield* this.reconcile(userId, type, start, end);
  }

  // ---------- webhooks ----------

  private authorized(request: Request): boolean {
    const got = request.headers.get("authorization") ?? "";
    return !!this.opts.webhookSecret && timingSafeEqual(got, this.opts.webhookSecret);
  }

  /** Endpoint verification: {"type":"verification"}; 200 with our secret, 401 without it. */
  async challenge(request: Request): Promise<Response | null> {
    if (request.method !== "POST") return null;
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return null;
    }
    if (!body || Array.isArray(body) || (body as { type?: string }).type !== "verification") return null;
    return this.authorized(request) ? new Response(null, { status: 200 }) : new Response("unauthorized", { status: 401 });
  }

  private async loadKeys(force = false): Promise<Map<number, CryptoKey>> {
    if (this.keys && !force) return this.keys;
    const ks = await getJson<TinkKeyset>(this.http, GOOGLE_HEALTH.keyset);
    this.keys = await importTinkKeyset(ks);
    return this.keys;
  }

  async handleWebhook(request: Request): Promise<SyncJob[]> {
    if (!this.authorized(request)) throw new WebhookAuthError("google_health_authorization");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (this.opts.verifySignature !== false) {
      const header = request.headers.get("google-health-api-signature");
      let r = await verifyTinkSignature(await this.loadKeys(), header, bytes);
      if (r === "unknown_key") r = await verifyTinkSignature(await this.loadKeys(true), header, bytes); // keys rotate every 30 days
      if (r !== "ok") throw new WebhookAuthError("google_health_signature");
    }
    const items = JSON.parse(new TextDecoder().decode(bytes)) as {
      data: {
        healthUserId: string;
        operation: "UPSERT" | "DELETE";
        dataType: string;
        recordId?: string;
        intervals?: { physicalTimeInterval?: { startTime: string; endTime: string }; civilIso8601TimeInterval?: { startTime: string; endTime: string } }[];
      };
    }[];
    const jobs: SyncJob[] = [];
    for (const { data: d } of items) {
      for (const iv of d.intervals?.length ? d.intervals : [undefined]) {
        // Civil-only intervals (daily types) have no offset; widen by a day each side so the re-read covers them.
        const phys = iv?.physicalTimeInterval;
        const civil = iv?.civilIso8601TimeInterval;
        const window = phys
          ? { start: phys.startTime, end: phys.endTime }
          : civil
            ? { start: new Date(Date.parse(`${civil.startTime}Z`) - 86_400_000).toISOString(), end: new Date(Date.parse(`${civil.endTime}Z`) + 86_400_000).toISOString() }
            : undefined;
        const job: SyncJob = {
          provider: "google-health",
          action: d.operation === "DELETE" ? "delete" : "fetch",
          provider_user_id: d.healthUserId,
          data_type: d.dataType,
          dedupe_key: `google-health:${d.healthUserId}:${d.dataType}:${d.operation}:${window?.start ?? ""}:${window?.end ?? ""}:${d.recordId ?? ""}`,
        };
        if (window) job.window = window;
        if (d.recordId) job.object_id = d.recordId;
        jobs.push(job);
      }
    }
    return jobs;
  }

  // ---------- normalize ----------

  normalize(raw: RawRecord): CanonicalRecord[] {
    const p = raw.payload as Record<string, any>;
    const src = raw.source_id;
    // Reconciled points carry dataPointName; list points carry name.
    const name: string | undefined = p.dataPointName ?? p.name;
    const ext = (suffix: string) => `google-health:${name ?? `${raw.type}:${suffix}`}`;
    const tz0 = raw.tz_offset_min ?? 0;
    const out: CanonicalRecord[] = [];
    const daily = (body: any, metric: Parameters<typeof sample>[0], value: number | undefined, unit: string) => {
      if (value === undefined || !body?.date) return;
      const day = dateStr(body.date);
      const w = localDayWindow(day, tz0);
      out.push(sample(metric, value, unit, w.start, w.end, tz0, src, ext(day), "vendor_daily"));
    };
    switch (raw.type) {
      case "steps": {
        const s = p.steps;
        const v = num(s?.count);
        if (v === undefined) break;
        const tz = durationToMinutes(s.interval.startUtcOffset) ?? tz0;
        out.push(sample("steps", v, "count", s.interval.startTime, s.interval.endTime, tz, src, ext(s.interval.startTime)));
        break;
      }
      case "active-energy-burned": {
        const s = p.activeEnergyBurned;
        const v = num(s?.kcal);
        if (v === undefined) break;
        const tz = durationToMinutes(s.interval.startUtcOffset) ?? tz0;
        out.push(sample("active_energy", v, "kcal", s.interval.startTime, s.interval.endTime, tz, src, ext(s.interval.startTime)));
        break;
      }
      case "heart-rate": {
        const s = p.heartRate;
        const v = num(s?.beatsPerMinute);
        if (v === undefined) break;
        const t = s.sampleTime;
        out.push(sample("heart_rate", v, "bpm", t.physicalTime, t.physicalTime, durationToMinutes(t.utcOffset) ?? tz0, src, ext(t.physicalTime)));
        break;
      }
      case "weight": {
        const s = p.weight;
        const v = num(s?.weightGrams);
        if (v === undefined) break;
        const t = s.sampleTime;
        out.push(sample("weight", v, "g", t.physicalTime, t.physicalTime, durationToMinutes(t.utcOffset) ?? tz0, src, ext(t.physicalTime)));
        break;
      }
      case "daily-resting-heart-rate":
        daily(p.dailyRestingHeartRate, "resting_hr", num(p.dailyRestingHeartRate?.beatsPerMinute), "bpm");
        break;
      case "daily-heart-rate-variability":
        // Fitbit-derived daily HRV is RMSSD over sleep. TODO(verify): the field name does not say RMSSD explicitly.
        daily(p.dailyHeartRateVariability, "hrv_rmssd", num(p.dailyHeartRateVariability?.averageHeartRateVariabilityMilliseconds), "ms");
        break;
      case "daily-oxygen-saturation":
        daily(p.dailyOxygenSaturation, "spo2", num(p.dailyOxygenSaturation?.averagePercentage), "percent");
        break;
      case "daily-respiratory-rate":
        daily(p.dailyRespiratoryRate, "respiratory_rate", num(p.dailyRespiratoryRate?.breathsPerMinute), "breaths/min");
        break;
      case "daily-sleep-temperature-derivations": {
        const b = p.dailySleepTemperatureDerivations;
        const n = num(b?.nightlyTemperatureCelsius);
        const base = num(b?.baselineTemperatureCelsius);
        // Deviation = nightly - personal baseline, matching the catalogue's "deviation from the vendor's baseline".
        if (n !== undefined && base !== undefined) daily(b, "skin_temp_deviation", Math.round((n - base) * 1000) / 1000, "degC");
        break;
      }
      case "daily-vo2-max":
        daily(p.dailyVo2Max, "vo2max", num(p.dailyVo2Max?.vo2Max), "ml/kg/min");
        break;
      case "sleep": {
        const s = p.sleep;
        if (!s?.interval) break;
        const tz = durationToMinutes(s.interval.startUtcOffset) ?? tz0;
        const by: Record<string, number> = {};
        for (const st of s.summary?.stagesSummary ?? []) by[st.type] = num(st.minutes) ?? 0;
        const detail: SleepStagesDetail = {};
        if (s.type === "STAGES") {
          if (by.DEEP !== undefined) detail.deep_min = by.DEEP;
          if (by.LIGHT !== undefined) detail.light_min = by.LIGHT;
          if (by.REM !== undefined) detail.rem_min = by.REM;
          if (by.AWAKE !== undefined) detail.awake_min = by.AWAKE;
        } else if (num(s.summary?.minutesAwake) !== undefined) detail.awake_min = num(s.summary.minutesAwake)!;
        if (num(s.summary?.minutesInSleepPeriod) !== undefined) detail.in_bed_min = num(s.summary.minutesInSleepPeriod)!;
        out.push(session("sleep", s.interval.startTime, s.interval.endTime, tz, src, ext(s.interval.startTime), detail, s.metadata?.mainSleep ?? !s.metadata?.nap));
        break;
      }
      case "exercise": {
        const s = p.exercise;
        if (!s?.interval) break;
        const tz = durationToMinutes(s.interval.startUtcOffset) ?? tz0;
        // TODO(verify): metricsSummary field names (calories, distance, average HR) were not readable in the reference.
        const detail = { type: mapWorkoutType(s.exerciseType), ...(typeof s.displayName === "string" ? { title: s.displayName } : {}) };
        out.push(session("workout", s.interval.startTime, s.interval.endTime, tz, src, ext(s.interval.startTime), detail));
        break;
      }
    }
    return out;
  }
}
