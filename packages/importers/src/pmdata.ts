// PMData (Thambawita et al., MMSys'20; Fitbit Versa 2; https://datasets.simula.no/pmdata/).
// One folder per participant (p01..p16) with fitbit/*.json, pmsys/*.csv and googledocs/reporting.csv.
// Fitbit timestamps are local wall-clock times without an offset ("2019-11-01 00:00:00"); the
// participants were in Norway, so the default zone is Europe/Oslo.
//
//   steps.json               [{"dateTime":"2019-11-01 00:00:00","value":"0"}, ...]           steps per minute
//   heart_rate.json          [{"dateTime":"...","value":{"bpm":54,"confidence":3}}, ...]     every few seconds
//   resting_heart_rate.json  [{"dateTime":"2019-11-01 00:00:00","value":{"date":"11/01/19","value":53.7,"error":6.8}}]
//   sleep.json               [{logId, dateOfSleep, startTime, endTime, duration (ms), minutesAsleep, minutesAwake,
//                              timeInBed, efficiency, type: "stages"|"classic", mainSleep, levels.summary{deep,light,rem,wake}}]
//   exercise.json            [{logId, activityName, startTime, duration (ms), calories, averageHeartRate,
//                              distance, distanceUnit ("Kilometer"), steps, ...}]
//   calories.json            calories per minute INCLUDING basal burn; not imported (the catalogue holds active energy only).
//   googledocs/reporting.csv date (dd/mm/yyyy), weight (kg), ...
import type { CanonicalRecord, Source } from "@askwearables/core";
import { type ImportBatch, type ImportStats, type TimeZoneOption, bump, round, textChunks, toNumber, wallMs, wallToUtc } from "./common.js";
import { parseCsv } from "./csv.js";

export const PMDATA_PROVIDER = "fitbit_pmdata";
export const PMDATA_DEFAULT_TZ = "Europe/Oslo";

type Text = string | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> | ReadableStream<Uint8Array>;

export interface PmdataFiles {
  "steps.json"?: Text;
  "heart_rate.json"?: Text;
  "resting_heart_rate.json"?: string;
  "sleep.json"?: string;
  "exercise.json"?: string;
  "reporting.csv"?: string;
}

export interface PmdataOptions {
  participant: string;
  tz?: TimeZoneOption;
  connectedAt?: string;
}

export function pmdataSource(o: PmdataOptions): Source {
  return {
    id: `pmdata_${o.participant}`,
    provider: PMDATA_PROVIDER,
    device_model: "Fitbit Versa 2",
    device_class: "watch",
    connected_at: o.connectedAt ?? "2019-11-01T00:00:00.000Z",
    earliest_readable: null,
    last_sync_at: null,
    terms_flags: {},
  };
}

/**
 * Scan a large flat JSON array of {"dateTime": ..., "value": ...} objects chunk by chunk, without parsing
 * the whole document. Calls back with the wall time and the numeric value (value, or value.bpm).
 */
export async function scanMinuteArray(input: Text, cb: (wall: string, value: number) => void): Promise<number> {
  const re = /"dateTime"\s*:\s*"([^"]+)"\s*,\s*"value"\s*:\s*(?:"([^"]*)"|\{\s*"bpm"\s*:\s*([-\d.]+)|([-\d.]+))/g;
  let buf = "";
  let n = 0;
  for await (const chunk of textChunks(input)) {
    buf += chunk;
    re.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf))) {
      // A match that runs to the end of the buffer might be cut short; leave it for the next chunk.
      if (re.lastIndex >= buf.length - 1) break;
      const v = Number(m[2] ?? m[3] ?? m[4]);
      if (Number.isFinite(v)) {
        cb(m[1]!, v);
        n++;
      }
      last = re.lastIndex;
    }
    buf = buf.slice(last);
    // Keep the buffer bounded even when a chunk holds no complete object.
    if (buf.length > 1 << 20) buf = buf.slice(buf.length - 4096);
  }
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    const v = Number(m[2] ?? m[3] ?? m[4]);
    if (Number.isFinite(v)) {
      cb(m[1]!, v);
      n++;
    }
  }
  return n;
}

const msKm: Record<string, number> = { Kilometer: 1000, Mile: 1609.344, Meter: 1 };

/** Import one PMData participant. Steps are summed per local hour (hours with no steps are left out); heart rate is averaged per minute. */
export async function importPmdata(files: PmdataFiles, o: PmdataOptions): Promise<ImportBatch & { stats: ImportStats }> {
  const tz = o.tz ?? PMDATA_DEFAULT_TZ;
  const src = pmdataSource(o);
  const sid = src.id;
  const stats: ImportStats = { records: 0, skipped: {} };
  const records: CanonicalRecord[] = [];

  if (files["steps.json"]) {
    const hours = new Map<string, number>();
    await scanMinuteArray(files["steps.json"], (wall, v) => {
      const h = wall.slice(0, 13);
      hours.set(h, (hours.get(h) ?? 0) + v);
    });
    for (const [h, v] of hours) {
      if (v <= 0) {
        bump(stats, "steps_zero_hour");
        continue;
      }
      const s = wallToUtc(`${h}:00:00`, tz);
      const e = wallToUtc(wallMs(`${h}:00:00`) + 3_600_000, tz);
      records.push({ kind: "sample", metric: "steps", start: s.iso, end: e.iso, value: v, unit: "count", source_id: sid, method: "measured", external_id: `steps:${h}`, tz_offset_min: s.offset });
    }
  }

  if (files["heart_rate.json"]) {
    const minutes = new Map<string, [number, number]>();
    await scanMinuteArray(files["heart_rate.json"], (wall, bpm) => {
      const k = wall.slice(0, 16);
      const a = minutes.get(k);
      if (a) {
        a[0] += bpm;
        a[1]++;
      } else minutes.set(k, [bpm, 1]);
    });
    for (const [k, [sum, n]] of minutes) {
      const s = wallToUtc(`${k}:00`, tz);
      const e = wallToUtc(wallMs(`${k}:00`) + 60_000, tz);
      records.push({ kind: "sample", metric: "heart_rate", start: s.iso, end: e.iso, value: round(sum / n, 2), unit: "bpm", source_id: sid, method: "measured", external_id: `hr:${k}`, tz_offset_min: s.offset });
    }
  }

  if (files["resting_heart_rate.json"]) {
    for (const r of JSON.parse(files["resting_heart_rate.json"]) as { dateTime: string; value: { value: number } }[]) {
      const v = r.value?.value;
      if (!v) {
        bump(stats, "resting_hr_zero");
        continue;
      }
      const day = r.dateTime.slice(0, 10);
      const s = wallToUtc(`${day} 00:00:00`, tz);
      const e = wallToUtc(`${day} 23:59:59`, tz);
      records.push({ kind: "sample", metric: "resting_hr", start: s.iso, end: e.iso, value: round(v, 2), unit: "bpm", source_id: sid, method: "vendor_daily", external_id: `rhr:${day}`, tz_offset_min: s.offset });
    }
  }

  if (files["sleep.json"]) {
    type Lvl = { minutes: number };
    for (const r of JSON.parse(files["sleep.json"]) as {
      logId: number; startTime: string; endTime: string; minutesAwake: number; timeInBed: number; type: string; mainSleep?: boolean;
      levels?: { summary?: Record<string, Lvl> };
    }[]) {
      const s = wallToUtc(r.startTime, tz);
      const e = wallToUtc(r.endTime, tz);
      const sum = r.levels?.summary ?? {};
      const detail: Record<string, number> = { in_bed_min: r.timeInBed };
      if (r.type === "stages") {
        detail.deep_min = sum.deep?.minutes ?? 0;
        detail.light_min = sum.light?.minutes ?? 0;
        detail.rem_min = sum.rem?.minutes ?? 0;
        detail.awake_min = sum.wake?.minutes ?? r.minutesAwake;
      } else {
        // Classic logs: asleep / restless / awake only. Restless counts as awake time.
        detail.awake_min = (sum.awake?.minutes ?? 0) + (sum.restless?.minutes ?? 0) || r.minutesAwake;
      }
      const rec: CanonicalRecord = { kind: "session", session_kind: "sleep", start: s.iso, end: e.iso, source_id: sid, external_id: `sleep:${r.logId}`, tz_offset_min: e.offset, detail };
      if (typeof r.mainSleep === "boolean") rec.is_main = r.mainSleep;
      records.push(rec);
    }
  }

  if (files["exercise.json"]) {
    for (const r of JSON.parse(files["exercise.json"]) as {
      logId: number; activityName: string; startTime: string; duration: number; calories?: number; averageHeartRate?: number; distance?: number; distanceUnit?: string;
    }[]) {
      if (!r.duration || r.duration <= 0) {
        bump(stats, "exercise_no_duration");
        continue;
      }
      const s = wallToUtc(r.startTime, tz);
      const e = wallToUtc(wallMs(r.startTime) + r.duration, tz);
      const detail: Record<string, string | number> = { type: r.activityName, title: r.activityName };
      if (r.calories) detail.energy_kcal = r.calories;
      if (r.averageHeartRate) detail.avg_hr = r.averageHeartRate;
      if (r.distance && r.distanceUnit && msKm[r.distanceUnit]) detail.distance_m = round(r.distance * msKm[r.distanceUnit]!, 1);
      records.push({ kind: "session", session_kind: "workout", start: s.iso, end: e.iso, source_id: sid, external_id: `exercise:${r.logId}`, tz_offset_min: s.offset, detail: detail as never });
    }
  }

  if (files["reporting.csv"]) {
    for (const r of parseCsv(files["reporting.csv"])) {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r.date?.trim() ?? "");
      const w = toNumber(r.weight);
      if (!m || w === null) {
        bump(stats, "reporting_row_skipped");
        continue;
      }
      const day = `${m[3]}-${m[2]}-${m[1]}`;
      const s = wallToUtc(`${day} 12:00:00`, tz);
      records.push({ kind: "sample", metric: "weight", start: s.iso, end: s.iso, value: w, unit: "kg", source_id: sid, method: "manual", external_id: `weight:${day}`, tz_offset_min: s.offset });
    }
  }

  stats.records = records.length;
  return { sources: [src], records, stats };
}
