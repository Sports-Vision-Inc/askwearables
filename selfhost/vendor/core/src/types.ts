// Shared types for the AskWearables core. Every Worker and package imports from here.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type MetricId =
  | "steps"
  | "active_energy"
  | "resting_hr"
  | "heart_rate"
  | "hrv_rmssd"
  | "hrv_sdnn"
  | "sleep_duration"
  | "sleep_efficiency"
  | "sleep_stages"
  | "spo2"
  | "respiratory_rate"
  | "skin_temp_deviation"
  | "vo2max"
  | "weight"
  | "workout"
  // Sensitive categories: never released unless a grant names them one by one.
  | "blood_glucose"
  | "menstrual_cycle"
  | "ecg_classification"
  | "breathing_disturbances";

export type Operation =
  | "latest"
  | "aggregate"
  | "trend"
  | "compare_to_baseline"
  | "compare_periods"
  | "threshold_check"
  | "correlate"
  | "list_sessions";

export type Level = 0 | 1 | 2 | 3;

export type DeviceClass = "watch" | "ring" | "band" | "phone" | "scale" | "cgm" | "other";

/** Terms flags carried by a source. `no_ai`: never released to a model-facing agent. */
export interface TermsFlags {
  no_ai?: boolean;
  no_intermediary?: boolean;
  display_to_user_only?: boolean;
}

export interface DateWindow {
  /** Local date, inclusive, YYYY-MM-DD */
  start: string;
  /** Local date, inclusive, YYYY-MM-DD */
  end: string;
}

export interface QuerySpec {
  metrics: MetricId[];
  operation: Operation;
  window: DateWindow;
  granularity?: "day" | "week";
  params?: QueryParams;
}

export interface QueryParams {
  /** threshold_check */
  comparator?: "<" | "<=" | ">" | ">=";
  threshold?: number;
  /** Unit the threshold is expressed in; converted to the catalogue unit. */
  threshold_unit?: string;
  /** threshold_check: any day, all days, or count. Default "any". */
  mode?: "any" | "all" | "count";
  /** compare_periods: the period to compare against. */
  compare_window?: DateWindow;
  /** correlate: lag in days applied to the second metric (0 or 1). */
  lag_days?: 0 | 1;
  /** list_sessions */
  session_kind?: "workout" | "sleep";
  /** aggregate */
  statistic?: "total" | "mean" | "min" | "max";
}

// ---------- canonical data ----------

export interface Source {
  id: string;
  provider: string;
  device_model: string | null;
  device_class: DeviceClass;
  connected_at: string; // ISO UTC
  earliest_readable: string | null; // YYYY-MM-DD
  last_sync_at: string | null; // ISO UTC
  terms_flags: TermsFlags;
}

export type Method =
  | "measured" // device sample
  | "vendor_daily" // vendor's own daily value (e.g. resting HR for the day)
  | "derived" // computed by the broker
  | "manual"; // typed by the user

export interface CanonicalSample {
  kind: "sample";
  metric: MetricId;
  start: string; // ISO UTC
  end: string; // ISO UTC
  value: number;
  unit: string; // catalogue unit after normalization
  source_id: string;
  method: Method;
  external_id?: string;
  /** Offset of the user's local clock at the time of the sample, minutes east of UTC. */
  tz_offset_min: number;
}

export interface SleepStagesDetail {
  deep_min?: number;
  light_min?: number;
  rem_min?: number;
  awake_min?: number;
  in_bed_min?: number;
}

export interface WorkoutDetail {
  /** Mapped to WORKOUT_TYPES. */
  type: string;
  load?: number;
  distance_m?: number;
  energy_kcal?: number;
  avg_hr?: number;
  /** Free text from the provider. Only ever released at level 3. */
  title?: string;
  notes?: string;
}

export interface CanonicalSession {
  kind: "session";
  session_kind: "sleep" | "workout";
  start: string;
  end: string;
  source_id: string;
  external_id?: string;
  tz_offset_min: number;
  /** For sleep: is this the main sleep of the night (vs a nap). Default true if longest. */
  is_main?: boolean;
  detail: SleepStagesDetail | WorkoutDetail;
}

export interface CanonicalVendorScore {
  kind: "vendor_score";
  provider: string;
  name: string; // e.g. "readiness", "recovery", "body_battery", "strain"
  value: number;
  day: string;
  source_id: string;
  external_id?: string;
}

export type CanonicalRecord = CanonicalSample | CanonicalSession | CanonicalVendorScore;

// ---------- access control ----------

export type Purpose =
  | "scheduling"
  | "training_advice"
  | "sleep_coaching"
  | "general_wellness"
  | "personal_research";

export interface Grant {
  grant_id: string;
  user_id: string;
  agent_id: string;
  purpose: Purpose;
  metrics: MetricId[];
  /** Sensitive categories named one by one. */
  sensitive?: MetricId[];
  max_level: Level;
  max_window_days: number;
  daily_packet_budget: number;
  expires_at: string;
  revoked_at?: string | null;
  created_at?: string;
}

export interface Agent {
  agent_id: string;
  name: string;
  registered_by: string;
  verified_domain: string | null;
  /** A model-facing agent passes data to an LLM. Defaults to true. */
  model_facing: boolean;
}

export type DenialReason =
  | "token_invalid"
  | "grant_expired"
  | "grant_revoked"
  | "agent_mismatch"
  | "paused"
  | `metric_not_in_grant:${string}`
  | `sensitive_not_named:${string}`
  | `terms_no_ai:${string}`
  | "window_clamped"
  | "budget_exhausted"
  | "level_lowered_by_grant"
  | `purpose_mismatch:${string}`
  | "invalid_spec"
  | "unsupported";

export interface GateDecision {
  allow: boolean;
  level: Level;
  spec: QuerySpec;
  denied_metrics: MetricId[];
  excluded_sources: string[];
  reasons: string[];
}

// ---------- results ----------

export type Direction = "above" | "below" | "within" | "up" | "down" | "flat" | "unknown";
export type Magnitude = "none" | "slight" | "moderate" | "large" | "unknown";
export type DeviationBucket = "within" | "slightly" | "moderately" | "far";

export interface Finding {
  metric: MetricId;
  statement: string;
  flag?: "yes" | "no" | "unknown";
  direction?: Direction;
  magnitude?: Magnitude;
  /** level >= 2 */
  value?: number;
  unit?: string;
  values?: { day: string; value: number }[];
  /** level 3 only */
  raw?: JsonValue;
  /** Why the answer is unknown, when it is. */
  unknown_reason?: string;
}

export interface DataQuality {
  freshness_hours: number | null;
  coverage: number | null;
  sources: string[];
  baseline_days: number | null;
  caveats: string[];
}

export interface Packet {
  packet_version: "1";
  packet_id: string;
  level: Level;
  operation: Operation;
  metrics: MetricId[];
  window: DateWindow;
  findings: Finding[];
  data_quality: DataQuality;
  as_of: string;
  data_version: string;
  not_medical_advice: true;
}

/** What /v1/ask and the MCP ask tool return. The packet is repeatable; the envelope is not. */
export interface AskResponse {
  status: "ok" | "denied" | "unsupported";
  packet?: Packet;
  receipt_id?: string;
  reasons?: string[];
  supported?: string[];
  /** On a denial: a related metric the grant does allow, in words. */
  hint?: string;
}

export interface Receipt {
  receipt_id: string;
  seq: number;
  time: string;
  agent_id: string;
  grant_id: string | null;
  purpose: string | null;
  decision: "released" | "denied" | "unsupported";
  level: Level | null;
  metrics: MetricId[];
  window: DateWindow | null;
  spec: QuerySpec | null;
  packet_hash: string | null;
  reasons: string[];
  prev_hash: string;
  hash: string;
}
