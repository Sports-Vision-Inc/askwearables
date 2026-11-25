// The compute engine: a closed set of eight operations over the user's store, in fixed, tested code.
// It produces every level's view of each finding; the packet builder picks one level and drops the rest.
import { CATALOGUE, toCatalogueUnit } from "./catalogue.js";
import { cap, dayNoun, fmtValue, label, roundFor } from "./format.js";
import type { Sql, SqlValue } from "./sql.js";
import { BASELINE_WINDOW, MIN_COVERAGE, baselineAsOf, deviation, getDataVersion, listSources, mean, quantile, sourcePriority } from "./store.js";
import { addDays, daysBetween, eachDay, hoursBetween, weekStart } from "./time.js";
import type { DataQuality, JsonValue, Direction, Magnitude, MetricId, QuerySpec, Source, WorkoutDetail } from "./types.js";

export interface LeveledFinding {
  metric: MetricId;
  unknown_reason?: string;
  l0: { flag: "yes" | "no" | "unknown"; statement: string };
  l1: { direction: Direction; magnitude: Magnitude; statement: string };
  l2: { statement: string; value?: number; unit?: string; values?: { day: string; value: number }[] };
  l3?: { raw: JsonValue };
}

export interface ComputeResult {
  spec: QuerySpec;
  findings: LeveledFinding[];
  quality: DataQuality;
  data_version: string;
  as_of: string;
}

export interface ComputeInput {
  sql: Sql;
  spec: QuerySpec;
  now: Date;
  /** Sources the gate excluded (terms flags). */
  excludedSources?: string[];
  /** Include level 3 raw detail (samples, session detail). Only when the release level is 3. */
  includeRaw?: boolean;
}

export interface SeriesDay {
  day: string;
  value: number;
  coverage: number;
  source_id: string;
  extra: Record<string, unknown> | null;
  valid: boolean;
}

const STALE_HOURS = 36;

const toJson = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

class Ctx {
  caveats = new Set<string>();
  usedSources = new Set<string>();
  coverage: number[] = [];
  baselineDays: number[] = [];
  sources: Map<string, Source & { enabled: boolean }>;
  constructor(public sql: Sql, public excluded: Set<string>) {
    this.sources = new Map(listSources(sql).map((s) => [s.id, s]));
  }
  allowed(id: string) {
    const s = this.sources.get(id);
    return !!s && s.enabled && !this.excluded.has(id);
  }
}

/** One value per local day for a metric: the best source that day (valid coverage first, then device priority). */
export function dailySeries(ctx: Ctx, metric: MetricId, start: string, end: string): { series: SeriesDay[]; perDaySources: Map<string, number> } {
  const rows = ctx.sql.all<{ day: string; value: number | null; coverage: number; source_id: string; extra: string | null }>(
    `SELECT day, value, coverage, source_id, extra FROM daily_rollups WHERE metric = ? AND day >= ? AND day <= ? AND value IS NOT NULL ORDER BY day, source_id`,
    metric, start, end);
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!ctx.allowed(r.source_id)) continue;
    (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  }
  const series: SeriesDay[] = [];
  const perDaySources = new Map<string, number>();
  for (const [day, rs] of byDay) {
    perDaySources.set(day, rs.length);
    rs.sort((a, b) => {
      const va = a.coverage >= MIN_COVERAGE ? 0 : 1;
      const vb = b.coverage >= MIN_COVERAGE ? 0 : 1;
      if (va !== vb) return va - vb;
      const pa = sourcePriority(ctx.sources.get(a.source_id)!.device_class);
      const pb = sourcePriority(ctx.sources.get(b.source_id)!.device_class);
      return pa - pb || a.source_id.localeCompare(b.source_id);
    });
    const r = rs[0]!;
    series.push({ day, value: r.value!, coverage: r.coverage, source_id: r.source_id, extra: r.extra ? JSON.parse(r.extra) : null, valid: r.coverage >= MIN_COVERAGE });
  }
  series.sort((a, b) => a.day.localeCompare(b.day));
  return { series, perDaySources };
}

/** Workouts: a day with data from the source but no workout counts as zero minutes, so correlations see rest days. */
function workoutSeries(ctx: Ctx, start: string, end: string): SeriesDay[] {
  const { series } = dailySeries(ctx, "workout", start, end);
  const have = new Set(series.map((s) => s.day));
  const days = ctx.sql.all<{ day: string; source_id: string }>(
    `SELECT DISTINCT day, source_id FROM daily_rollups WHERE day >= ? AND day <= ? AND coverage >= ? ORDER BY day, source_id`, start, end, MIN_COVERAGE);
  for (const d of days) {
    if (have.has(d.day) || !ctx.allowed(d.source_id)) continue;
    have.add(d.day);
    series.push({ day: d.day, value: 0, coverage: 1, source_id: d.source_id, extra: { count: 0 }, valid: true });
  }
  return series.sort((a, b) => a.day.localeCompare(b.day));
}

function noteSeries(ctx: Ctx, metric: MetricId, start: string, end: string, series: SeriesDay[], perDaySources: Map<string, number>, opts: { excludeLowCoverage: boolean }) {
  const all = eachDay(start, end);
  const present = new Set(series.map((s) => s.day));
  const missing = all.filter((d) => !present.has(d)).length;
  const noun = dayNoun(metric, all.length);
  if (missing > 0) ctx.caveats.add(`${missing} of ${all.length} ${noun} have no ${label(metric).toLowerCase()} data`);
  const low = series.filter((s) => !s.valid).length;
  if (low > 0) ctx.caveats.add(opts.excludeLowCoverage ? `${low} ${dayNoun(metric, low)} with low wear time left out` : `${low} ${dayNoun(metric, low)} with low wear time; totals may be low`);
  for (const s of series) ctx.usedSources.add(s.source_id);
  if (series.length) ctx.coverage.push(series.filter((s) => s.valid).length / all.length);
  const multiDays = [...perDaySources.values()].filter((n) => n > 1).length;
  if (multiDays > 0) {
    const used = [...new Set(series.map((s) => ctx.sources.get(s.source_id)!.device_class))];
    ctx.caveats.add(`${label(metric)} reported by more than one device; counted from one source per day (${used.join(", ")}), never summed`);
  }
  if (new Set(series.map((s) => s.source_id)).size > 1) ctx.caveats.add("Values come from more than one device; each is compared only with its own history");
  const note = CATALOGUE[metric].note;
  if (metric === "sleep_stages") ctx.caveats.add("Sleep staging from consumer devices is an estimate");
  if (metric === "vo2max") ctx.caveats.add("VO2 max is an estimate");
  if (metric === "active_energy") ctx.caveats.add("Energy estimates differ by vendor");
  if (metric === "skin_temp_deviation") ctx.caveats.add("Skin temperature is a deviation from the device's own baseline");
  if (metric === "resting_hr" && series.some((s) => s.extra?.method === "lowest_30min_mean")) ctx.caveats.add("Resting heart rate derived as the lowest 30-minute mean where the device gave none");
  void note;
  noteNewDevice(ctx, metric, end, series);
  noteTimeZones(ctx, start, end);
}

function noteNewDevice(ctx: Ctx, metric: MetricId, end: string, series: SeriesDay[]) {
  for (const sid of new Set(series.map((s) => s.source_id))) {
    const first = ctx.sql.all<{ d: string | null }>(`SELECT MIN(day) AS d FROM daily_rollups WHERE metric = ? AND source_id = ?`, metric, sid)[0]?.d;
    if (!first || daysBetween(first, end) >= BASELINE_WINDOW) continue;
    const older = ctx.sql.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM daily_rollups WHERE metric = ? AND source_id != ? AND day < ?`, metric, sid, first)[0]?.n ?? 0;
    if (older > 0) ctx.caveats.add(`New device from ${first}; its ${label(metric).toLowerCase()} baseline restarted`);
  }
}

function noteTimeZones(ctx: Ctx, start: string, end: string) {
  const offs = ctx.sql.all<{ o: number }>(
    `SELECT DISTINCT tz_offset_min AS o FROM samples WHERE day >= ? AND day <= ? UNION SELECT DISTINCT tz_offset_min AS o FROM sessions WHERE day >= ? AND day <= ?`,
    start, end, start, end);
  if (offs.length > 1) ctx.caveats.add("Local time offset changed in this period (travel or daylight saving); days follow local time");
}

type Baseline = Exclude<ReturnType<typeof baselineAsOf>, { insufficient: true }>;

function baselineFor(ctx: Ctx, metric: MetricId, sourceId: string, day: string): Baseline | null {
  const b = baselineAsOf(ctx.sql, metric, sourceId, day);
  if ("insufficient" in b) {
    ctx.caveats.add(`Personal baseline for ${label(metric).toLowerCase()} still building (${b.n_days} of 14 valid days)`);
    return null;
  }
  ctx.baselineDays.push(b.n_days);
  return b;
}

const BUCKET_MAG: Record<string, Magnitude> = { within: "none", slightly: "slight", moderately: "moderate", far: "large" };
const MAG_WORD: Record<Magnitude, string> = { none: "", slight: "slightly", moderate: "moderately", large: "far", unknown: "" };

function unknown(metric: MetricId, reason: string, why: string): LeveledFinding {
  const statement = `Unknown: ${why}`;
  return {
    metric,
    unknown_reason: reason,
    l0: { flag: "unknown", statement },
    l1: { direction: "unknown", magnitude: "unknown", statement },
    l2: { statement },
  };
}

function rangeWord(dir: "above" | "below" | "within", bucket: string): string {
  if (dir === "within") return "within usual range";
  return `${bucket} ${dir} usual range`;
}

// ---------- operations ----------

function opLatest(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const metric = spec.metrics[0]!;
  const { series, perDaySources } = dailySeries(ctx, metric, spec.window.start, spec.window.end);
  const usable = series.filter((s) => s.valid || CATALOGUE[metric].daily === "latest");
  if (!usable.length) {
    noteSeries(ctx, metric, spec.window.start, spec.window.end, series, perDaySources, { excludeLowCoverage: true });
    return [unknown(metric, "no_data_in_window", `no ${label(metric).toLowerCase()} data from ${spec.window.start} to ${spec.window.end}`)];
  }
  const last = usable[usable.length - 1]!;
  ctx.usedSources.add(last.source_id);
  ctx.coverage.push(last.coverage);
  noteNewDevice(ctx, metric, last.day, [last]);
  if (series.length > 1 && perDaySources.get(last.day)! > 1) ctx.caveats.add(`${label(metric)} reported by more than one device; the ${ctx.sources.get(last.source_id)!.device_class} was used`);
  const b = baselineFor(ctx, metric, last.source_id, last.day);
  const dev = b ? deviation(last.value, b) : null;
  const v = roundFor(metric, last.value);
  const f: LeveledFinding = {
    metric,
    l0: dev ? { flag: dev.bucket === "within" ? "yes" : "no", statement: `${label(metric)} within usual range on ${last.day}: ${dev.bucket === "within" ? "yes" : "no"}` } : { flag: "unknown", statement: `Within usual range: unknown, baseline still building` },
    l1: dev ? { direction: dev.direction, magnitude: BUCKET_MAG[dev.bucket]!, statement: `${label(metric)} ${rangeWord(dev.direction, dev.bucket)} on ${last.day}` } : { direction: "unknown", magnitude: "unknown", statement: `${label(metric)} recorded on ${last.day}; baseline still building` },
    l2: { statement: `${label(metric)} on ${last.day}: ${fmtValue(metric, last.value)}${dev ? `, ${rangeWord(dev.direction, dev.bucket)}` : ""}`, value: v, unit: CATALOGUE[metric].unit, values: [{ day: last.day, value: v }] },
  };
  if (raw) f.l3 = { raw: rawFor(ctx, metric, last.day, last.day) };
  return [f];
}

function opAggregate(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const metric = spec.metrics[0]!;
  const { start, end } = spec.window;
  const { series, perDaySources } = metric === "workout" ? { series: workoutSeries(ctx, start, end), perDaySources: new Map() } : dailySeries(ctx, metric, start, end);
  noteSeries(ctx, metric, start, end, series, perDaySources, { excludeLowCoverage: !CATALOGUE[metric].window_total });
  const nDays = eachDay(start, end).length;
  const vals = CATALOGUE[metric].window_total ? series : series.filter((s) => s.valid);
  if (!vals.length) return [unknown(metric, "no_data_in_window", `no ${label(metric).toLowerCase()} data from ${start} to ${end}`)];
  if (vals.length < Math.ceil(nDays / 2)) return [unknown(metric, "thin_data", `data on only ${vals.length} of ${nDays} ${dayNoun(metric, nDays)}`)];
  const xs = vals.map((s) => s.value);
  const stat = spec.params?.statistic ?? (CATALOGUE[metric].window_total ? "total" : "mean");
  const value = stat === "total" ? xs.reduce((a, b) => a + b, 0) : stat === "min" ? Math.min(...xs) : stat === "max" ? Math.max(...xs) : mean(xs);
  const avg = mean(xs);
  // Level 1: the period's mean against the baseline of the source used most, as of the window start.
  const main = mostUsed(vals);
  const b = metric === "workout" ? null : baselineFor(ctx, metric, main, start);
  const dev = b ? deviation(avg, b) : null;
  const statWord = stat === "total" ? "Total" : stat === "mean" ? "Average" : stat === "min" ? "Lowest" : "Highest";
  const values = dailyOrWeekly(metric, vals, spec.granularity);
  const extraWorkouts = metric === "workout" ? `, ${vals.reduce((a, s) => a + Number(s.extra?.count ?? 0), 0)} sessions` : "";
  const f: LeveledFinding = {
    metric,
    l0: dev ? { flag: dev.bucket === "within" ? "yes" : "no", statement: `${label(metric)} within usual range over ${start} to ${end}: ${dev.bucket === "within" ? "yes" : "no"}` } : { flag: "unknown", statement: "Within usual range: unknown" },
    l1: dev
      ? { direction: dev.direction, magnitude: BUCKET_MAG[dev.bucket]!, statement: `${label(metric)} averaged ${rangeWord(dev.direction, dev.bucket)} over ${vals.length} ${dayNoun(metric, vals.length)}` }
      : { direction: "unknown", magnitude: "unknown", statement: `${label(metric)} recorded on ${vals.length} ${dayNoun(metric, vals.length)}; no baseline to compare` },
    l2: {
      statement: `${statWord} ${label(metric).toLowerCase()} ${start} to ${end}: ${fmtValue(metric, value)}${stat === "total" ? ` (average ${fmtValue(metric, avg)} per ${dayNoun(metric, 1)})` : ""}${extraWorkouts}${stat === "total" && vals.length < nDays ? `; covers only ${vals.length} of ${nDays} ${dayNoun(metric, nDays)}, so the true total is unknown` : ""}`,
      value: roundFor(metric, value),
      unit: CATALOGUE[metric].unit,
      values,
    },
  };
  if (raw) f.l3 = { raw: rawFor(ctx, metric, start, end) };
  return [f];
}

function mostUsed(series: SeriesDay[]): string {
  const c = new Map<string, number>();
  for (const s of series) c.set(s.source_id, (c.get(s.source_id) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

const MAX_DAILY_VALUES = 14;

function dailyOrWeekly(metric: MetricId, series: SeriesDay[], granularity: QuerySpec["granularity"]) {
  if (granularity !== "week" && series.length <= MAX_DAILY_VALUES) return series.map((s) => ({ day: s.day, value: roundFor(metric, s.value) }));
  const weeks = new Map<string, number[]>();
  for (const s of series) {
    const w = weekStart(s.day);
    (weeks.get(w) ?? weeks.set(w, []).get(w)!).push(s.value);
  }
  return [...weeks.entries()].slice(-MAX_DAILY_VALUES).map(([day, xs]) => ({ day, value: roundFor(metric, mean(xs)) }));
}

function slopeOf(points: { x: number; y: number }[]): number {
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** t statistic of an OLS slope. */
function slopeT(points: { x: number; y: number }[], slope: number): number {
  const n = points.length;
  if (n < 3) return 0;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  const intercept = my - slope * mx;
  let sse = 0, sxx = 0;
  for (const p of points) { sse += (p.y - (intercept + slope * p.x)) ** 2; sxx += (p.x - mx) ** 2; }
  if (sxx === 0) return 0;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return se === 0 ? (slope === 0 ? 0 : Math.sign(slope) * Infinity) : slope / se;
}

function magnitudeOf(rel: number): Magnitude {
  const a = Math.abs(rel);
  if (a < 0.25) return "none";
  if (a < 0.75) return "slight";
  if (a < 1.5) return "moderate";
  return "large";
}

function iqrOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return quantile(s, 0.75) - quantile(s, 0.25);
}

function opTrend(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const metric = spec.metrics[0]!;
  const { start, end } = spec.window;
  const { series, perDaySources } = metric === "workout" ? { series: workoutSeries(ctx, start, end), perDaySources: new Map() } : dailySeries(ctx, metric, start, end);
  noteSeries(ctx, metric, start, end, series, perDaySources, { excludeLowCoverage: true });
  const valid = series.filter((s) => s.valid);
  if (valid.length < 7) return [unknown(metric, "too_few_days", `a trend needs at least 7 valid ${dayNoun(metric, 2)}; found ${valid.length}`)];
  const pts = valid.map((s) => ({ x: daysBetween(start, s.day), y: s.value }));
  const slope = slopeOf(pts);
  const span = daysBetween(valid[0]!.day, valid[valid.length - 1]!.day);
  const change = slope * span;
  const scale = Math.max(iqrOf(valid.map((s) => s.value)), Math.abs(mean(valid.map((s) => s.value))) * 0.02, 1e-6);
  // A trend is called only when the slope is clearly non-zero (|t| >= 2.5) and its size is meaningful.
  const t = slopeT(pts, slope);
  const mag = Math.abs(t) < 2.5 ? "none" : magnitudeOf(change / scale);
  const direction: Direction = mag === "none" ? "flat" : change > 0 ? "up" : "down";
  const word = direction === "flat" ? "steady" : `${direction === "up" ? "rising" : "falling"} ${MAG_WORD[mag]}`.trim();
  const statement1 = `${label(metric)} ${word} over ${valid.length} ${dayNoun(metric, valid.length)}`;
  const f: LeveledFinding = {
    metric,
    l0: { flag: direction === "flat" ? "no" : "yes", statement: `${label(metric)} changing over ${start} to ${end}: ${direction === "flat" ? "no" : "yes"}` },
    l1: { direction, magnitude: mag, statement: statement1 },
    l2: {
      statement: `${statement1}: about ${fmtValue(metric, Math.abs(slope * 7))} per week ${direction === "down" ? "lower" : direction === "up" ? "higher" : "change"}`,
      value: roundFor(metric, slope * 7),
      unit: `${CATALOGUE[metric].unit}/week`,
      values: dailyOrWeekly(metric, valid, spec.granularity),
    },
  };
  if (raw) f.l3 = { raw: rawFor(ctx, metric, start, end) };
  return [f];
}

function opCompareToBaseline(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const metric = spec.metrics[0]!;
  const { start, end } = spec.window;
  const { series, perDaySources } = dailySeries(ctx, metric, start, end);
  noteSeries(ctx, metric, start, end, series, perDaySources, { excludeLowCoverage: true });
  const valid = series.filter((s) => s.valid);
  if (!valid.length) return [unknown(metric, "no_data_in_window", `no ${label(metric).toLowerCase()} data from ${start} to ${end}`)];
  const devs: { day: string; value: number; dev: ReturnType<typeof deviation> }[] = [];
  for (const s of valid) {
    // Baseline as of the window start, so the days asked about never feed their own baseline.
    const b = baselineFor(ctx, metric, s.source_id, start);
    if (b) devs.push({ day: s.day, value: s.value, dev: deviation(s.value, b) });
  }
  if (!devs.length) return [unknown(metric, "baseline_building", `personal baseline needs 14 valid ${dayNoun(metric, 2)} in the 28 before ${start}`)];
  const below = devs.filter((d) => d.dev.direction === "below");
  const above = devs.filter((d) => d.dev.direction === "above");
  const within = devs.length - below.length - above.length;
  const n = devs.length;
  const noun = dayNoun(metric, n);
  let direction: Direction = "within";
  let group = devs;
  if (below.length > n / 2) { direction = "below"; group = below; }
  else if (above.length > n / 2) { direction = "above"; group = above; }
  const order = ["within", "slightly", "moderately", "far"];
  const typical = group.map((d) => d.dev.bucket).sort((a, b) => order.indexOf(a) - order.indexOf(b))[Math.floor((group.length - 1) / 2)]!;
  const mag = direction === "within" ? "none" : BUCKET_MAG[typical]!;
  const st1 = direction === "within"
    ? `${label(metric)} within usual range on ${within} of the last ${n} ${noun}`
    : `${label(metric)} ${MAG_WORD[mag]} ${direction} usual range on ${group.length} of the last ${n} ${noun}`;
  const b0 = baselineFor(ctx, metric, mostUsed(valid), start);
  const f: LeveledFinding = {
    metric,
    l0: { flag: within === n ? "yes" : "no", statement: `${label(metric)} within usual range: ${within === n ? "yes" : "no"}` },
    l1: { direction, magnitude: mag, statement: st1 },
    l2: {
      statement: `${st1}; usual range ${b0 ? `${fmtValue(metric, b0.q1)} to ${fmtValue(metric, b0.q3)}` : "unknown"}`,
      unit: CATALOGUE[metric].unit,
      values: devs.slice(-MAX_DAILY_VALUES).map((d) => ({ day: d.day, value: roundFor(metric, d.value) })),
    },
  };
  if (raw) f.l3 = { raw: toJson({ baseline: b0, days: devs }) };
  return [f];
}

function opComparePeriods(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const metric = spec.metrics[0]!;
  const a = spec.window;
  const b = spec.params!.compare_window!;
  const sa = metric === "workout" ? { series: workoutSeries(ctx, a.start, a.end), perDaySources: new Map() } : dailySeries(ctx, metric, a.start, a.end);
  const sb = metric === "workout" ? { series: workoutSeries(ctx, b.start, b.end), perDaySources: new Map() } : dailySeries(ctx, metric, b.start, b.end);
  noteSeries(ctx, metric, a.start, a.end, sa.series, sa.perDaySources, { excludeLowCoverage: true });
  noteSeries(ctx, metric, b.start, b.end, sb.series, sb.perDaySources, { excludeLowCoverage: true });
  const va = sa.series.filter((s) => s.valid).map((s) => s.value);
  const vb = sb.series.filter((s) => s.valid).map((s) => s.value);
  if (va.length < 3 || vb.length < 3) return [unknown(metric, "thin_data", `each period needs at least 3 valid ${dayNoun(metric, 2)} (have ${va.length} and ${vb.length})`)];
  const ma = mean(va);
  const mb = mean(vb);
  const scale = Math.max(iqrOf([...va, ...vb]), Math.abs(mb) * 0.02, 1e-6);
  const mag = magnitudeOf((ma - mb) / scale);
  const direction: Direction = mag === "none" ? "flat" : ma > mb ? "up" : "down";
  const word = direction === "flat" ? "about the same as" : `${MAG_WORD[mag]} ${direction === "up" ? "higher than" : "lower than"}`;
  const st1 = `${label(metric)} ${a.start} to ${a.end} ${word} ${b.start} to ${b.end}`;
  const srcA = new Set(sa.series.map((s) => s.source_id));
  const srcB = new Set(sb.series.map((s) => s.source_id));
  if ([...srcA].some((s) => !srcB.has(s)) || [...srcB].some((s) => !srcA.has(s))) ctx.caveats.add("The two periods use different devices; the difference may partly reflect the device");
  const f: LeveledFinding = {
    metric,
    l0: { flag: direction === "flat" ? "no" : "yes", statement: `${label(metric)} different from the comparison period: ${direction === "flat" ? "no" : "yes"}` },
    l1: { direction, magnitude: mag, statement: st1 },
    l2: {
      statement: `${label(metric)} averaged ${fmtValue(metric, ma)} (${va.length} ${dayNoun(metric, va.length)}) against ${fmtValue(metric, mb)} (${vb.length} ${dayNoun(metric, vb.length)})`,
      value: roundFor(metric, ma - mb),
      unit: CATALOGUE[metric].unit,
      values: [{ day: a.start, value: roundFor(metric, ma) }, { day: b.start, value: roundFor(metric, mb) }],
    },
  };
  if (raw) f.l3 = { raw: toJson({ period: sa.series, compare: sb.series }) };
  return [f];
}

const CMP: Record<string, (x: number, t: number) => boolean> = {
  "<": (x, t) => x < t,
  "<=": (x, t) => x <= t,
  ">": (x, t) => x > t,
  ">=": (x, t) => x >= t,
};
const CMP_WORD: Record<string, string> = { "<": "under", "<=": "at or under", ">": "over", ">=": "at or over" };

function opThreshold(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const metric = spec.metrics[0]!;
  const { start, end } = spec.window;
  const p = spec.params!;
  const t = p.threshold_unit ? toCatalogueUnit(metric, p.threshold!, p.threshold_unit) : p.threshold!;
  const { series, perDaySources } = metric === "workout" ? { series: workoutSeries(ctx, start, end), perDaySources: new Map() } : dailySeries(ctx, metric, start, end);
  noteSeries(ctx, metric, start, end, series, perDaySources, { excludeLowCoverage: true });
  const valid = series.filter((s) => s.valid);
  if (!valid.length) return [unknown(metric, "no_data_in_window", `no ${label(metric).toLowerCase()} data from ${start} to ${end}`)];
  const hits = valid.filter((s) => CMP[p.comparator!]!(s.value, t));
  const mode = p.mode ?? "any";
  const n = valid.length;
  const noun = dayNoun(metric, n);
  const missing = eachDay(start, end).length - n;
  let flag: "yes" | "no" | "unknown" = mode === "all" ? (hits.length === n ? "yes" : "no") : hits.length > 0 ? "yes" : "no";
  // "No" over incomplete data is not certain for "any"; "yes" over incomplete data is not certain for "all".
  if (missing > 0 && ((mode !== "all" && flag === "no") || (mode === "all" && flag === "yes"))) flag = "unknown";
  const cond = `${label(metric).toLowerCase()} ${CMP_WORD[p.comparator!]} ${fmtValue(metric, t)}`;
  const q = mode === "all" ? `every ${dayNoun(metric, 1)}` : `any ${dayNoun(metric, 1)}`;
  const f: LeveledFinding = {
    metric,
    l0: { flag, statement: `${cap(cond)} on ${q} from ${start} to ${end}: ${flag}${flag === "unknown" ? ` (${missing} ${dayNoun(metric, missing)} missing)` : ""}` },
    l1: { direction: hits.length ? (p.comparator!.startsWith("<") ? "below" : "above") : "within", magnitude: "unknown", statement: `${cap(cond)} on ${hits.length} of ${n} ${noun}` },
    l2: { statement: `${cap(cond)} on ${hits.length} of ${n} ${noun}`, value: hits.length, unit: noun, values: hits.slice(-MAX_DAILY_VALUES).map((s) => ({ day: s.day, value: roundFor(metric, s.value) })) },
  };
  if (raw) f.l3 = { raw: toJson(valid) };
  return [f];
}

export const MIN_PAIRED_DAYS = 20;

function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]!.i] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

function opCorrelate(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const [m1, m2] = spec.metrics as [MetricId, MetricId];
  const { start, end } = spec.window;
  const lag = spec.params?.lag_days ?? 0;
  const get = (m: MetricId, s: string, e: string) => (m === "workout" ? { series: workoutSeries(ctx, s, e), perDaySources: new Map() } : dailySeries(ctx, m, s, e));
  const A = get(m1, start, end);
  const B = get(m2, addDays(start, lag), addDays(end, lag));
  noteSeries(ctx, m1, start, end, A.series, A.perDaySources, { excludeLowCoverage: true });
  noteSeries(ctx, m2, addDays(start, lag), addDays(end, lag), B.series, B.perDaySources, { excludeLowCoverage: true });
  const bMap = new Map(B.series.filter((s) => s.valid).map((s) => [s.day, s.value]));
  const pairs: [number, number][] = [];
  for (const s of A.series.filter((x) => x.valid)) {
    const v = bMap.get(addDays(s.day, lag));
    if (v !== undefined) pairs.push([s.value, v]);
  }
  ctx.caveats.add("Correlation is not cause");
  const both = `${label(m1).toLowerCase()} and ${lag ? "next-day " : ""}${label(m2).toLowerCase()}`;
  if (pairs.length < MIN_PAIRED_DAYS) return [unknown(m1, "too_few_paired_days", `needs ${MIN_PAIRED_DAYS} days with both ${both}; found ${pairs.length}`)];
  const r = spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const a = Math.abs(r);
  const strength = a < 0.1 ? "no clear" : a < 0.3 ? "weak" : a < 0.5 ? "moderate" : "strong";
  const sign = a < 0.1 ? "" : r > 0 ? " positive" : " negative";
  const mag: Magnitude = a < 0.1 ? "none" : a < 0.3 ? "slight" : a < 0.5 ? "moderate" : "large";
  const st = `${cap(strength)}${sign} association between ${both} across ${pairs.length} paired days`;
  const f: LeveledFinding = {
    metric: m1,
    l0: { flag: a >= 0.3 ? "yes" : "no", statement: `Clear association between ${both}: ${a >= 0.3 ? "yes" : "no"}` },
    l1: { direction: a < 0.1 ? "flat" : r > 0 ? "up" : "down", magnitude: mag, statement: st },
    l2: { statement: `${st} (Spearman r = ${r.toFixed(2)})`, value: Math.round(r * 100) / 100, unit: "spearman_r" },
  };
  if (raw) f.l3 = { raw: pairs };
  return [f];
}

function opListSessions(ctx: Ctx, spec: QuerySpec, raw: boolean): LeveledFinding[] {
  const metric = spec.metrics[0]!;
  const kind = spec.params?.session_kind ?? (metric === "sleep_duration" ? "sleep" : "workout");
  const { start, end } = spec.window;
  const rows = ctx.sql.all<{ start: string; end: string; source_id: string; day: string; detail: string; external_id: string; is_main: number | null } & Record<string, SqlValue>>(
    `SELECT start, "end", source_id, day, detail, external_id, is_main FROM sessions WHERE session_kind = ? AND day >= ? AND day <= ? ORDER BY start, source_id`,
    kind, start, end).filter((r) => ctx.allowed(r.source_id));
  // Drop a session that overlaps a higher-priority source's session by more than half.
  const pri = (sid: string) => sourcePriority(ctx.sources.get(sid)!.device_class);
  const kept: typeof rows = [];
  for (const r of [...rows].sort((x, y) => pri(x.source_id) - pri(y.source_id) || x.start.localeCompare(y.start))) {
    const len = Date.parse(r.end) - Date.parse(r.start);
    const dup = kept.some((k) => k.source_id !== r.source_id && overlap(k, r) > len / 2);
    if (!dup) kept.push(r);
  }
  kept.sort((a, b) => a.start.localeCompare(b.start));
  for (const k of kept) ctx.usedSources.add(k.source_id);
  if (kept.length < rows.length) ctx.caveats.add("Sessions recorded by two devices were counted once");
  noteTimeZones(ctx, start, end);
  const mins = (r: { start: string; end: string }) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / 60_000);
  const totalMin = kept.reduce((a, r) => a + mins(r), 0);
  const fmtH = fmtValue("workout", totalMin);
  if (kind === "workout") {
    const types: Record<string, number> = {};
    for (const r of kept) {
      const t = (JSON.parse(r.detail) as WorkoutDetail).type;
      types[t] = (types[t] ?? 0) + 1;
    }
    const typeStr = Object.entries(types).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => `${t} ${n}`).join(", ");
    const f: LeveledFinding = {
      metric,
      l0: { flag: kept.length ? "yes" : "no", statement: `Any workouts from ${start} to ${end}: ${kept.length ? "yes" : "no"}` },
      l1: { direction: "unknown", magnitude: "unknown", statement: `${kept.length} workouts, ${fmtH} total${typeStr ? `: ${typeStr}` : ""}` },
      l2: {
        statement: `${kept.length} workouts, ${fmtH} total`,
        value: kept.length,
        unit: "sessions",
        // Level 2 lists type and minutes only. Titles and notes are free text and appear only at level 3.
        values: kept.slice(-MAX_DAILY_VALUES).map((r) => ({ day: r.day, value: mins(r), type: (JSON.parse(r.detail) as WorkoutDetail).type })) as { day: string; value: number }[],
      },
    };
    if (raw) f.l3 = { raw: kept.map((r) => ({ start: r.start, end: r.end, source_id: r.source_id, detail: JSON.parse(r.detail) })) };
    return [f];
  }
  const f: LeveledFinding = {
    metric,
    l0: { flag: kept.length ? "yes" : "no", statement: `Any sleep recorded from ${start} to ${end}: ${kept.length ? "yes" : "no"}` },
    l1: { direction: "unknown", magnitude: "unknown", statement: `${kept.length} sleep sessions recorded` },
    l2: { statement: `${kept.length} sleep sessions, ${fmtH} in bed in total`, value: kept.length, unit: "sessions", values: kept.slice(-MAX_DAILY_VALUES).map((r) => ({ day: r.day, value: mins(r) })) },
  };
  if (raw) f.l3 = { raw: kept.map((r) => ({ start: r.start, end: r.end, source_id: r.source_id, detail: JSON.parse(r.detail) })) };
  return [f];
}

function overlap(a: { start: string; end: string }, b: { start: string; end: string }): number {
  return Math.max(0, Math.min(Date.parse(a.end), Date.parse(b.end)) - Math.max(Date.parse(a.start), Date.parse(b.start)));
}

const RAW_LIMIT = 2000;
function rawFor(ctx: Ctx, metric: MetricId, start: string, end: string) {
  const sampleMetric = metric === "resting_hr" ? "heart_rate" : metric;
  return ctx.sql.all(
    `SELECT start, "end", value, unit, source_id, method FROM samples WHERE metric = ? AND day >= ? AND day <= ? ORDER BY start LIMIT ?`,
    sampleMetric, start, end, RAW_LIMIT).filter((r) => ctx.allowed(r.source_id as string));
}

const OPS = {
  latest: opLatest,
  aggregate: opAggregate,
  trend: opTrend,
  compare_to_baseline: opCompareToBaseline,
  compare_periods: opComparePeriods,
  threshold_check: opThreshold,
  correlate: opCorrelate,
  list_sessions: opListSessions,
} as const;

/** Run a validated, gate-approved QuerySpec. Deterministic for a given store state and `now` hour. */
export function compute(input: ComputeInput): ComputeResult {
  const { sql, spec, now } = input;
  const ctx = new Ctx(sql, new Set(input.excludedSources ?? []));
  const asOf = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
  const findings = OPS[spec.operation](ctx, spec, !!input.includeRaw);

  // Freshness: hours since the newest sync of the sources used (or of any allowed source if none were used).
  const used = [...ctx.usedSources].map((id) => ctx.sources.get(id)!).filter(Boolean);
  const pool = used.length ? used : [...ctx.sources.values()].filter((s) => ctx.allowed(s.id));
  let lastSync: string | null = null;
  for (const s of pool) {
    const t = s.last_sync_at ?? (sql.all<{ e: string | null }>(`SELECT MAX("end") AS e FROM samples WHERE source_id = ?`, s.id)[0]?.e ?? null);
    if (t && (!lastSync || t > lastSync)) lastSync = t;
  }
  const freshness = lastSync ? Math.max(0, Math.floor(hoursBetween(lastSync, asOf))) : null;
  if (freshness !== null && freshness > STALE_HOURS) ctx.caveats.add(`Last sync ${freshness} hours ago; recent days may be missing`);
  if (freshness === null) ctx.caveats.add("No data has been synced");

  const quality: DataQuality = {
    freshness_hours: freshness,
    coverage: ctx.coverage.length ? Math.round(mean(ctx.coverage) * 100) / 100 : null,
    sources: [...new Set(used.map((s) => s.provider))].sort(),
    baseline_days: ctx.baselineDays.length ? Math.min(...ctx.baselineDays) : null,
    caveats: [...ctx.caveats].sort(),
  };
  return { spec, findings, quality, data_version: getDataVersion(sql), as_of: asOf };
}
