// LifeSnaps (Yfantidou et al., Sci Data 2022; Fitbit Sense; Zenodo record 7229547, CC BY 4.0), CSV variant:
//   csv_rais_anonymized/daily_fitbit_sema_df_unprocessed.csv   one row per participant (`id`) and `date`
//   csv_rais_anonymized/hourly_fitbit_sema_df_unprocessed.csv  one row per participant, `date` and `hour` (0.0-23.0)
// Daily columns used: rmssd, spo2, full_sleep_breathing_rate, resting_hr, filteredDemographicVO2Max, steps,
// minutesAsleep, minutesAwake, sleep_duration (ms, time in bed), sleep_efficiency, stress_score.
// Hourly columns used: steps, bpm (mean heart rate in the hour).
// The descriptor says timestamps are stored in local time and the users' UTC offsets are withheld, so local
// dates are kept as written (offset 0). The CSV has no sleep start/end times, so sleep arrives as vendor
// daily values on `date` (taken to be Fitbit's dateOfSleep, the wake date), not as sessions.
// Not imported: calories (includes basal burn), temperature columns (nightly_temperature is absolute and the
// meaning of daily_temperature_variation is not documented precisely enough), SEMA mood/context columns.
import type { CanonicalRecord, MetricId, Source } from "@askwearables/core";
import { type ImportBatch, type ImportStats, bump, round, textChunks, toNumber } from "./common.js";
import { csvObjects } from "./csv.js";

export const LIFESNAPS_PROVIDER = "fitbit_lifesnaps";

type Text = string | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> | ReadableStream<Uint8Array>;

export interface LifeSnapsOptions {
  /** Only import these participant ids (the `id` column). Default: all. */
  participants?: string[];
  connectedAt?: string;
}

export function lifesnapsSource(participant: string, o: LifeSnapsOptions = {}): Source {
  return {
    id: `lifesnaps_${participant}`,
    provider: LIFESNAPS_PROVIDER,
    device_model: "Fitbit Sense",
    device_class: "watch",
    connected_at: o.connectedAt ?? "2021-05-01T00:00:00.000Z",
    earliest_readable: null,
    last_sync_at: null,
    terms_flags: {},
  };
}

const DAILY: [string, MetricId, string][] = [
  ["rmssd", "hrv_rmssd", "ms"],
  ["spo2", "spo2", "percent"],
  ["full_sleep_breathing_rate", "respiratory_rate", "breaths/min"],
  ["resting_hr", "resting_hr", "bpm"],
  ["filteredDemographicVO2Max", "vo2max", "ml/kg/min"],
  ["steps", "steps", "count"],
  ["minutesAsleep", "sleep_duration", "minutes"],
  ["sleep_efficiency", "sleep_efficiency", "percent"],
];

export type LifeSnapsResult = Map<string, ImportBatch & { stats: ImportStats }>;

function batchFor(out: LifeSnapsResult, id: string, o: LifeSnapsOptions) {
  let b = out.get(id);
  if (!b) {
    b = { sources: [lifesnapsSource(id, o)], records: [], stats: { records: 0, skipped: {} } };
    out.set(id, b);
  }
  return b;
}

/** Import the daily CSV; returns one batch per participant. Streams the file. */
export async function importLifeSnapsDaily(input: Text, o: LifeSnapsOptions = {}, out: LifeSnapsResult = new Map()): Promise<LifeSnapsResult> {
  const only = o.participants ? new Set(o.participants) : null;
  for await (const r of csvObjects(textChunks(input))) {
    const id = r.id?.trim();
    const day = r.date?.trim();
    if (!id || !day || (only && !only.has(id))) continue;
    const b = batchFor(out, id, o);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      bump(b.stats, "bad_date");
      continue;
    }
    const sid = b.sources[0]!.id;
    const start = `${day}T00:00:00.000Z`;
    const end = `${day}T23:59:59.000Z`;
    for (const [col, metric, unit] of DAILY) {
      const v = toNumber(r[col]);
      if (v === null) continue;
      // Fitbit writes 0 for "no reading" (e.g. rmssd, breathing rate on nights it could not measure).
      if (metric !== "steps" && v <= 0) {
        bump(b.stats, `zero_as_missing:${col}`);
        continue;
      }
      b.records.push({ kind: "sample", metric, start, end, value: round(v, 4), unit, source_id: sid, method: "vendor_daily", external_id: `d:${col}:${day}`, tz_offset_min: 0 });
    }
    const stress = toNumber(r.stress_score);
    if (stress !== null && stress > 0) b.records.push({ kind: "vendor_score", provider: LIFESNAPS_PROVIDER, name: "stress_score", value: stress, day, source_id: sid, external_id: `stress:${day}` });
  }
  for (const b of out.values()) b.stats.records = b.records.length;
  return out;
}

/** Import the hourly CSV (steps and mean heart rate per hour); merges into `out` when given. */
export async function importLifeSnapsHourly(input: Text, o: LifeSnapsOptions = {}, out: LifeSnapsResult = new Map()): Promise<LifeSnapsResult> {
  const only = o.participants ? new Set(o.participants) : null;
  for await (const r of csvObjects(textChunks(input))) {
    const id = r.id?.trim();
    const day = r.date?.trim();
    if (!id || !day || (only && !only.has(id))) continue;
    const b = batchFor(out, id, o);
    const hour = toNumber(r.hour);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || hour === null || hour < 0 || hour > 23) {
      bump(b.stats, "bad_hour");
      continue;
    }
    const sid = b.sources[0]!.id;
    const h = String(hour).padStart(2, "0");
    const start = `${day}T${h}:00:00.000Z`;
    const end = new Date(Date.parse(start) + 3_600_000).toISOString();
    const steps = toNumber(r.steps);
    if (steps !== null && steps > 0) b.records.push({ kind: "sample", metric: "steps", start, end, value: steps, unit: "count", source_id: sid, method: "measured", external_id: `h:steps:${day}:${h}`, tz_offset_min: 0 });
    const bpm = toNumber(r.bpm);
    if (bpm !== null && bpm > 0) b.records.push({ kind: "sample", metric: "heart_rate", start, end, value: round(bpm, 2), unit: "bpm", source_id: sid, method: "measured", external_id: `h:bpm:${day}:${h}`, tz_offset_min: 0 });
  }
  for (const b of out.values()) b.stats.records = b.records.length;
  return out;
}


