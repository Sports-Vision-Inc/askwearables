// Apple Health export.xml importer: a streaming parser that never holds the whole file.
//
//   const imp = new AppleHealthImporter();
//   for await (const chunk of file.stream().pipeThrough(new TextDecoderStream())) {
//     const batch = imp.push(chunk);   // { sources, records }
//     ...register batch.sources, then ingest batch.records
//   }
//   const last = imp.end();
//
// Or use importAppleHealth(stream) to get batches of a fixed size.
import type { CanonicalRecord, CanonicalSample, CanonicalSession, MetricId, Source } from "@askwearables/core";
import { type ImportBatch, type ImportStats, bump, fnv1a, inferDeviceClass, parseOffsetTimestamp, round, textChunks } from "./common.js";
import { XmlStream } from "./xml.js";

export const APPLE_PROVIDER = "apple_health";

/** Quantity types imported, with the catalogue metric and the method. */
const QUANTITY: Record<string, { metric: MetricId; method: CanonicalSample["method"] }> = {
  HKQuantityTypeIdentifierStepCount: { metric: "steps", method: "measured" },
  HKQuantityTypeIdentifierActiveEnergyBurned: { metric: "active_energy", method: "measured" },
  HKQuantityTypeIdentifierHeartRate: { metric: "heart_rate", method: "measured" },
  // Apple computes resting heart rate itself, about once a day.
  HKQuantityTypeIdentifierRestingHeartRate: { metric: "resting_hr", method: "vendor_daily" },
  // Apple reports SDNN, never RMSSD.
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { metric: "hrv_sdnn", method: "measured" },
  HKQuantityTypeIdentifierOxygenSaturation: { metric: "spo2", method: "measured" },
  HKQuantityTypeIdentifierRespiratoryRate: { metric: "respiratory_rate", method: "measured" },
  HKQuantityTypeIdentifierVO2Max: { metric: "vo2max", method: "measured" },
  HKQuantityTypeIdentifierBodyMass: { metric: "weight", method: "measured" },
  // Absolute wrist temperature; converted to a deviation below.
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: { metric: "skin_temp_deviation", method: "derived" },
};

const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

type Stage = "in_bed" | "awake" | "core" | "deep" | "rem" | "asleep";
const SLEEP_VALUE: Record<string, Stage> = {
  HKCategoryValueSleepAnalysisInBed: "in_bed",
  HKCategoryValueSleepAnalysisAwake: "awake",
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "rem",
  HKCategoryValueSleepAnalysisAsleep: "asleep",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleep",
};

/** Two sleep samples from one source this far apart or less belong to the same night. */
export const SLEEP_MERGE_GAP_MIN = 90;
/** Wrist temperature deviation needs this many earlier nights from the same source. */
export const WRIST_TEMP_MIN_NIGHTS = 5;
const WRIST_TEMP_WINDOW = 28;

export interface AppleHealthOptions {
  /** Records per emitted batch for importAppleHealth (default 5000). */
  batchSize?: number;
  /** Connected-at timestamp for new sources (default: now). */
  connectedAt?: string;
}

interface OpenSleep {
  sourceId: string;
  startMs: number;
  endMs: number;
  endOffset: number;
  minutes: Record<Stage, number>;
  inBed: [number, number][];
  /** Span of the non-in-bed samples. */
  sleepStart: number;
  sleepEnd: number;
}

interface OpenWorkout {
  attrs: Record<string, string>;
  stats: Record<string, Record<string, string>>;
}

/** Parse the HKDevice description: "<<HKDevice: 0x..>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:9.1>". */
export function parseDevice(device: string | undefined): { name?: string; manufacturer?: string; model?: string; hardware?: string } {
  if (!device) return {};
  const out: Record<string, string> = {};
  for (const part of device.replace(/^<+HKDevice:[^>]*>,?/, "").replace(/>+$/, "").split(/,\s*(?=[a-zA-Z]+:)/)) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Remove a possessive owner name ("Varun’s Apple Watch" → "Apple Watch"), so ids and models carry no personal names. */
function stripOwner(s: string): string {
  return s.replace(/^.*?['’`]s\s+/, "").trim();
}

export class AppleHealthImporter {
  readonly stats: ImportStats = { records: 0, skipped: {} };
  private readonly xml: XmlStream;
  private readonly sources = new Map<string, Source>();
  private readonly sourceIds = new Map<string, string>();
  private newSources: Source[] = [];
  private out: CanonicalRecord[] = [];
  private openSleep = new Map<string, OpenSleep>();
  private workout: OpenWorkout | null = null;
  private wristTemps = new Map<string, number[]>();
  private readonly connectedAt: string;

  constructor(opts: AppleHealthOptions = {}) {
    this.connectedAt = opts.connectedAt ?? new Date().toISOString();
    this.xml = new XmlStream({ open: (n, a, sc) => this.onOpen(n, a, sc), close: (n) => this.onClose(n) });
  }

  /** Feed the next chunk of export.xml. Returns the sources first seen and the records completed by this chunk. */
  push(chunk: string): ImportBatch {
    this.xml.push(chunk);
    return this.drain();
  }

  /** Finish: flushes sleep sessions still open. */
  end(): ImportBatch {
    this.xml.end();
    for (const s of this.openSleep.values()) this.emitSleep(s);
    this.openSleep.clear();
    return this.drain();
  }

  /** Every source seen so far. */
  allSources(): Source[] {
    return [...this.sources.values()];
  }

  /** Bytes of unparsed input currently buffered (should stay small). */
  get maxBuffered(): number {
    return this.xml.maxBuffered;
  }

  private drain(): ImportBatch {
    const b = { sources: this.newSources, records: this.out };
    this.newSources = [];
    this.out = [];
    this.stats.records += b.records.length;
    return b;
  }

  private sourceFor(a: Record<string, string>): string {
    const dev = parseDevice(a.device);
    const sourceName = a.sourceName ?? "unknown";
    const key = `${sourceName}|${dev.name ?? ""}|${dev.model ?? ""}|${dev.hardware ?? ""}`;
    const known = this.sourceIds.get(key);
    if (known) return known;
    const hash = fnv1a(key);
    const cls = inferDeviceClass(dev.model, dev.hardware, dev.name, stripOwner(sourceName));
    const id = `ah_${cls}_${hash}`;
    const model = dev.hardware ?? dev.model ?? (dev.name ? stripOwner(dev.name) : null) ?? stripOwner(sourceName);
    const src: Source = {
      id,
      provider: APPLE_PROVIDER,
      device_model: model || null,
      device_class: cls,
      connected_at: this.connectedAt,
      earliest_readable: null,
      last_sync_at: null,
      terms_flags: {},
    };
    this.sources.set(id, src);
    this.sourceIds.set(key, id);
    this.newSources.push(src);
    return id;
  }

  private onOpen(name: string, a: Record<string, string>, selfClosing: boolean): void {
    if (name === "Record") return this.onRecord(a);
    if (name === "Workout") {
      this.workout = { attrs: a, stats: {} };
      if (selfClosing) return; // close() follows immediately
      return;
    }
    if (this.workout && name === "WorkoutStatistics" && a.type) this.workout.stats[a.type] = a;
  }

  private onClose(name: string): void {
    if (name === "Workout" && this.workout) {
      this.emitWorkout(this.workout);
      this.workout = null;
    }
  }

  private onRecord(a: Record<string, string>): void {
    const type = a.type ?? "";
    if (type === SLEEP_TYPE) return this.onSleep(a);
    const q = QUANTITY[type];
    if (!q) return bump(this.stats, `type_not_imported:${type.replace(/^HK(Quantity|Category)TypeIdentifier/, "")}`);
    let start, end;
    try {
      start = parseOffsetTimestamp(a.startDate ?? "");
      end = parseOffsetTimestamp(a.endDate ?? a.startDate ?? "");
    } catch {
      return bump(this.stats, "bad_timestamp");
    }
    let value = Number(a.value);
    if (!Number.isFinite(value)) return bump(this.stats, "bad_value");
    let unit = a.unit ?? "";
    const sourceId = this.sourceFor(a);
    // Apple writes oxygen saturation as a fraction with unit "%".
    if (q.metric === "spo2" && value <= 1) unit = "fraction";
    if (q.metric === "skin_temp_deviation") {
      const c = unit === "degF" ? (value - 32) * (5 / 9) : value;
      const dev = this.wristDeviation(sourceId, c);
      if (dev === null) return bump(this.stats, "wrist_temp_baseline_building");
      value = round(dev, 3);
      unit = "degC";
    }
    const rec: CanonicalSample = {
      kind: "sample",
      metric: q.metric,
      start: start.iso,
      end: end.iso,
      value,
      unit,
      source_id: sourceId,
      method: q.method,
      external_id: `${type.replace("HKQuantityTypeIdentifier", "")}:${start.ms}:${end.ms}:${a.value}`,
      tz_offset_min: start.offset,
    };
    this.out.push(rec);
  }

  /**
   * Apple exports absolute sleeping wrist temperature; the Health app's own baseline is not exported.
   * Deviation = value minus the median of up to 28 earlier nights from the same source (needs 5).
   */
  private wristDeviation(sourceId: string, celsius: number): number | null {
    const hist = this.wristTemps.get(sourceId) ?? [];
    let dev: number | null = null;
    if (hist.length >= WRIST_TEMP_MIN_NIGHTS) {
      const s = [...hist].sort((x, y) => x - y);
      const mid = s.length >> 1;
      const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
      dev = celsius - median;
    }
    hist.push(celsius);
    if (hist.length > WRIST_TEMP_WINDOW) hist.shift();
    this.wristTemps.set(sourceId, hist);
    return dev;
  }

  private onSleep(a: Record<string, string>): void {
    const stage = SLEEP_VALUE[a.value ?? ""];
    if (!stage) return bump(this.stats, "sleep_value_unknown");
    let start, end;
    try {
      start = parseOffsetTimestamp(a.startDate ?? "");
      end = parseOffsetTimestamp(a.endDate ?? "");
    } catch {
      return bump(this.stats, "bad_timestamp");
    }
    if (end.ms <= start.ms) return bump(this.stats, "sleep_zero_length");
    const sourceId = this.sourceFor(a);
    let open = this.openSleep.get(sourceId);
    const gap = SLEEP_MERGE_GAP_MIN * 60_000;
    if (open && (start.ms > open.endMs + gap || end.ms < open.startMs - gap)) {
      this.emitSleep(open);
      open = undefined;
    }
    if (!open) {
      open = {
        sourceId, startMs: start.ms, endMs: end.ms, endOffset: end.offset,
        minutes: { in_bed: 0, awake: 0, core: 0, deep: 0, rem: 0, asleep: 0 }, inBed: [],
        sleepStart: Infinity, sleepEnd: -Infinity,
      };
      this.openSleep.set(sourceId, open);
    }
    open.startMs = Math.min(open.startMs, start.ms);
    if (end.ms >= open.endMs) {
      open.endMs = end.ms;
      open.endOffset = end.offset;
    }
    const mins = (end.ms - start.ms) / 60_000;
    if (stage === "in_bed") open.inBed.push([start.ms, end.ms]);
    else {
      open.minutes[stage] += mins;
      open.sleepStart = Math.min(open.sleepStart, start.ms);
      open.sleepEnd = Math.max(open.sleepEnd, end.ms);
    }
  }

  private emitSleep(s: OpenSleep): void {
    const m = s.minutes;
    const staged = m.core + m.deep + m.rem;
    const hasSleep = staged + m.asleep > 0;
    // The session spans the asleep and awake samples when there are any; in-bed only nights use the in-bed span.
    const startMs = hasSleep ? s.sleepStart : s.startMs;
    const endMs = hasSleep ? s.sleepEnd : s.endMs;
    if (!hasSleep && !s.inBed.length) return;
    const inBed = unionMinutes(s.inBed);
    const detail: CanonicalSession["detail"] = {};
    const d = detail as Record<string, number>;
    if (staged > 0) {
      d.deep_min = round(m.deep, 2);
      d.rem_min = round(m.rem, 2);
      // Unstaged "asleep" time inside a staged night is counted with core (light) sleep.
      d.light_min = round(m.core + m.asleep, 2);
    }
    d.awake_min = round(m.awake, 2);
    if (inBed > 0) d.in_bed_min = round(Math.max(inBed, (endMs - startMs) / 60_000), 2);
    if (!hasSleep) {
      bump(this.stats, "sleep_in_bed_only");
      return;
    }
    // A session whose stages leave no asleep time reads as zero; skip rather than store a misleading night.
    if (staged === 0 && (endMs - startMs) / 60_000 - m.awake <= 0) return bump(this.stats, "sleep_no_asleep_time");
    const startIso = new Date(startMs).toISOString();
    this.out.push({
      kind: "session",
      session_kind: "sleep",
      start: startIso,
      end: new Date(endMs).toISOString(),
      source_id: s.sourceId,
      external_id: `sleep:${startMs}`,
      tz_offset_min: s.endOffset,
      detail,
    });
  }

  private emitWorkout(w: OpenWorkout): void {
    const a = w.attrs;
    let start, end;
    try {
      start = parseOffsetTimestamp(a.startDate ?? "");
      end = parseOffsetTimestamp(a.endDate ?? "");
    } catch {
      return bump(this.stats, "bad_timestamp");
    }
    if (end.ms <= start.ms) return bump(this.stats, "workout_zero_length");
    const sourceId = this.sourceFor(a);
    const energyStat = w.stats.HKQuantityTypeIdentifierActiveEnergyBurned;
    const energy = numberIn(energyStat?.sum, energyStat?.unit) ?? numberIn(a.totalEnergyBurned, a.totalEnergyBurnedUnit);
    const distStat = w.stats.HKQuantityTypeIdentifierDistanceWalkingRunning ?? w.stats.HKQuantityTypeIdentifierDistanceCycling ?? w.stats.HKQuantityTypeIdentifierDistanceSwimming;
    const dist = meters(distStat?.sum, distStat?.unit) ?? meters(a.totalDistance, a.totalDistanceUnit);
    const hr = Number(w.stats.HKQuantityTypeIdentifierHeartRate?.average);
    const detail: Record<string, string | number> = { type: a.workoutActivityType ?? "other" };
    if (energy !== null && energy > 0) detail.energy_kcal = round(energy, 1);
    if (dist !== null && dist > 0) detail.distance_m = round(dist, 1);
    if (Number.isFinite(hr) && hr > 0) detail.avg_hr = round(hr, 1);
    this.out.push({
      kind: "session",
      session_kind: "workout",
      start: start.iso,
      end: end.iso,
      source_id: sourceId,
      external_id: `workout:${start.ms}:${a.workoutActivityType ?? ""}`,
      tz_offset_min: start.offset,
      detail: detail as unknown as CanonicalSession["detail"],
    });
  }
}

function numberIn(v: string | undefined, unit: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (unit === "kJ") return n * 0.239006;
  if (unit === "cal") return n / 1000;
  return n; // kcal, Cal
}

function meters(v: string | undefined, unit: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  switch (unit) {
    case "km": return n * 1000;
    case "mi": return n * 1609.344;
    case "yd": return n * 0.9144;
    case "ft": return n * 0.3048;
    case "cm": return n / 100;
    default: return n; // m
  }
}

function unionMinutes(spans: [number, number][]): number {
  if (!spans.length) return 0;
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = s[0]!;
  for (const [a, b] of s.slice(1)) {
    if (a <= ce) ce = Math.max(ce, b);
    else {
      total += ce - cs;
      cs = a;
      ce = b;
    }
  }
  return (total + ce - cs) / 60_000;
}

/**
 * Stream an export.xml (string, chunks, or a ReadableStream of bytes) and yield batches of at most
 * `batchSize` records. Each batch lists the sources first seen in it; register them before ingesting.
 */
export async function* importAppleHealth(
  input: string | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> | ReadableStream<Uint8Array>,
  opts: AppleHealthOptions = {},
): AsyncGenerator<ImportBatch & { stats: ImportStats }> {
  const imp = new AppleHealthImporter(opts);
  const size = opts.batchSize ?? 5000;
  let pending: ImportBatch = { sources: [], records: [] };
  const take = function* (b: ImportBatch, final: boolean) {
    pending.sources.push(...b.sources);
    pending.records.push(...b.records);
    while (pending.records.length >= size || (final && (pending.records.length || pending.sources.length))) {
      const records = pending.records.splice(0, size);
      yield { sources: pending.sources.splice(0), records, stats: imp.stats };
      if (final && !pending.records.length) break;
    }
  };
  for await (const chunk of textChunks(input)) yield* take(imp.push(chunk), false);
  yield* take(imp.end(), true);
}
