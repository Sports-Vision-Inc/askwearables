// Shared plumbing for provider connectors: injected deps, source ids, time conversion and record builders.
import { parseOffset } from "@askwearables/core";
export { localDay } from "@askwearables/core";
import type { CanonicalSample, CanonicalSession, CanonicalVendorScore, MetricId, Method, SleepStagesDetail, WorkoutDetail } from "@askwearables/core";
import type { ConnectorOptions, ProviderId, RawRecord, Tokens } from "./connector.js";
import { realSleep, type HttpDeps } from "./http.js";

export abstract class BaseConnector {
  abstract readonly provider: ProviderId;
  protected readonly http: HttpDeps;
  protected readonly clock: () => Date;

  constructor(protected readonly opts: ConnectorOptions) {
    this.clock = opts.clock ?? (() => new Date());
    const deps: HttpDeps = {
      fetch: opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      clock: this.clock,
      sleep: opts.sleep ?? realSleep,
    };
    if (opts.backoff) deps.backoff = opts.backoff;
    this.http = deps;
  }

  protected sourceId(userId: string): string {
    return this.opts.sourceIdFor?.(userId) ?? `${this.provider}:${userId}`;
  }

  protected async tokensFor(userId: string): Promise<Tokens> {
    if (!this.opts.getTokens) throw new Error(`no_token_source:${this.provider}`);
    return this.opts.getTokens(userId);
  }

  protected raw(userId: string, type: string, payload: unknown, tz?: number): RawRecord {
    const r: RawRecord = {
      provider: this.provider,
      type,
      user_id: userId,
      source_id: this.sourceId(userId),
      payload,
      received_at: this.clock().toISOString(),
    };
    const off = tz ?? this.opts.tzOffsetFor?.(userId);
    if (off !== undefined) r.tz_offset_min = off;
    return r;
  }
}

// ---------- time ----------

/** Offset (minutes east of UTC) carried at the end of an ISO 8601 timestamp. Throws if there is none. */
export function offsetFromIso(s: string): number {
  const m = /(Z|z|[+-]\d{2}:?\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`no_offset:${s}`);
  return parseOffset(m[1]!);
}

export function isoUtc(s: string | number): string {
  const t = typeof s === "number" ? s : Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad_timestamp:${s}`);
  return new Date(t).toISOString();
}

export const fromEpochSeconds = (s: number) => new Date(s * 1000).toISOString();

/** UTC instant of local midnight at the start of `date` (YYYY-MM-DD) for a fixed offset. */
export function localMidnightUtc(date: string, offsetMin: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - offsetMin * 60_000).toISOString();
}

/** Daily window [local midnight, next local midnight) as UTC. */
export function localDayWindow(date: string, offsetMin: number): { start: string; end: string } {
  const start = localMidnightUtc(date, offsetMin);
  return { start, end: new Date(Date.parse(start) + 86_400_000).toISOString() };
}

/** "+02:00" style offset label from minutes. */
export function offsetLabel(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Local wall time "YYYY-MM-DDTHH:MM:SS" (no zone) plus offset minutes -> UTC ISO. */
export function localToUtc(local: string, offsetMin: number): string {
  return new Date(Date.parse(`${local.replace(/Z$/, "")}Z`) - offsetMin * 60_000).toISOString();
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

// ---------- record builders ----------

export function sample(
  metric: MetricId,
  value: number,
  unit: string,
  start: string,
  end: string,
  tz: number,
  source_id: string,
  external_id: string,
  method: Method = "measured",
): CanonicalSample {
  return { kind: "sample", metric, start: isoUtc(start), end: isoUtc(end), value, unit, source_id, method, external_id, tz_offset_min: tz };
}

export function session(
  session_kind: "sleep" | "workout",
  start: string,
  end: string,
  tz: number,
  source_id: string,
  external_id: string,
  detail: SleepStagesDetail | WorkoutDetail,
  is_main?: boolean,
): CanonicalSession {
  const s: CanonicalSession = { kind: "session", session_kind, start: isoUtc(start), end: isoUtc(end), source_id, external_id, tz_offset_min: tz, detail };
  if (is_main !== undefined) s.is_main = is_main;
  return s;
}

export function vendorScore(provider: string, name: string, value: number, day: string, source_id: string, external_id: string): CanonicalVendorScore {
  return { kind: "vendor_score", provider, name, value, day, source_id, external_id };
}

/** Drop undefined fields so canonical output compares cleanly. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
