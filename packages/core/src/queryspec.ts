// QuerySpec: the planner's only output. Anything that does not validate is rejected.
import { CATALOGUE, METRIC_IDS, OPERATIONS, normalizeUnit } from "./catalogue.js";
import type { MetricId, Operation, QuerySpec } from "./types.js";
import { isDate, daysBetween } from "./time.js";

export type ValidationResult = { ok: true; spec: QuerySpec } | { ok: false; errors: string[] };

const COMPARATORS = ["<", "<=", ">", ">="] as const;
const PARAM_KEYS = new Set([
  "comparator",
  "threshold",
  "threshold_unit",
  "mode",
  "compare_window",
  "lag_days",
  "session_kind",
  "statistic",
]);
/** A spec can never ask for more than two years in one go. The gate clamps further. */
export const MAX_SPEC_DAYS = 730;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkWindow(w: unknown, name: string, errors: string[]) {
  if (!isObj(w)) return void errors.push(`${name}:missing`);
  const keys = Object.keys(w);
  if (keys.some((k) => k !== "start" && k !== "end")) errors.push(`${name}:unknown_key`);
  if (!isDate(w.start) || !isDate(w.end)) return void errors.push(`${name}:bad_date`);
  if ((w.start as string) > (w.end as string)) errors.push(`${name}:start_after_end`);
  else if (daysBetween(w.start as string, w.end as string) + 1 > MAX_SPEC_DAYS) errors.push(`${name}:too_long`);
}

/** Validate untrusted input (planner output, REST body) into a QuerySpec. Strict: unknown keys fail. */
export function validateQuerySpec(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["not_an_object"] };
  for (const k of Object.keys(input)) {
    if (!["metrics", "operation", "window", "granularity", "params"].includes(k)) errors.push(`unknown_key:${k}`);
  }
  const op = input.operation;
  if (typeof op !== "string" || !OPERATIONS.includes(op as Operation)) errors.push("operation:invalid");
  const metrics = input.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) errors.push("metrics:missing");
  else {
    if (metrics.length > 2) errors.push("metrics:too_many");
    for (const mt of metrics) if (typeof mt !== "string" || !METRIC_IDS.includes(mt as MetricId)) errors.push(`metrics:unknown:${String(mt)}`);
    if (new Set(metrics).size !== metrics.length) errors.push("metrics:duplicate");
  }
  checkWindow(input.window, "window", errors);
  if (input.granularity !== undefined && input.granularity !== "day" && input.granularity !== "week") errors.push("granularity:invalid");

  const params = input.params ?? {};
  if (!isObj(params)) errors.push("params:invalid");
  else {
    for (const k of Object.keys(params)) if (!PARAM_KEYS.has(k)) errors.push(`params:unknown_key:${k}`);
    if (params.comparator !== undefined && !COMPARATORS.includes(params.comparator as never)) errors.push("params:comparator");
    if (params.threshold !== undefined && (typeof params.threshold !== "number" || !Number.isFinite(params.threshold))) errors.push("params:threshold");
    if (params.threshold_unit !== undefined && typeof params.threshold_unit !== "string") errors.push("params:threshold_unit");
    if (params.mode !== undefined && !["any", "all", "count"].includes(params.mode as string)) errors.push("params:mode");
    if (params.compare_window !== undefined) checkWindow(params.compare_window, "params.compare_window", errors);
    if (params.lag_days !== undefined && params.lag_days !== 0 && params.lag_days !== 1) errors.push("params:lag_days");
    if (params.session_kind !== undefined && params.session_kind !== "workout" && params.session_kind !== "sleep") errors.push("params:session_kind");
    if (params.statistic !== undefined && !["total", "mean", "min", "max"].includes(params.statistic as string)) errors.push("params:statistic");
  }

  if (errors.length === 0) {
    const ms = metrics as MetricId[];
    const p = params as Record<string, unknown>;
    switch (op as Operation) {
      case "correlate":
        if (ms.length !== 2) errors.push("correlate:needs_two_metrics");
        break;
      case "threshold_check":
        if (ms.length !== 1) errors.push("threshold_check:one_metric");
        if (p.comparator === undefined || p.threshold === undefined) errors.push("threshold_check:needs_comparator_and_threshold");
        if (p.threshold_unit !== undefined) {
          const def = CATALOGUE[ms[0]!];
          const u = normalizeUnit(ms[0]!, p.threshold_unit as string);
          if (u !== def.unit && def.accepts[u] === undefined) errors.push("params:threshold_unit_not_accepted");
          else p.threshold_unit = u;
        }
        break;
      case "compare_periods":
        if (p.compare_window === undefined) errors.push("compare_periods:needs_compare_window");
        if (ms.length !== 1) errors.push("compare_periods:one_metric");
        break;
      case "list_sessions":
        if (!ms.every((x) => x === "workout" || x === "sleep_duration")) errors.push("list_sessions:metric_must_be_workout_or_sleep_duration");
        break;
      default:
        if (ms.length !== 1) errors.push(`${op as string}:one_metric`);
    }
  }
  if (errors.length) return { ok: false, errors };
  // Rebuild so no extra properties survive.
  const p = (input.params ?? {}) as QuerySpec["params"] & object;
  const spec: QuerySpec = {
    metrics: [...(input.metrics as MetricId[])],
    operation: op as Operation,
    window: { start: (input.window as { start: string }).start, end: (input.window as { end: string }).end },
    granularity: (input.granularity as "day" | "week" | undefined) ?? "day",
    params: canonicalParams(p),
  };
  return { ok: true, spec };
}

function canonicalParams(p: NonNullable<QuerySpec["params"]>): NonNullable<QuerySpec["params"]> {
  const out: NonNullable<QuerySpec["params"]> = {};
  if (p.comparator !== undefined) out.comparator = p.comparator;
  if (p.threshold !== undefined) out.threshold = p.threshold;
  if (p.threshold_unit !== undefined) out.threshold_unit = p.threshold_unit;
  if (p.mode !== undefined) out.mode = p.mode;
  if (p.compare_window !== undefined) out.compare_window = { start: p.compare_window.start, end: p.compare_window.end };
  if (p.lag_days !== undefined) out.lag_days = p.lag_days;
  if (p.session_kind !== undefined) out.session_kind = p.session_kind;
  if (p.statistic !== undefined) out.statistic = p.statistic;
  return out;
}

/** JSON schema handed to the LLM planner for structured output. Mirrors validateQuerySpec. */
export function querySpecJsonSchema() {
  const window = {
    type: "object",
    additionalProperties: false,
    required: ["start", "end"],
    properties: {
      start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      end: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["supported"],
    properties: {
      supported: { type: "boolean", description: "false if the question cannot be answered with the catalogue and operations" },
      spec: {
        type: "object",
        additionalProperties: false,
        required: ["metrics", "operation", "window"],
        properties: {
          metrics: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: METRIC_IDS.filter((id) => !CATALOGUE[id].sensitive) } },
          operation: { type: "string", enum: OPERATIONS },
          window,
          granularity: { type: "string", enum: ["day", "week"] },
          params: {
            type: "object",
            additionalProperties: false,
            properties: {
              comparator: { type: "string", enum: [...COMPARATORS] },
              threshold: { type: "number" },
              threshold_unit: { type: "string" },
              mode: { type: "string", enum: ["any", "all", "count"] },
              compare_window: window,
              lag_days: { type: "integer", enum: [0, 1] },
              session_kind: { type: "string", enum: ["workout", "sleep"] },
              statistic: { type: "string", enum: ["total", "mean", "min", "max"] },
            },
          },
        },
      },
    },
  } as const;
}
