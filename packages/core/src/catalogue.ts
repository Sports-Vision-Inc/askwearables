// The metric catalogue: the single place a metric's unit and aggregation are defined.
import type { DeviceClass, Level, MetricId, Operation } from "./types.js";

export type DailyAggregation =
  | "sum"
  | "mean"
  | "night_mean"
  | "latest"
  | "resting"
  | "main_sleep"
  | "sleep_efficiency"
  | "sleep_stages"
  | "workout";

export type Category = "activity" | "heart" | "sleep" | "body" | "training" | "sensitive";

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: string;
  daily: DailyAggregation;
  category: Category;
  /** Intraday metrics measure coverage by hours with data; others count a day as fully covered. */
  intraday: boolean;
  /** Whether summing over a window is meaningful (total steps) or a mean is (resting HR). */
  window_total: boolean;
  sensitive: boolean;
  note?: string;
  /** Units accepted on ingest, mapped to a factor that converts to `unit`. */
  accepts: Record<string, number | "f_to_c_delta">;
  /** Plausible physical range after conversion; values outside are rejected on ingest. */
  range: [number, number];
}

const m = (d: Omit<MetricDef, "sensitive" | "intraday" | "window_total"> & Partial<MetricDef>): MetricDef => ({
  sensitive: false,
  intraday: false,
  window_total: false,
  ...d,
});

export const CATALOGUE_VERSION = "1";

export const CATALOGUE: Record<MetricId, MetricDef> = {
  steps: m({ id: "steps", label: "Steps", unit: "count", daily: "sum", category: "activity", intraday: true, window_total: true, note: "Never summed across sources", accepts: { count: 1, steps: 1 }, range: [0, 200000] }),
  active_energy: m({ id: "active_energy", label: "Active energy", unit: "kcal", daily: "sum", category: "activity", intraday: true, window_total: true, note: "Estimates differ by vendor", accepts: { kcal: 1, Cal: 1, cal: 0.001, kJ: 0.239006 }, range: [0, 20000] }),
  resting_hr: m({ id: "resting_hr", label: "Resting heart rate", unit: "bpm", daily: "resting", category: "heart", accepts: { bpm: 1, "count/min": 1 }, range: [20, 200] }),
  heart_rate: m({ id: "heart_rate", label: "Heart rate", unit: "bpm", daily: "mean", category: "heart", intraday: true, note: "Raw only at level 3", accepts: { bpm: 1, "count/min": 1 }, range: [20, 250] }),
  hrv_rmssd: m({ id: "hrv_rmssd", label: "HRV (RMSSD)", unit: "ms", daily: "night_mean", category: "heart", note: "Kept separate from SDNN", accepts: { ms: 1, s: 1000 }, range: [1, 400] }),
  hrv_sdnn: m({ id: "hrv_sdnn", label: "HRV (SDNN)", unit: "ms", daily: "night_mean", category: "heart", note: "Confirm per provider which one it reports", accepts: { ms: 1, s: 1000 }, range: [1, 400] }),
  sleep_duration: m({ id: "sleep_duration", label: "Sleep duration", unit: "minutes", daily: "main_sleep", category: "sleep", window_total: true, note: "Attributed to the wake date", accepts: { minutes: 1, min: 1, h: 60, s: 1 / 60 }, range: [0, 1440] }),
  sleep_efficiency: m({ id: "sleep_efficiency", label: "Sleep efficiency", unit: "percent", daily: "sleep_efficiency", category: "sleep", accepts: { percent: 1, "%": 1, fraction: 100 }, range: [0, 100] }),
  sleep_stages: m({ id: "sleep_stages", label: "Sleep stages", unit: "minutes", daily: "sleep_stages", category: "sleep", note: "Consumer staging is an estimate", accepts: { minutes: 1 }, range: [0, 1440] }),
  spo2: m({ id: "spo2", label: "Blood oxygen", unit: "percent", daily: "night_mean", category: "body", accepts: { percent: 1, "%": 1, fraction: 100 }, range: [50, 100] }),
  respiratory_rate: m({ id: "respiratory_rate", label: "Respiratory rate", unit: "breaths/min", daily: "night_mean", category: "body", accepts: { "breaths/min": 1, "count/min": 1 }, range: [4, 60] }),
  skin_temp_deviation: m({ id: "skin_temp_deviation", label: "Skin temperature deviation", unit: "degC", daily: "night_mean", category: "body", note: "Deviation from the vendor's baseline", accepts: { degC: 1, C: 1, degF: "f_to_c_delta" }, range: [-10, 10] }),
  vo2max: m({ id: "vo2max", label: "VO2 max", unit: "ml/kg/min", daily: "latest", category: "training", note: "Estimated", accepts: { "ml/kg/min": 1, "mL/min·kg": 1 }, range: [10, 100] }),
  weight: m({ id: "weight", label: "Weight", unit: "kg", daily: "latest", category: "body", accepts: { kg: 1, lb: 0.45359237, g: 0.001 }, range: [20, 400] }),
  workout: m({ id: "workout", label: "Workouts", unit: "minutes", daily: "workout", category: "training", window_total: true, note: "Type mapped to a shared list", accepts: { minutes: 1 }, range: [0, 1440] }),
  // Sensitive categories. Listed so the gate can refuse them by name.
  blood_glucose: m({ id: "blood_glucose", label: "Blood glucose", unit: "mg/dL", daily: "mean", category: "sensitive", sensitive: true, intraday: true, accepts: { "mg/dL": 1, "mmol/L": 18.0182 }, range: [20, 600] }),
  menstrual_cycle: m({ id: "menstrual_cycle", label: "Cycle tracking", unit: "flag", daily: "latest", category: "sensitive", sensitive: true, accepts: { flag: 1 }, range: [0, 10] }),
  ecg_classification: m({ id: "ecg_classification", label: "ECG and rhythm notifications", unit: "flag", daily: "latest", category: "sensitive", sensitive: true, accepts: { flag: 1 }, range: [0, 10] }),
  breathing_disturbances: m({ id: "breathing_disturbances", label: "Sleep apnea events", unit: "count/h", daily: "night_mean", category: "sensitive", sensitive: true, accepts: { "count/h": 1 }, range: [0, 200] }),
};

export const METRIC_IDS = Object.keys(CATALOGUE) as MetricId[];
export const PUBLIC_METRIC_IDS = METRIC_IDS.filter((id) => !CATALOGUE[id].sensitive);
export const SENSITIVE_METRIC_IDS = METRIC_IDS.filter((id) => CATALOGUE[id].sensitive);

export const OPERATIONS: Operation[] = [
  "latest",
  "aggregate",
  "trend",
  "compare_to_baseline",
  "compare_periods",
  "threshold_check",
  "correlate",
  "list_sessions",
];

/** The lowest level that can answer each operation. */
export const MIN_LEVEL: Record<Operation, Level> = {
  latest: 2,
  aggregate: 2,
  trend: 1,
  compare_to_baseline: 1,
  compare_periods: 1,
  threshold_check: 0,
  correlate: 1,
  list_sessions: 2,
};

/** The lowest level that answers this spec. A threshold check that asks how many days met the condition
 *  (params.mode "count") needs the count, which a level-0 flag does not carry; the count is level 1. */
export function requiredLevel(spec: { operation: Operation; params?: { mode?: string } }): Level {
  if (spec.operation === "threshold_check" && spec.params?.mode === "count") return 1;
  return MIN_LEVEL[spec.operation];
}

/** Metrics that answer closely related questions. When a requested metric is outside a grant and a related one is
 *  inside it, a denial names the granted one, so the agent can ask again within the grant. */
export const RELATED_METRICS: Partial<Record<MetricId, MetricId[]>> = {
  heart_rate: ["resting_hr"],
  resting_hr: ["heart_rate"],
  sleep_efficiency: ["sleep_duration"],
  sleep_duration: ["sleep_efficiency"],
};

/** Default source priority when two sources report one metric: watch, then ring, then phone. */
export const DEVICE_PRIORITY: DeviceClass[] = ["watch", "ring", "band", "scale", "cgm", "phone", "other"];

/** The shared list workout types are mapped to. Anything else becomes "other". */
export const WORKOUT_TYPES = [
  "run",
  "walk",
  "hike",
  "cycle",
  "swim",
  "strength",
  "hiit",
  "yoga",
  "row",
  "elliptical",
  "sport",
  "other",
] as const;
export type WorkoutType = (typeof WORKOUT_TYPES)[number];

const WORKOUT_ALIASES: Record<string, WorkoutType> = {
  running: "run", run: "run", treadmill: "run", jog: "run", trail_running: "run",
  walking: "walk", walk: "walk",
  hiking: "hike", hike: "hike",
  cycling: "cycle", biking: "cycle", bike: "cycle", ride: "cycle", indoor_cycling: "cycle", spinning: "cycle",
  swimming: "swim", swim: "swim", pool_swim: "swim", open_water_swim: "swim",
  strength: "strength", strength_training: "strength", weightlifting: "strength", traditionalstrengthtraining: "strength", functionalstrengthtraining: "strength", weights: "strength",
  hiit: "hiit", highintensityintervaltraining: "hiit", crossfit: "hiit",
  yoga: "yoga", pilates: "yoga",
  rowing: "row", row: "row",
  elliptical: "elliptical",
  soccer: "sport", tennis: "sport", basketball: "sport", football: "sport", golf: "sport", sport: "sport",
};

export function mapWorkoutType(raw: string | undefined | null): WorkoutType {
  if (!raw) return "other";
  const k = raw.toLowerCase().replace(/^hkworkoutactivitytype/, "").replace(/[\s-]+/g, "_");
  return WORKOUT_ALIASES[k] ?? WORKOUT_ALIASES[k.replace(/_/g, "")] ?? "other";
}

/** Common spellings of units, mapped to the catalogue's keys. Planners and people write "hours", not "h". */
const UNIT_ALIASES: Record<string, string> = {
  hour: "h", hours: "h", hr: "h", hrs: "h", h: "h",
  minute: "minutes", minutes: "minutes", mins: "minutes", min: "minutes", m: "minutes",
  second: "s", seconds: "s", sec: "s", secs: "s",
  step: "count", steps: "count", count: "count",
  "beats per minute": "bpm", "beats/min": "bpm", bpm: "bpm",
  millisecond: "ms", milliseconds: "ms", ms: "ms",
  kilogram: "kg", kilograms: "kg", kgs: "kg", kg: "kg",
  pound: "lb", pounds: "lb", lbs: "lb", lb: "lb",
  percent: "percent", percentage: "percent", "%": "percent",
  kcal: "kcal", calories: "kcal", calorie: "kcal", cal: "kcal",
  celsius: "degC", "°c": "degC", fahrenheit: "degF", "°f": "degF",
};

/** The catalogue key for a unit as written, or the unit unchanged. */
export function normalizeUnit(metric: MetricId, unit: string): string {
  const def = CATALOGUE[metric];
  if (unit === def.unit || def.accepts[unit] !== undefined) return unit;
  const a = UNIT_ALIASES[unit.trim().toLowerCase()];
  if (a && (a === def.unit || def.accepts[a] !== undefined)) return a;
  // "minutes" for a metric whose catalogue unit is minutes
  if (a === "minutes" && def.unit === "minutes") return "minutes";
  return unit;
}

/** Convert a value to the catalogue unit. Throws on an unknown unit, so bad data never lands silently. */
export function toCatalogueUnit(metric: MetricId, value: number, unitIn: string): number {
  const def = CATALOGUE[metric];
  const unit = normalizeUnit(metric, unitIn);
  if (unit === def.unit) return value;
  const f = def.accepts[unit];
  if (f === undefined) throw new Error(`unit_not_accepted:${metric}:${unit}`);
  if (f === "f_to_c_delta") return value * (5 / 9);
  return value * f;
}

export function isPlausible(metric: MetricId, value: number): boolean {
  const [lo, hi] = CATALOGUE[metric].range;
  return Number.isFinite(value) && value >= lo && value <= hi;
}

/** A compact catalogue for the planner prompt and list_capabilities. No data. */
export function catalogueSummary() {
  return PUBLIC_METRIC_IDS.map((id) => ({ id, label: CATALOGUE[id].label, unit: CATALOGUE[id].unit }));
}
