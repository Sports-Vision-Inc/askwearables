// PHIA synthetic wearable users (Merrill et al., github.com/yahskapar/personal-health-insights-agent, CC BY-NC 4.0).
// Two CSVs per user:
//   summary_df_<id>.csv  one row per day: pseudo_id2, datetime, age, gender, weight_kg, resting_heart_rate,
//                        heart_rate_variability, fatburn/cardio/peak_active_zone_minutes, active_zone_minutes, steps,
//                        rem/deep/awake/light_sleep_minutes, sleep_minutes, bed_time, wake_up_time,
//                        stress_management_score, deep/rem/awake/light_sleep_percent, height_cm
//   exercise_df_<id>.csv one row per workout: pseudo_id2, date, duration (minutes), activityName, startTime, endTime,
//                        averageHeartRate, elevationGain, distance, calories, steps, activeZoneMinutes, speed
// Timestamps are naive local times. A summary row's sleep columns describe the night that STARTS on `datetime`
// (bed_time is on that date or just after midnight; wake_up_time is the next morning); our store attributes
// sleep to the wake date, so those nights land on datetime + 1.
import type { CanonicalRecord, Source } from "@askwearables/core";
import { type ImportBatch, type ImportStats, type TimeZoneOption, bump, round, toNumber, wallMs, wallToUtc } from "./common.js";
import { parseCsv } from "./csv.js";

export const PHIA_PROVIDER = "phia_synthetic";

export interface PhiaOptions {
  /** Time zone for the naive timestamps; default UTC (0), which keeps every local date as written. */
  tz?: TimeZoneOption;
  sourceId?: string;
  connectedAt?: string;
}

export function phiaSource(opts: PhiaOptions = {}): Source {
  return {
    id: opts.sourceId ?? "phia_fitbit",
    provider: PHIA_PROVIDER,
    device_model: "Fitbit (synthetic)",
    device_class: "band",
    connected_at: opts.connectedAt ?? "2023-01-01T00:00:00.000Z",
    earliest_readable: null,
    last_sync_at: null,
    terms_flags: {},
  };
}

/** Import one PHIA synthetic user from the text of its summary and exercise CSVs. */
export function importPhia(summaryCsv: string, exerciseCsv: string | null, opts: PhiaOptions = {}): ImportBatch & { stats: ImportStats } {
  const tz = opts.tz ?? 0;
  const src = phiaSource(opts);
  const sid = src.id;
  const stats: ImportStats = { records: 0, skipped: {} };
  const records: CanonicalRecord[] = [];
  const at = (wall: string) => wallToUtc(wall, tz);

  for (const r of parseCsv(summaryCsv)) {
    const day = (r.datetime ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      bump(stats, "bad_date");
      continue;
    }
    const d0 = at(`${day} 00:00:00`);
    const d1 = at(`${day} 23:59:59`);
    // A vendor daily value covering the local day.
    const daily = (metric: "steps" | "resting_hr" | "hrv_rmssd", col: string, unit: string) => {
      const v = toNumber(r[col]);
      if (v === null) return bump(stats, `missing:${col}`);
      records.push({ kind: "sample", metric, start: d0.iso, end: d1.iso, value: v, unit, source_id: sid, method: "vendor_daily", external_id: `${metric}:${day}`, tz_offset_min: d0.offset });
    };
    daily("steps", "steps", "count");
    daily("resting_hr", "resting_heart_rate", "bpm");
    // Fitbit's daily HRV is RMSSD measured during sleep.
    daily("hrv_rmssd", "heart_rate_variability", "ms");
    const w = toNumber(r.weight_kg);
    if (w !== null) records.push({ kind: "sample", metric: "weight", start: d0.iso, end: d0.iso, value: w, unit: "kg", source_id: sid, method: "manual", external_id: `weight:${day}`, tz_offset_min: d0.offset });
    const stress = toNumber(r.stress_management_score);
    if (stress !== null) records.push({ kind: "vendor_score", provider: PHIA_PROVIDER, name: "stress_management", value: stress, day, source_id: sid, external_id: `stress:${day}` });

    const bed = r.bed_time?.trim();
    const wake = r.wake_up_time?.trim();
    if (bed && wake) {
      const b = at(bed);
      const e = at(wake);
      if (Date.parse(e.iso) <= Date.parse(b.iso)) bump(stats, "sleep_end_before_start");
      else {
        const detail: Record<string, number> = {};
        const put = (k: string, col: string) => {
          const v = toNumber(r[col]);
          if (v !== null) detail[k] = v;
        };
        put("deep_min", "deep_sleep_minutes");
        put("rem_min", "rem_sleep_minutes");
        put("light_min", "light_sleep_minutes");
        put("awake_min", "awake_minutes");
        // PHIA's sleep_minutes is deep + rem + light + awake: time in bed, not time asleep.
        put("in_bed_min", "sleep_minutes");
        records.push({ kind: "session", session_kind: "sleep", start: b.iso, end: e.iso, source_id: sid, external_id: `sleep:${day}`, tz_offset_min: e.offset, is_main: true, detail });
      }
    } else bump(stats, "missing:sleep");
  }

  if (exerciseCsv) {

    for (const r of parseCsv(exerciseCsv)) {

      const startWall = r.startTime?.trim();
      const dur = toNumber(r.duration);
      if (!startWall || dur === null || dur <= 0) {
        bump(stats, "bad_exercise");
        continue;
      }
      const s = at(startWall);
      // `duration` is the recorded length; endTime is rounded to the minute and sometimes disagrees, so use start + duration.
      const e = wallToUtc(wallMs(startWall) + dur * 60_000, tz);
      const detail: Record<string, string | number> = { type: r.activityName?.trim() || "other" };
      const hr = toNumber(r.averageHeartRate);
      const kcal = toNumber(r.calories);
      const dist = toNumber(r.distance);
      if (hr !== null && hr > 0) detail.avg_hr = hr;
      if (kcal !== null) detail.energy_kcal = kcal;
      // Units of PHIA's distance column are not documented; stored as given.
      if (dist !== null && dist > 0) detail.distance_m = round(dist, 2);
      // Keep the provider's own activity name (free text, level 3 only).
      detail.title = r.activityName?.trim() ?? "";
      records.push({ kind: "session", session_kind: "workout", start: s.iso, end: e.iso, source_id: sid, external_id: `workout:${startWall}:${String(detail.type)}`, tz_offset_min: s.offset, detail: detail as never });
    }
  }
  stats.records = records.length;
  return { sources: [src], records, stats };
}
