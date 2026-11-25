// The per-user store: one SQLite database inside the user's Durable Object.
// Holds samples, sessions, daily rollups, baselines, vendor scores, receipts and counters.
import { CATALOGUE, DEVICE_PRIORITY, isPlausible, mapWorkoutType, toCatalogueUnit } from "./catalogue.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import type { Sql, SqlValue } from "./sql.js";
import { addDays, localDay, localHour } from "./time.js";
import type {
  CanonicalRecord,
  CanonicalSample,
  CanonicalSession,
  CanonicalVendorScore,
  DeviceClass,
  MetricId,
  SleepStagesDetail,
  Source,
  TermsFlags,
  WorkoutDetail,
} from "./types.js";

export const SCHEMA_VERSION = 1;

export const USER_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sources (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, device_model TEXT,
     device_class TEXT NOT NULL, connected_at TEXT NOT NULL, earliest_readable TEXT,
     last_sync_at TEXT, terms_flags TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS samples (
     user_id TEXT NOT NULL, metric TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL,
     value REAL NOT NULL, unit TEXT NOT NULL, source_id TEXT NOT NULL, method TEXT NOT NULL,
     external_id TEXT NOT NULL, tz_offset_min INTEGER NOT NULL, day TEXT NOT NULL,
     PRIMARY KEY (source_id, external_id))`,
  `CREATE INDEX IF NOT EXISTS samples_metric_day ON samples (metric, source_id, day)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     user_id TEXT NOT NULL, session_kind TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL,
     source_id TEXT NOT NULL, external_id TEXT NOT NULL, tz_offset_min INTEGER NOT NULL,
     day TEXT NOT NULL, is_main INTEGER, detail TEXT NOT NULL,
     PRIMARY KEY (source_id, external_id))`,
  `CREATE INDEX IF NOT EXISTS sessions_kind_day ON sessions (session_kind, source_id, day)`,
  `CREATE TABLE IF NOT EXISTS daily_rollups (
     user_id TEXT NOT NULL, metric TEXT NOT NULL, source_id TEXT NOT NULL, day TEXT NOT NULL,
     value REAL, coverage REAL NOT NULL, extra TEXT,
     PRIMARY KEY (metric, source_id, day))`,
  `CREATE TABLE IF NOT EXISTS baselines (
     user_id TEXT NOT NULL, metric TEXT NOT NULL, source_id TEXT NOT NULL, as_of_day TEXT NOT NULL,
     median REAL, q1 REAL, q3 REAL, iqr REAL, n_days INTEGER NOT NULL, window_days INTEGER NOT NULL,
     PRIMARY KEY (metric, source_id))`,
  `CREATE TABLE IF NOT EXISTS vendor_scores (
     user_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL,
     day TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
     PRIMARY KEY (source_id, external_id))`,
  `CREATE TABLE IF NOT EXISTS receipts (
     seq INTEGER PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, time TEXT NOT NULL, agent_id TEXT NOT NULL,
     grant_id TEXT, decision TEXT NOT NULL, level INTEGER, packet_hash TEXT, payload_hash TEXT NOT NULL,
     payload_enc TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS packets (
     packet_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, packet_enc TEXT NOT NULL,
     PRIMARY KEY (packet_id, agent_id))`,
];

export function migrate(sql: Sql): void {
  for (const s of USER_SCHEMA) sql.run(s);
  const v = getMeta(sql, "schema_version");
  if (!v) setMeta(sql, "schema_version", String(SCHEMA_VERSION));
}

export function getMeta(sql: Sql, k: string): string | null {
  return sql.all<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k)[0]?.v ?? null;
}
export function setMeta(sql: Sql, k: string, v: string): void {
  sql.run(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
}

export function getDataVersion(sql: Sql): string {
  return getMeta(sql, "data_version") ?? "sha256:empty";
}

// ---------- sources ----------

interface SourceRow {
  id: string; user_id: string; provider: string; device_model: string | null; device_class: string;
  connected_at: string; earliest_readable: string | null; last_sync_at: string | null; terms_flags: string; enabled: number;
}

export function upsertSource(sql: Sql, userId: string, s: Source): void {
  sql.run(
    `INSERT INTO sources (id, user_id, provider, device_model, device_class, connected_at, earliest_readable, last_sync_at, terms_flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, device_model = excluded.device_model,
       device_class = excluded.device_class, earliest_readable = COALESCE(excluded.earliest_readable, sources.earliest_readable),
       last_sync_at = COALESCE(excluded.last_sync_at, sources.last_sync_at), terms_flags = excluded.terms_flags`,
    s.id, userId, s.provider, s.device_model, s.device_class, s.connected_at, s.earliest_readable, s.last_sync_at,
    canonicalJson(s.terms_flags ?? {}),
  );
}

export function listSources(sql: Sql): (Source & { enabled: boolean })[] {
  return sql.all<SourceRow & Record<string, SqlValue>>(`SELECT * FROM sources ORDER BY id`).map((r) => ({
    id: r.id,
    provider: r.provider,
    device_model: r.device_model,
    device_class: r.device_class as DeviceClass,
    connected_at: r.connected_at,
    earliest_readable: r.earliest_readable,
    last_sync_at: r.last_sync_at,
    terms_flags: JSON.parse(r.terms_flags) as TermsFlags,
    enabled: r.enabled === 1,
  }));
}

export function touchSource(sql: Sql, sourceId: string, syncedAt: string): void {
  sql.run(`UPDATE sources SET last_sync_at = ? WHERE id = ? AND (last_sync_at IS NULL OR last_sync_at < ?)`, syncedAt, sourceId, syncedAt);
}

export function sourcePriority(cls: DeviceClass): number {
  const i = DEVICE_PRIORITY.indexOf(cls);
  return i < 0 ? DEVICE_PRIORITY.length : i;
}

// ---------- ingest ----------

export interface IngestResult {
  written: number;
  unchanged: number;
  rejected: { index: number; reason: string }[];
  days_recomputed: number;
  data_version: string;
}

interface Dirty { source_id: string; day: string }

/**
 * Normalize and upsert records. Idempotent on (source_id, external_id): re-importing the same data
 * writes nothing and leaves data_version unchanged.
 */
export async function ingest(sql: Sql, userId: string, records: CanonicalRecord[], opts: { syncedAt?: string } = {}): Promise<IngestResult> {
  const knownSources = new Set(listSources(sql).map((s) => s.id));
  const rejected: IngestResult["rejected"] = [];
  const prepared: { rec: CanonicalRecord; externalId: string; canon: unknown }[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    try {
      if (!knownSources.has(r.source_id)) throw new Error("unknown_source");
      const norm = normalizeRecord(r);
      const externalId = r.external_id ?? (await sha256Hex(canonicalJson(norm))).slice(0, 32);
      prepared.push({ rec: norm, externalId, canon: norm });
    } catch (e) {
      rejected.push({ index: i, reason: (e as Error).message });
    }
  }

  const dirty = new Map<string, Dirty>();
  const changedHashes: string[] = [];
  let written = 0;
  let unchanged = 0;

  for (const p of prepared) {
    const n = writeRecord(sql, userId, p.rec, p.externalId);
    if (n > 0) {
      written++;
      changedHashes.push(canonicalJson([p.rec.source_id, p.externalId, p.canon]));
      for (const d of affectedDays(p.rec)) dirty.set(`${d.source_id}|${d.day}`, d);
    } else unchanged++;
  }

  let dataVersion = getDataVersion(sql);
  if (changedHashes.length) {
    changedHashes.sort();
    dataVersion = `sha256:${await sha256Hex(dataVersion + "\n" + changedHashes.join("\n"))}`;
    sql.transaction(() => {
      for (const d of dirty.values()) recomputeDay(sql, userId, d.source_id, d.day);
      setMeta(sql, "data_version", dataVersion);
    });
    refreshBaselines(sql, userId, [...new Set([...dirty.values()].map((d) => d.source_id))]);
  }
  if (opts.syncedAt) for (const s of new Set(prepared.map((p) => p.rec.source_id))) touchSource(sql, s, opts.syncedAt);

  return { written, unchanged, rejected, days_recomputed: dirty.size, data_version: dataVersion };
}

function iso(s: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad_timestamp`);
  return new Date(t).toISOString();
}

/** Convert units, check ranges, canonicalize timestamps and workout types. */
export function normalizeRecord(r: CanonicalRecord): CanonicalRecord {
  if (r.kind === "sample") {
    const def = CATALOGUE[r.metric];
    if (!def) throw new Error(`unknown_metric:${String(r.metric)}`);
    const value = toCatalogueUnit(r.metric, r.value, r.unit);
    if (!isPlausible(r.metric, value)) throw new Error(`implausible:${r.metric}`);
    if (!Number.isInteger(r.tz_offset_min) || Math.abs(r.tz_offset_min) > 14 * 60) throw new Error("bad_offset");
    const start = iso(r.start);
    const end = iso(r.end);
    if (end < start) throw new Error("end_before_start");
    const out: CanonicalSample = { kind: "sample", metric: r.metric, start, end, value: round6(value), unit: def.unit, source_id: r.source_id, method: r.method, tz_offset_min: r.tz_offset_min };
    if (r.external_id) out.external_id = r.external_id;
    return out;
  }
  if (r.kind === "session") {
    const start = iso(r.start);
    const end = iso(r.end);
    if (end <= start) throw new Error("end_before_start");
    if ((Date.parse(end) - Date.parse(start)) / 3_600_000 > 36) throw new Error("session_too_long");
    let detail: SleepStagesDetail | WorkoutDetail;
    if (r.session_kind === "workout") {
      const w = r.detail as WorkoutDetail;
      detail = { ...w, type: mapWorkoutType(w.type) };
    } else detail = { ...(r.detail as SleepStagesDetail) };
    const out: CanonicalSession = { kind: "session", session_kind: r.session_kind, start, end, source_id: r.source_id, tz_offset_min: r.tz_offset_min, detail };
    if (r.is_main !== undefined) out.is_main = r.is_main;
    if (r.external_id) out.external_id = r.external_id;
    return out;
  }
  if (r.kind === "vendor_score") {
    if (!Number.isFinite(r.value)) throw new Error("bad_value");
    return { ...r };
  }
  throw new Error("unknown_kind");
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function writeRecord(sql: Sql, userId: string, r: CanonicalRecord, externalId: string): number {
  if (r.kind === "sample") {
    const day = localDay(r.start, r.tz_offset_min);
    return sql.run(
      `INSERT INTO samples (user_id, metric, start, "end", value, unit, source_id, method, external_id, tz_offset_min, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET metric = excluded.metric, start = excluded.start, "end" = excluded."end",
         value = excluded.value, unit = excluded.unit, method = excluded.method, tz_offset_min = excluded.tz_offset_min, day = excluded.day
       WHERE samples.value IS NOT excluded.value OR samples.start IS NOT excluded.start OR samples."end" IS NOT excluded."end"
         OR samples.metric IS NOT excluded.metric OR samples.tz_offset_min IS NOT excluded.tz_offset_min OR samples.method IS NOT excluded.method`,
      userId, r.metric, r.start, r.end, r.value, r.unit, r.source_id, r.method, externalId, r.tz_offset_min, day,
    );
  }
  if (r.kind === "session") {
    // Sleep is attributed to the wake date; workouts to the local start date.
    const day = r.session_kind === "sleep" ? localDay(r.end, r.tz_offset_min) : localDay(r.start, r.tz_offset_min);
    const detail = canonicalJson(r.detail);
    return sql.run(
      `INSERT INTO sessions (user_id, session_kind, start, "end", source_id, external_id, tz_offset_min, day, is_main, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET session_kind = excluded.session_kind, start = excluded.start, "end" = excluded."end",
         tz_offset_min = excluded.tz_offset_min, day = excluded.day, is_main = excluded.is_main, detail = excluded.detail
       WHERE sessions.start IS NOT excluded.start OR sessions."end" IS NOT excluded."end" OR sessions.detail IS NOT excluded.detail
         OR sessions.is_main IS NOT excluded.is_main OR sessions.tz_offset_min IS NOT excluded.tz_offset_min`,
      userId, r.session_kind, r.start, r.end, r.source_id, externalId, r.tz_offset_min, day, r.is_main === undefined ? null : r.is_main ? 1 : 0, detail,
    );
  }
  const v = r as CanonicalVendorScore;
  return sql.run(
    `INSERT INTO vendor_scores (user_id, provider, name, value, day, source_id, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, external_id) DO UPDATE SET value = excluded.value, day = excluded.day, name = excluded.name
     WHERE vendor_scores.value IS NOT excluded.value OR vendor_scores.day IS NOT excluded.day`,
    userId, v.provider, v.name, v.value, v.day, v.source_id, externalId,
  );
}

function affectedDays(r: CanonicalRecord): Dirty[] {
  if (r.kind === "vendor_score") return [];
  const out: Dirty[] = [];
  const a = localDay(r.start, r.tz_offset_min);
  const b = localDay(r.end, r.tz_offset_min);
  for (let d = a; d <= b; d = addDays(d, 1)) out.push({ source_id: r.source_id, day: d });
  // A sample at night may belong to the next wake day.
  out.push({ source_id: r.source_id, day: addDays(b, 1) });
  return out;
}

// ---------- rollups ----------

/** Expected hours of data per day for intraday metrics; coverage = hours with data / expected, capped at 1. */
const EXPECTED_HOURS: Partial<Record<MetricId, number>> = { steps: 12, active_energy: 12, heart_rate: 16, blood_glucose: 20 };
export const MIN_COVERAGE = 0.6;

interface SampleRow { metric: string; start: string; end: string; value: number; tz_offset_min: number; method: string; day: string }
interface SessionRow { session_kind: string; start: string; end: string; tz_offset_min: number; day: string; is_main: number | null; detail: string; external_id: string }

function mainSleep(sql: Sql, sourceId: string, day: string): SessionRow | null {
  const rows = sql.all<SessionRow & Record<string, SqlValue>>(
    `SELECT session_kind, start, "end", tz_offset_min, day, is_main, detail, external_id FROM sessions
     WHERE session_kind = 'sleep' AND source_id = ? AND day = ?`, sourceId, day);
  if (!rows.length) return null;
  const flagged = rows.filter((r) => r.is_main === 1);
  const pool = flagged.length ? flagged : rows.filter((r) => r.is_main !== 0);
  if (!pool.length) return null;
  return pool.sort((a, b) => dur(b) - dur(a) || a.external_id.localeCompare(b.external_id))[0]!;
}

const dur = (r: { start: string; end: string }) => (Date.parse(r.end) - Date.parse(r.start)) / 60_000;

function asleepMinutes(s: SessionRow): { asleep: number; inBed: number; stages: SleepStagesDetail } {
  const d = JSON.parse(s.detail) as SleepStagesDetail;
  const inBed = d.in_bed_min ?? dur(s);
  const staged = (d.deep_min ?? 0) + (d.light_min ?? 0) + (d.rem_min ?? 0);
  const asleep = staged > 0 ? staged : Math.max(0, dur(s) - (d.awake_min ?? 0));
  return { asleep, inBed, stages: d };
}

function hoursCovered(rows: SampleRow[], day: string): number {
  const hours = new Set<number>();
  for (const r of rows) {
    const spanH = (Date.parse(r.end) - Date.parse(r.start)) / 3_600_000;
    if (spanH >= 20) return 24; // a whole-day summary value
    const h0 = localHour(r.start, r.tz_offset_min);
    // The last instant inside the interval, so a 10:00-11:00 sample covers hour 10 only.
    const lastIso = new Date(Math.max(Date.parse(r.start), Date.parse(r.end) - 1)).toISOString();
    const h1 = localDay(lastIso, r.tz_offset_min) === day ? localHour(lastIso, r.tz_offset_min) : 23;
    for (let h = h0; h <= Math.max(h0, h1); h++) hours.add(h);
  }
  return hours.size;
}

/** Recompute every metric's rollup for one source and local day. */
export function recomputeDay(sql: Sql, userId: string, sourceId: string, day: string): void {
  sql.run(`DELETE FROM daily_rollups WHERE source_id = ? AND day = ?`, sourceId, day);
  const put = (metric: MetricId, value: number | null, coverage: number, extra?: unknown) =>
    sql.run(`INSERT INTO daily_rollups (user_id, metric, source_id, day, value, coverage, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      userId, metric, sourceId, day, value === null ? null : round6(value), round6(Math.min(1, coverage)), extra === undefined ? null : canonicalJson(extra));

  const daySamples = sql.all<SampleRow & Record<string, SqlValue>>(
    `SELECT metric, start, "end", value, tz_offset_min, method, day FROM samples WHERE source_id = ? AND day = ? ORDER BY start, external_id`, sourceId, day);
  const byMetric = new Map<string, SampleRow[]>();
  for (const s of daySamples) (byMetric.get(s.metric) ?? byMetric.set(s.metric, []).get(s.metric)!).push(s);

  const sleep = mainSleep(sql, sourceId, day);
  const nightSamples = (metric: MetricId): SampleRow[] => {
    if (sleep) {
      const rows = sql.all<SampleRow & Record<string, SqlValue>>(
        `SELECT metric, start, "end", value, tz_offset_min, method, day FROM samples WHERE source_id = ? AND metric = ? AND start >= ? AND start <= ? ORDER BY start`,
        sourceId, metric, sleep.start, sleep.end);
      if (rows.length) return rows;
    }
    // Vendor nightly values, or measured samples on this day that are not inside some other night.
    const nights = sql.all<{ start: string; end: string }>(
      `SELECT start, "end" FROM sessions WHERE session_kind = 'sleep' AND source_id = ? AND day IN (?, ?)`, sourceId, day, addDays(day, 1));
    return (byMetric.get(metric) ?? []).filter(
      (r) => r.method === "vendor_daily" || (!sleep && !nights.some((n) => r.start >= n.start && r.start <= n.end)),
    );
  };

  for (const [id, def] of Object.entries(CATALOGUE) as [MetricId, (typeof CATALOGUE)[MetricId]][]) {
    const rows = byMetric.get(id) ?? [];
    switch (def.daily) {
      case "sum": {
        if (!rows.length) break;
        const daily = rows.filter((r) => r.method === "vendor_daily");
        const value = daily.length ? daily[daily.length - 1]!.value : rows.reduce((a, r) => a + r.value, 0);
        const cov = daily.length ? 1 : hoursCovered(rows, day) / (EXPECTED_HOURS[id] ?? 16);
        put(id, value, cov);
        break;
      }
      case "mean": {
        if (!rows.length) break;
        const vals = rows.map((r) => r.value);
        put(id, mean(vals), hoursCovered(rows, day) / (EXPECTED_HOURS[id] ?? 16), { min: Math.min(...vals), max: Math.max(...vals), n: vals.length });
        break;
      }
      case "latest": {
        if (!rows.length) break;
        put(id, rows[rows.length - 1]!.value, 1);
        break;
      }
      case "night_mean": {
        const ns = nightSamples(id);
        if (!ns.length) break;
        put(id, mean(ns.map((r) => r.value)), 1);
        break;
      }
      case "resting": {
        const vendor = rows.filter((r) => r.method === "vendor_daily");
        if (vendor.length) { put(id, vendor[vendor.length - 1]!.value, 1, { method: "vendor_daily" }); break; }
        const hr = byMetric.get("heart_rate") ?? [];
        if (!hr.length) break;
        const buckets = new Map<number, number[]>();
        for (const r of hr) {
          const t = Date.parse(r.start) + r.tz_offset_min * 60_000;
          const b = Math.floor(t / 1_800_000);
          (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(r.value);
        }
        const means = [...buckets.values()].filter((v) => v.length >= 3).map(mean);
        if (!means.length) break;
        put(id, Math.min(...means), hoursCovered(hr, day) / 16, { method: "lowest_30min_mean" });
        break;
      }
      case "main_sleep": {
        if (sleep) { put(id, asleepMinutes(sleep).asleep, 1); break; }
        const v = rows.filter((r) => r.method === "vendor_daily" || r.method === "measured");
        if (v.length) put(id, v.reduce((a, r) => a + r.value, 0), 1);
        break;
      }
      case "sleep_efficiency": {
        if (rows.length) { put(id, rows[rows.length - 1]!.value, 1); break; }
        if (sleep) {
          const { asleep, inBed } = asleepMinutes(sleep);
          if (inBed > 0) put(id, Math.min(100, (asleep / inBed) * 100), 1);
        }
        break;
      }
      case "sleep_stages": {
        if (!sleep) break;
        const { asleep, stages } = asleepMinutes(sleep);
        if ((stages.deep_min ?? 0) + (stages.rem_min ?? 0) + (stages.light_min ?? 0) === 0) break;
        put(id, asleep, 1, { deep_min: stages.deep_min ?? 0, light_min: stages.light_min ?? 0, rem_min: stages.rem_min ?? 0, awake_min: stages.awake_min ?? 0 });
        break;
      }
      case "workout": {
        const ws = sql.all<SessionRow & Record<string, SqlValue>>(
          `SELECT session_kind, start, "end", tz_offset_min, day, is_main, detail, external_id FROM sessions WHERE session_kind = 'workout' AND source_id = ? AND day = ?`, sourceId, day);
        if (!ws.length) break;
        let load = 0;
        const types: Record<string, number> = {};
        for (const w of ws) {
          const d = JSON.parse(w.detail) as WorkoutDetail;
          load += d.load ?? 0;
          types[d.type] = (types[d.type] ?? 0) + 1;
        }
        put(id, ws.reduce((a, w) => a + dur(w), 0), 1, { count: ws.length, load: round6(load), types });
        break;
      }
    }
  }
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------- baselines ----------

export const BASELINE_WINDOW = 28;
export const BASELINE_MIN_DAYS = 14;

export interface Baseline {
  metric: MetricId; source_id: string; as_of_day: string;
  median: number; q1: number; q3: number; iqr: number; n_days: number; window_days: number;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Personal baseline for a metric and source as of a day: median and IQR over the trailing 28 days
 * before that day, valid (coverage >= 60%) days only, needing at least 14.
 */
export function baselineAsOf(sql: Sql, metric: MetricId, sourceId: string, asOfDay: string): Baseline | { insufficient: true; n_days: number } {
  const rows = sql.all<{ value: number }>(
    `SELECT value FROM daily_rollups WHERE metric = ? AND source_id = ? AND day >= ? AND day < ? AND coverage >= ? AND value IS NOT NULL`,
    metric, sourceId, addDays(asOfDay, -BASELINE_WINDOW), asOfDay, MIN_COVERAGE);
  if (rows.length < BASELINE_MIN_DAYS) return { insufficient: true, n_days: rows.length };
  const vals = rows.map((r) => r.value).sort((a, b) => a - b);
  const q1 = quantile(vals, 0.25);
  const q3 = quantile(vals, 0.75);
  return { metric, source_id: sourceId, as_of_day: asOfDay, median: quantile(vals, 0.5), q1, q3, iqr: q3 - q1, n_days: rows.length, window_days: BASELINE_WINDOW };
}

/** Persist the current baseline per metric and source, for the console. Packets compute their own as-of baseline. */
export function refreshBaselines(sql: Sql, userId: string, sourceIds: string[]): void {
  for (const sid of sourceIds) {
    const metrics = sql.all<{ metric: string; last: string }>(`SELECT metric, MAX(day) AS last FROM daily_rollups WHERE source_id = ? GROUP BY metric`, sid);
    for (const { metric, last } of metrics) {
      const b = baselineAsOf(sql, metric as MetricId, sid, addDays(last, 1));
      if ("insufficient" in b) {
        sql.run(`DELETE FROM baselines WHERE metric = ? AND source_id = ?`, metric, sid);
        continue;
      }
      sql.run(
        `INSERT INTO baselines (user_id, metric, source_id, as_of_day, median, q1, q3, iqr, n_days, window_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(metric, source_id) DO UPDATE SET as_of_day = excluded.as_of_day, median = excluded.median, q1 = excluded.q1, q3 = excluded.q3,
           iqr = excluded.iqr, n_days = excluded.n_days, window_days = excluded.window_days`,
        userId, metric, sid, b.as_of_day, b.median, b.q1, b.q3, b.iqr, b.n_days, b.window_days);
    }
  }
}

export type DeviationResult = { bucket: "within" | "slightly" | "moderately" | "far"; direction: "above" | "below" | "within" };

/** Where a value sits against the usual range [q1, q3]: within, slightly, moderately or far outside. */
export function deviation(value: number, b: Pick<Baseline, "q1" | "q3" | "iqr" | "median">): DeviationResult {
  if (value >= b.q1 && value <= b.q3) return { bucket: "within", direction: "within" };
  const scale = Math.max(b.iqr, Math.abs(b.median) * 0.02, 1e-6);
  const dist = value < b.q1 ? (b.q1 - value) / scale : (value - b.q3) / scale;
  const direction = value < b.q1 ? "below" : "above";
  if (dist <= 0.5) return { bucket: "slightly", direction };
  if (dist <= 1.5) return { bucket: "moderately", direction };
  return { bucket: "far", direction };
}

// ---------- delete ----------

/** Delete everything for this user. The DO also calls storage.deleteAll() and drops its data key. */
export function deleteAllHealthData(sql: Sql): void {
  for (const t of ["samples", "sessions", "daily_rollups", "baselines", "vendor_scores", "sources", "counters", "nonces", "packets"]) sql.run(`DELETE FROM ${t}`);
  // Receipts keep their rows (hash chain) but lose their encrypted payloads: crypto-erasure.
  sql.run(`UPDATE receipts SET payload_enc = NULL`);
  sql.run(`DELETE FROM secrets`);
  setMeta(sql, "data_version", "sha256:empty");
}
