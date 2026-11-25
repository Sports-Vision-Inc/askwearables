// MMASH (Rossi et al., PhysioNet, ODbL 1.0): 22 people, 24 hours each.
// Per user folder: RR.csv (",ibi_s,day,time": seconds between beats, recording day 1 or 2, clock time) and
// sleep.csv (",In Bed Date,In Bed Time,Out Bed Date,Out Bed Time,...": dates are recording days 1/2, times HH:MM).
// The recordings carry no calendar dates or offsets, so day 1 is mapped to `baseDate` at offset 0.
//
// HRV is computed from beat-to-beat intervals here, and RMSSD and SDNN stay separate metrics:
//   RMSSD = sqrt(mean((RR[i+1] - RR[i])^2)) over successive clean beats
//   SDNN  = sample standard deviation (n - 1) of the clean RR intervals
// Cleaning: keep 300-2000 ms intervals; drop an interval more than 20% away from the previous kept one
// (a common ectopic-beat rule). A difference counts for RMSSD only when both beats are consecutive in the raw series.
import type { CanonicalRecord, Source } from "@askwearables/core";
import { type ImportBatch, type ImportStats, bump, round, toNumber } from "./common.js";
import { parseCsv } from "./csv.js";

export const MMASH_PROVIDER = "mmash";

export interface RrBeat {
  /** Milliseconds since the start of day 1. */
  t: number;
  /** Interval in milliseconds. */
  rr: number;
}

export interface Hrv {
  rmssd: number;
  sdnn: number;
  beats: number;
  pairs: number;
  rejected: number;
}

/** Keep plausible beats; returns beats with a flag for whether the previous raw beat was kept too. */
export function cleanRr(beats: RrBeat[], opts: { min?: number; max?: number; maxJump?: number } = {}): { beat: RrBeat; consecutive: boolean }[] {
  const min = opts.min ?? 300;
  const max = opts.max ?? 2000;
  const jump = opts.maxJump ?? 0.2;
  const out: { beat: RrBeat; consecutive: boolean }[] = [];
  let prevKept: RrBeat | null = null;
  let prevRawKept = false;
  for (const b of beats) {
    const ok = b.rr >= min && b.rr <= max && (!prevKept || Math.abs(b.rr - prevKept.rr) <= jump * prevKept.rr);
    if (ok) {
      out.push({ beat: b, consecutive: prevRawKept });
      prevKept = b;
    }
    prevRawKept = ok;
  }
  return out;
}

export function rmssd(rr: number[]): number {
  if (rr.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < rr.length; i++) s += (rr[i]! - rr[i - 1]!) ** 2;
  return Math.sqrt(s / (rr.length - 1));
}

export function sdnn(rr: number[]): number {
  if (rr.length < 2) return NaN;
  const m = rr.reduce((a, b) => a + b, 0) / rr.length;
  return Math.sqrt(rr.reduce((a, b) => a + (b - m) ** 2, 0) / (rr.length - 1));
}

/** RMSSD and SDNN (ms) from raw beats, after cleaning. */
export function hrvFromBeats(raw: RrBeat[]): Hrv {
  const clean = cleanRr(raw);
  const rr = clean.map((c) => c.beat.rr);
  let s = 0;
  let pairs = 0;
  for (let i = 1; i < clean.length; i++) {
    if (!clean[i]!.consecutive) continue;
    s += (clean[i]!.beat.rr - clean[i - 1]!.beat.rr) ** 2;
    pairs++;
  }
  return { rmssd: pairs ? Math.sqrt(s / pairs) : NaN, sdnn: sdnn(rr), beats: rr.length, pairs, rejected: raw.length - rr.length };
}

const clock = (day: number, hms: string) => {
  const [h, m, s] = hms.split(":").map(Number);
  return ((day - 1) * 24 * 3600 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
};

export function parseRr(text: string): RrBeat[] {
  const out: RrBeat[] = [];
  for (const r of parseCsv(text)) {
    const ibi = toNumber(r.ibi_s);
    const day = toNumber(r.day);
    if (ibi === null || day === null || !r.time) continue;
    out.push({ t: clock(day, r.time), rr: ibi * 1000 });
  }
  return out;
}

export interface MmashOptions {
  user: string;
  /** Calendar date for recording day 1 (default 2026-01-01). */
  baseDate?: string;
  connectedAt?: string;
}

export function mmashSource(o: MmashOptions): Source {
  return { id: `mmash_${o.user}`, provider: MMASH_PROVIDER, device_model: "Polar H7 + ActiGraph wGT3X-BT", device_class: "other", connected_at: o.connectedAt ?? "2026-01-01T00:00:00.000Z", earliest_readable: null, last_sync_at: null, terms_flags: {} };
}

/**
 * Import one MMASH user: one sleep session spanning the in-bed periods of sleep.csv, and the night's
 * RMSSD and SDNN computed from the RR intervals inside those periods, as two separate derived samples.
 */
export function importMmash(rrCsv: string, sleepCsv: string, o: MmashOptions): ImportBatch & { stats: ImportStats; night?: Hrv & { start: string; end: string } } {
  const src = mmashSource(o);
  const base = Date.parse(`${o.baseDate ?? "2026-01-01"}T00:00:00Z`);
  const stats: ImportStats = { records: 0, skipped: {} };
  const records: CanonicalRecord[] = [];
  const periods: [number, number][] = [];
  let tib = 0;
  for (const r of parseCsv(sleepCsv)) {
    const d0 = toNumber(r["In Bed Date"]);
    const d1 = toNumber(r["Out Bed Date"]);
    if (d0 === null || d1 === null || !r["In Bed Time"] || !r["Out Bed Time"]) continue;
    const a = clock(d0, `${r["In Bed Time"]}:00`);
    const b = clock(d1, `${r["Out Bed Time"]}:00`);
    if (b > a) {
      periods.push([a, b]);
      tib += (b - a) / 60_000;
    }
  }
  if (!periods.length) {
    bump(stats, "no_sleep_record");
    return { sources: [src], records, stats };
  }
  const start = Math.min(...periods.map((p) => p[0]));
  const end = Math.max(...periods.map((p) => p[1]));
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const beats = parseRr(rrCsv).filter((b) => periods.some(([a, z]) => b.t >= a && b.t <= z));
  const hrv = hrvFromBeats(beats);
  records.push({
    kind: "session", session_kind: "sleep", start: iso(start), end: iso(end), source_id: src.id, external_id: `sleep:${o.user}`, tz_offset_min: 0, is_main: true,
    detail: { in_bed_min: round(tib, 2), awake_min: round((end - start) / 60_000 - tib, 2) },
  });
  if (Number.isFinite(hrv.rmssd) && Number.isFinite(hrv.sdnn)) {
    const sample = (metric: "hrv_rmssd" | "hrv_sdnn", value: number): CanonicalRecord => ({
      kind: "sample", metric, start: iso(start), end: iso(end), value: round(value, 3), unit: "ms", source_id: src.id, method: "derived", external_id: `${metric}:${o.user}`, tz_offset_min: 0,
    });
    records.push(sample("hrv_rmssd", hrv.rmssd), sample("hrv_sdnn", hrv.sdnn));
  } else bump(stats, "too_few_beats");
  stats.records = records.length;
  return { sources: [src], records, stats, night: { ...hrv, start: iso(start), end: iso(end) } };
}
