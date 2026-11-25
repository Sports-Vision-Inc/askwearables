// PHIA accuracy evaluation: map PHIA's objective questions to QuerySpecs, run them through
// ingest + compute at level 3 on the matching synthetic user, and compare with PHIA's reference answers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compute, ingest, planWithRules, upsertSource, validateQuerySpec } from "@askwearables/core";
import type { MetricId, Operation, QuerySpec } from "@askwearables/core";
import { USER, freshStore } from "@askwearables/core/testing";
import { importPhia, parseCsv, toNumber } from "@askwearables/importers";
import { type Chain, type Convention, type PhiaRow, type PhiaUserData, REFERENCE_ANSWERS, RELEASED_CODE, addDays, agree2, evalPhia, parseChain, parseCond, phiaRange } from "./phia-code.js";

export const PERSONAS = [
  { user: "465", persona: "health_behavior" },
  { user: "333", persona: "sedentary_sleeper" },
  { user: "171", persona: "inactive_insomniacs" },
  { user: "41", persona: "active_achiver" },
] as const;

export interface PhiaQuestion {
  id: string;
  user: string;
  question: string;
  label: string;
  code: string;
}

export type Extract =
  | { from: "l2.value" }
  | {
      from: "sessions";
      /** Session field: "minutes" is the session length (end - start); others are detail keys. */
      field: "minutes" | "deep_min" | "rem_min" | "light_min" | "awake_min" | "avg_hr" | "energy_kcal" | "distance_m" | null;
      /** Keep only sessions whose provider activity name (detail.title, level 3) equals this. */
      title?: string;
      /**
       * Sleep only: keep nights whose "night of" date (local start minus 12 hours, i.e. the evening the night
       * began) is in this range. PHIA files a night under the date it began; the store files it under the wake date.
       */
      night_of?: { start: string; end: string };
      slice?: { from?: number; to?: number };
      index?: number;
      reduce: "sum" | "mean" | "min" | "max" | "count" | "value";
    };

export interface MappingEntry {
  id: string;
  user: string;
  /** First 12 hex chars of a hash of the question text and code, to detect upstream changes. Question text is not stored. */
  question_hash: string;
  status: "mapped" | "unsupported";
  reason?: string;
  operation?: Operation;
  spec?: QuerySpec;
  extract?: Extract;
  /** Known, documented definition differences between PHIA's reference and the catalogue (see eval/phia/NOTES.md). */
  definition_notes?: string[];
  /** The window this question means for the user, in PHIA day terms: anchored on the last day of the user's data ("today"). */
  window_basis?: { start: string; end: string };
  /**
   * PHIA's effective window, in PHIA day terms, as its reference answers were computed: anchored on the last
   * date of the frame `during` is called on, with "last N days" spanning N + 1 days (see NOTES.md).
   */
  phia_window?: { start: string; end: string };
  /** spec.window rewritten to PHIA's effective window (sleep nights shifted to the wake date), for the reference-window run. */
  reference_window?: { start: string; end: string };
}

export function dataAvailable(dataDir: string): boolean {
  return PERSONAS.every((p) => existsSync(join(dataDir, "phia/data/auto_eval", `${p.persona}_final_v2.csv`)) && existsSync(join(dataDir, "phia/synthetic_wearable_users", `summary_df_${p.user}.csv`)));
}

export function loadQuestions(dataDir: string): PhiaQuestion[] {
  const out: PhiaQuestion[] = [];
  for (const p of PERSONAS) {
    const rows = parseCsv(readFileSync(join(dataDir, "phia/data/auto_eval", `${p.persona}_final_v2.csv`), "utf8"));
    rows.forEach((r, i) => out.push({ id: `${p.user}:${i}`, user: p.user, question: r.question ?? "", label: r.label ?? "", code: r.code ?? "" }));
  }
  return out;
}

export interface UserFiles { summary: string; exercise: string | null }

export function loadUserFiles(dataDir: string, user: string): UserFiles {
  const dir = join(dataDir, "phia/synthetic_wearable_users");
  const ex = join(dir, `exercise_df_${user}.csv`);
  return { summary: readFileSync(join(dir, `summary_df_${user}.csv`), "utf8"), exercise: existsSync(ex) ? readFileSync(ex, "utf8") : null };
}

export function toPhiaData(f: UserFiles): PhiaUserData {
  const row = (r: Record<string, string>, date: string, stamp: string): PhiaRow => {
    const num: Record<string, number> = {};
    const str: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      const n = toNumber(v);
      if (n !== null) num[k] = n;
      else if (v.trim() && !/^(nan)$/i.test(v.trim())) str[k] = v;
      else num[k] = NaN;
    }
    return { date, stamp, num, str };
  };
  const daily = parseCsv(f.summary).map((r) => row(r, r.datetime!.slice(0, 10), r.datetime!));
  const exercise = f.exercise ? parseCsv(f.exercise).map((r) => row(r, r.startTime!.slice(0, 10), r.startTime!)) : [];
  return { daily, exercise };
}

/** "Today" for a user: the last date in their data (PHIA's localize_to_date uses the same reference). */
export function userToday(d: PhiaUserData): string {
  const dates = [...d.daily.map((r) => r.date), ...d.exercise.map((r) => r.date)];
  return dates.reduce((a, b) => (b > a ? b : a));
}

export function userFirstDay(d: PhiaUserData): string {
  const dates = [...d.daily.map((r) => r.date), ...d.exercise.map((r) => r.date)];
  return dates.reduce((a, b) => (b < a ? b : a));
}

const DAILY_METRIC: Record<string, MetricId> = { steps: "steps", resting_heart_rate: "resting_hr", heart_rate_variability: "hrv_rmssd" };
const SLEEP_FIELD: Record<string, "minutes" | "deep_min" | "rem_min" | "light_min" | "awake_min"> = {
  sleep_minutes: "minutes", rem_sleep_minutes: "rem_min", deep_sleep_minutes: "deep_min", light_sleep_minutes: "light_min", awake_minutes: "awake_min",
};
const EX_FIELD: Record<string, "minutes" | "avg_hr" | "energy_kcal" | "distance_m"> = { duration: "minutes", averageHeartRate: "avg_hr", calories: "energy_kcal", distance: "distance_m" };
const STATS = new Set(["sum", "mean", "min", "max"]);

function unsupportedReasonForColumn(col: string): string {
  if (/_percent$/.test(col)) return "sleep_stage_percentage_not_in_catalogue";
  if (/active_zone_minutes|activeZoneMinutes/.test(col)) return "active_zone_minutes_not_in_catalogue";
  if (col === "stress_management_score") return "vendor_score_not_queryable";
  if (col === "bed_time" || col === "wake_up_time") return "clock_time_not_in_catalogue";
  if (col === "elevationGain") return "workout_elevation_not_in_catalogue";
  if (col === "speed") return "workout_speed_not_in_catalogue";
  if (col === "steps") return "workout_steps_not_in_catalogue";
  if (col === "activityName") return "answer_is_a_list_of_names_not_a_number";
  return `column_not_mapped:${col}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function hash12(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
}

const LAST_OF_TYPE = /^exercise_entries\.query\('activityName == "([^"]+)"'\)\['datetime'\]\.max\(\)$/;

/** Classify one question and build its mapping entry. */
export function mapQuestion(q: PhiaQuestion, d: PhiaUserData): MappingEntry {
  const base: MappingEntry = { id: q.id, user: q.user, question_hash: hash12(`${q.question}\n${q.code}`), status: "unsupported" };
  const no = (reason: string): MappingEntry => ({ ...base, status: "unsupported", reason });
  let ch: Chain;
  try {
    ch = parseChain(q.code);
  } catch (e) {
    return no(`unparsed:${(e as Error).message}`);
  }
  const today = userToday(d);
  const first = userFirstDay(d);
  // Decompose: query? during? col? post*
  let i = 0;
  const st = ch.steps;
  const query = st[i]?.k === "query" ? (st[i++] as { k: "query"; cond: string }) : undefined;
  const during = st[i]?.k === "during" ? (st[i++] as { k: "during"; arg: { literal: string } | { composed: string } }) : undefined;
  const col = st[i]?.k === "col" ? (st[i++] as { k: "col"; name: string }) : undefined;
  const post = st.slice(i);
  if (post.some((p) => p.k === "query" || p.k === "during" || p.k === "col")) return no("unsupported_chain_shape");
  const calls = post.filter((p) => p.k === "call").map((p) => (p as { fn: string }).fn);
  const last = calls[calls.length - 1];

  // PHIA's own window, for the record.
  let phiaWindow: { start: string; end: string } | undefined;
  try {
    phiaWindow = evalPhia(ch, d, REFERENCE_ANSWERS).window;
  } catch {
    phiaWindow = undefined;
  }

  // Window as the question means it: relative to "today", the last day of the user's data.
  let window: { start: string; end: string };
  let lastOfType: string | undefined;
  if (!during) window = { start: first, end: today };
  else if ("literal" in during.arg) {
    try {
      window = phiaRange(during.arg.literal, today);
    } catch {
      return no("time_expression_not_understood");
    }
  } else {
    const m = LAST_OF_TYPE.exec(during.arg.composed);
    if (!m || ch.base !== "exercise_entries" || query) return no("composed_query_window_depends_on_another_query");
    lastOfType = m[1]!;
    window = { start: first, end: today };
  }
  const withMeta = (e: MappingEntry): MappingEntry => {
    const v = validateQuerySpec(e.spec);
    if (!v.ok) return no(`spec_invalid:${v.errors.join(",")}`);
    const out: MappingEntry = { ...e, spec: v.spec, window_basis: window };
    if (phiaWindow && !lastOfType) {
      out.phia_window = phiaWindow;
      // Same relation between spec window and PHIA days as the question window has.
      out.reference_window = {
        start: addDays(phiaWindow.start, daysBetween(window.start, v.spec.window.start)),
        end: addDays(phiaWindow.end, daysBetween(window.end, v.spec.window.end)),
      };
    }
    return out;
  };
  const shifted = (w: { start: string; end: string }) => ({ start: addDays(w.start, 1), end: addDays(w.end, 1) });

  if (ch.base === "daily_metrics") {
    if (query) {
      if (col?.name !== "datetime" || last !== "count") return no("filtered_aggregate_not_offered");
      let atoms;
      try {
        atoms = parseCond(query.cond);
      } catch {
        return no("condition_not_understood");
      }
      if (atoms.length !== 1) return no("compound_condition_not_offered");
      const a = atoms[0]!;
      if (a.op === "==" || a.op === "!=") return no("equality_threshold_not_offered");
      if (typeof a.value !== "number") return no("condition_not_numeric");
      const metric = DAILY_METRIC[a.col] ?? (a.col === "sleep_minutes" ? "sleep_duration" : undefined);
      if (!metric) {
        if (SLEEP_FIELD[a.col]) return no("single_sleep_stage_threshold_not_offered");
        return no(unsupportedReasonForColumn(a.col));
      }
      const isSleep = metric === "sleep_duration";
      const spec: QuerySpec = {
        metrics: [metric], operation: "threshold_check", window: isSleep ? shifted(window) : window,
        params: { comparator: a.op, threshold: a.value, mode: "count", ...(isSleep ? { threshold_unit: "minutes" } : {}) },
      };
      return withMeta({ ...base, status: "mapped", operation: "threshold_check", spec, extract: { from: "l2.value" }, ...(isSleep ? { definition_notes: ["sleep_minutes_is_time_in_bed"] } : {}) });
    }
    if (!col) return no("unsupported_chain_shape");
    if (post.length !== 1 || !last) return no("unsupported_chain_shape");
    if (!STATS.has(last)) return no(`statistic_not_offered:${last}`);
    const metric = DAILY_METRIC[col.name];
    if (metric) {
      const spec: QuerySpec = { metrics: [metric], operation: "aggregate", window, params: { statistic: last === "sum" ? "total" : (last as "mean" | "min" | "max") } };
      return withMeta({ ...base, status: "mapped", operation: "aggregate", spec, extract: { from: "l2.value" } });
    }
    const field = SLEEP_FIELD[col.name];
    if (field) {
      // Nights that began on the window's days wake on those days or the next.
      const spec: QuerySpec = { metrics: ["sleep_duration"], operation: "list_sessions", window: { start: window.start, end: addDays(window.end, 1) }, params: { session_kind: "sleep" } };
      return withMeta({ ...base, status: "mapped", operation: "list_sessions", spec, extract: { from: "sessions", field, night_of: window, reduce: last as "sum" } });
    }
    return no(unsupportedReasonForColumn(col.name));
  }

  // exercise_entries
  let title: string | undefined = lastOfType;
  if (query) {
    let atoms;
    try {
      atoms = parseCond(query.cond);
    } catch {
      return no("condition_not_understood");
    }
    const other = atoms.find((a) => a.col !== "activityName");
    if (other) return no(other.col in EX_FIELD ? "workout_filter_on_values_not_offered" : unsupportedReasonForColumn(other.col));
    if (atoms.length !== 1 || atoms[0]!.op !== "==") return no("compound_condition_not_offered");
    title = String(atoms[0]!.value);
  }
  const spec: QuerySpec = { metrics: ["workout"], operation: "list_sessions", window, params: { session_kind: "workout" } };
  const ok = (extract: Extract, notes?: string[]) => withMeta({ ...base, status: "mapped", operation: "list_sessions", spec, extract, ...(notes ? { definition_notes: notes } : {}) });
  const t = title !== undefined ? { title } : {};
  // Counting sessions.
  if ((!col && calls.join(",") === "count") || (col?.name === "datetime" && (calls.join(",") === "count" || calls.join(",") === "drop_duplicates,count"))) {
    if (lastOfType) return no("unsupported_chain_shape");
    return ok({ from: "sessions", field: null, ...t, reduce: "count" });
  }
  if (!col) return no("unsupported_chain_shape");
  const field = EX_FIELD[col.name];
  if (!field) return no(unsupportedReasonForColumn(col.name));
  let slice: { from?: number; to?: number } | undefined;
  let index: number | undefined;
  for (const p of post) {
    if (p.k === "slice") slice = { ...(p.from !== undefined ? { from: p.from } : {}), ...(p.to !== undefined ? { to: p.to } : {}) };
    else if (p.k === "index") index = p.i;
  }
  if (index !== undefined) {
    if (calls.length) return no("unsupported_chain_shape");
    return ok({ from: "sessions", field, ...t, ...(slice ? { slice } : {}), index, reduce: "value" });
  }
  if (calls.length !== 1 || !STATS.has(last!)) return no(`statistic_not_offered:${last ?? "none"}`);
  if (lastOfType) {
    // "My mean X last run": PHIA averages every workout on the day of the last run; we read the last run itself.
    return ok({ from: "sessions", field, title: lastOfType, index: -1, reduce: "value" }, ["phia_averages_all_workouts_on_that_day"]);
  }
  return ok({ from: "sessions", field, ...t, ...(slice ? { slice } : {}), reduce: last as "sum" });
}

export function buildMapping(dataDir: string): MappingEntry[] {
  const qs = loadQuestions(dataDir);
  const data = new Map<string, PhiaUserData>(PERSONAS.map((p) => [p.user, toPhiaData(loadUserFiles(dataDir, p.user))]));
  return qs.map((q) => mapQuestion(q, data.get(q.user)!));
}

// ---------- running ----------

export interface QuestionResult {
  id: string;
  operation: Operation | "unsupported";
  status: "match" | "match_empty" | "mismatch" | "unsupported";
  ours: number | null;
  label: number | null;
  /** PHIA's reference recomputed from its released code and data (RELEASED_CODE convention; null when not computable). */
  phia_recomputed: number | null;
  /** The same under the convention PHIA's reference answers follow (REFERENCE_ANSWERS: N + 1 days, whole-table anchor). */
  phia_recomputed_n_plus_1: number | null;
  /** Our reading of PHIA's code reproduces its label. */
  label_reproduced: boolean | null;
  causes: string[];
  reason?: string;
}

interface SessionRaw { start: string; end: string; detail: Record<string, unknown> }

function extractValue(ex: Extract, f: { unknown_reason?: string; l2: { value?: number }; l3?: { raw: unknown } }): number | null {
  if (ex.from === "l2.value") return f.unknown_reason || f.l2.value === undefined ? null : f.l2.value;
  let rows = ((f.l3?.raw as SessionRaw[]) ?? []).slice();
  if (ex.title !== undefined) rows = rows.filter((r) => r.detail.title === ex.title);
  if (ex.night_of) {
    // PHIA data is imported at offset 0, so UTC dates are local dates here.
    const n = ex.night_of;
    rows = rows.filter((r) => {
      const d = new Date(Date.parse(r.start) - 12 * 3_600_000).toISOString().slice(0, 10);
      return d >= n.start && d <= n.end;
    });
  }
  const val = (r: SessionRaw) => (ex.field === "minutes" ? (Date.parse(r.end) - Date.parse(r.start)) / 60_000 : Number(r.detail[ex.field!] ?? NaN));
  let xs = rows.map((r) => (ex.field ? val(r) : 1));
  if (ex.slice) xs = xs.slice(ex.slice.from, ex.slice.to);
  if (ex.index !== undefined) {
    const v = ex.index < 0 ? xs[xs.length + ex.index] : xs[ex.index];
    return v === undefined || Number.isNaN(v) ? null : v;
  }
  if (ex.reduce === "count") return xs.length;
  const vals = xs.filter((x) => !Number.isNaN(x));
  if (ex.reduce === "sum") return vals.reduce((a, b) => a + b, 0);
  if (!vals.length) return null;
  if (ex.reduce === "mean") return vals.reduce((a, b) => a + b, 0) / vals.length;
  if (ex.reduce === "min") return Math.min(...vals);
  if (ex.reduce === "max") return Math.max(...vals);
  return null;
}

export type WindowMode = "question" | "reference";

/**
 * Run every mapped question. window "question": the spec as mapped (what the question means, anchored on
 * the user's last day). window "reference": the spec's window replaced by PHIA's effective window, to
 * separate definition differences from computation errors.
 */
export async function runPhiaEval(dataDir: string, mapping: MappingEntry[], mode: WindowMode = "question"): Promise<{ results: QuestionResult[]; rejected: number }> {
  const qs = new Map(loadQuestions(dataDir).map((q) => [q.id, q]));
  const results: QuestionResult[] = [];
  let rejected = 0;
  for (const p of PERSONAS) {
    const files = loadUserFiles(dataDir, p.user);
    const data = toPhiaData(files);
    const sql = freshStore();
    const b = importPhia(files.summary, files.exercise);
    for (const s of b.sources) upsertSource(sql, USER, s);
    rejected += (await ingest(sql, USER, b.records)).rejected.length;
    const now = new Date(`${addDays(userToday(data), 3)}T00:00:00Z`);
    for (const m of mapping.filter((x) => x.user === p.user)) {
      const q = qs.get(m.id);
      if (!q) throw new Error(`question ${m.id} not found; mapping out of date`);
      const label = toNumber(q.label);
      const recomp = (conv: Convention) => {
        try {
          const e = evalPhia(parseChain(q.code), data, conv);
          return { v: typeof e.value === "number" ? e.value : null, w: e.window };
        } catch {
          return { v: null, w: undefined };
        }
      };
      const rN = recomp(RELEASED_CODE);
      const r1 = recomp(REFERENCE_ANSWERS);
      const recomputed = rN.v;
      const same = (x: number | null) => label !== null && x !== null && (agree2(x, label) || (Number.isNaN(x) && label === 0));
      const reproduced = label === null || (recomputed === null && r1.v === null) ? null : same(recomputed) || same(r1.v);
      if (m.status !== "mapped") {
        results.push({ id: m.id, operation: "unsupported", status: "unsupported", ours: null, label, phia_recomputed: recomputed, phia_recomputed_n_plus_1: r1.v, label_reproduced: reproduced, causes: [], reason: m.reason! });
        continue;
      }
      const spec = mode === "reference" && m.reference_window ? { ...m.spec!, window: m.reference_window } : m.spec!;
      const res = compute({ sql, spec, now, includeRaw: true });
      const ex = m.extract!;
      const exUsed = mode === "reference" && ex.from === "sessions" && ex.night_of && m.phia_window ? { ...ex, night_of: m.phia_window } : ex;
      const ours = extractValue(exUsed, res.findings[0]!);
      let status: QuestionResult["status"];
      if (label === null) status = "mismatch";
      else if (ours === null) status = label === 0 && (recomputed === null || Number.isNaN(recomputed) || recomputed === 0) ? "match_empty" : "mismatch";
      else status = agree2(ours, label) ? "match" : "mismatch";
      const causes: string[] = [];
      if (status === "mismatch") {
        if (m.definition_notes?.length) causes.push(...m.definition_notes);
        if (mode === "question") {
          const w = r1.w;
          const ours = m.window_basis;
          if (same(r1.v) && w && ours) {
            const len = (x: { start: string; end: string }) => Date.parse(x.end) - Date.parse(x.start);
            if (len(w) !== len(ours)) causes.push("phia_last_n_days_spans_n_plus_1_days");
            if (w.end !== ours.end) causes.push("phia_anchor_is_last_row_of_table_not_today");
          }
        }
        if (reproduced === false) causes.push("label_not_reproducible_from_phia_code");
        if (ex.from === "sessions" && ex.field === "distance_m" && data.exercise.some((r) => (ex.title === undefined || r.str.activityName === ex.title) && r.num.distance === 0)) causes.push("phia_zero_distance_counted");
        if (ours === null) causes.push(`ours_unknown:${res.findings[0]!.unknown_reason ?? "no_value"}`);
        if (!causes.length) causes.push("unexplained");
      }
      results.push({ id: m.id, operation: m.operation!, status, ours, label, phia_recomputed: recomputed, phia_recomputed_n_plus_1: r1.v, label_reproduced: reproduced, causes });
    }
  }
  return { results, rejected };
}

export interface Table {
  rows: { operation: string; mapped: number; match: number; match_empty: number; mismatch: number; accuracy: number; explained: number; accuracy_excl_explained: number }[];
  total: { mapped: number; match: number; accuracy: number; accuracy_excl_explained: number };
  unsupported: number;
  unsupported_reasons: Record<string, number>;
  mismatch_causes: Record<string, number>;
  questions: number;
}

/** A mismatch is "explained" when every cause is a documented definition difference or a reference defect (see NOTES.md). */
export const EXPLAINED_CAUSES = new Set([
  "sleep_minutes_is_time_in_bed",
  "phia_last_n_days_spans_n_plus_1_days",
  "phia_anchor_is_last_row_of_table_not_today",
  "phia_zero_distance_counted",
  "label_not_reproducible_from_phia_code",
  "phia_averages_all_workouts_on_that_day",
]);

export function summarize(results: QuestionResult[]): Table {
  const ops = [...new Set(results.filter((r) => r.operation !== "unsupported").map((r) => r.operation))].sort();
  const explainedOf = (r: QuestionResult) => r.status === "mismatch" && r.causes.some((c) => EXPLAINED_CAUSES.has(c));
  const row = (rs: QuestionResult[], operation: string) => {
    const match = rs.filter((r) => r.status === "match").length;
    const empty = rs.filter((r) => r.status === "match_empty").length;
    const mismatch = rs.filter((r) => r.status === "mismatch").length;
    const explained = rs.filter(explainedOf).length;
    const ok = match + empty;
    return {
      operation, mapped: rs.length, match, match_empty: empty, mismatch, accuracy: rs.length ? ok / rs.length : NaN,
      explained, accuracy_excl_explained: rs.length - explained ? ok / (rs.length - explained) : NaN,
    };
  };
  const mapped = results.filter((r) => r.operation !== "unsupported");
  const rows = ops.map((op) => row(mapped.filter((r) => r.operation === op), op));
  const t = row(mapped, "all");
  const unsupported = results.filter((r) => r.status === "unsupported");
  const reasons: Record<string, number> = {};
  for (const r of unsupported) {
    const k = r.reason!.split(":")[0]!;
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const causes: Record<string, number> = {};
  for (const r of mapped.filter((x) => x.status === "mismatch")) for (const c of r.causes) causes[c] = (causes[c] ?? 0) + 1;
  return {
    rows,
    total: { mapped: t.mapped, match: t.match + t.match_empty, accuracy: t.accuracy, accuracy_excl_explained: t.accuracy_excl_explained },
    unsupported: unsupported.length,
    unsupported_reasons: reasons,
    mismatch_causes: causes,
    questions: results.length,
  };
}

export function formatTable(t: Table): string {
  const pct = (x: number) => (Number.isNaN(x) ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`);
  const lines = [
    `PHIA objective questions: ${t.questions}; mapped to a supported operation: ${t.total.mapped}; classified unsupported: ${t.unsupported}`,
    "",
    "operation          mapped  match  empty  mismatch  accuracy  (explained  acc. excl. explained)",
    ...t.rows.map((r) => `${r.operation.padEnd(18)} ${String(r.mapped).padStart(6)} ${String(r.match).padStart(6)} ${String(r.match_empty).padStart(6)} ${String(r.mismatch).padStart(9)}   ${pct(r.accuracy)}   ${String(r.explained).padStart(9)}   ${pct(r.accuracy_excl_explained)}`),
    `${"all".padEnd(18)} ${String(t.total.mapped).padStart(6)} ${String(t.total.match).padStart(13)} ${"".padStart(9)}   ${pct(t.total.accuracy)}   ${"".padStart(9)}   ${pct(t.total.accuracy_excl_explained)}`,
    "",
    "match = agrees with PHIA's reference to 2 significant digits; empty = no data on our side and PHIA's reference is 0 for an empty selection.",
    "explained = mismatch with a documented cause (eval/phia/NOTES.md).",
    "",
    "Mismatch causes:",
    ...Object.entries(t.mismatch_causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`),
    "",
    "Unsupported (100% must be classified; none answered):",
    ...Object.entries(t.unsupported_reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`),
  ];
  return lines.join("\n");
}

/**
 * Informational: run the core's rule planner (no LLM) over the questions. For an unsupported question the
 * planner must not return a spec; for a mapped one, report whether it picks the same operation and metric.
 */
export function plannerCheck(dataDir: string, mapping: MappingEntry[]) {
  const qs = new Map(loadQuestions(dataDir).map((q) => [q.id, q]));
  const todays = new Map<string, string>(PERSONAS.map((p) => [p.user, userToday(toPhiaData(loadUserFiles(dataDir, p.user)))]));
  let unsupported = 0, refused = 0, noRule = 0, guessed = 0, mapped = 0, sameOpMetric = 0;
  const guessedByOp: Record<string, number> = {};
  for (const m of mapping) {
    const q = qs.get(m.id)!;
    const plan = planWithRules(q.question, todays.get(m.user)!);
    if (m.status === "unsupported") {
      unsupported++;
      if (plan === null) noRule++;
      else if (plan.status === "unsupported") refused++;
      else {
        guessed++;
        guessedByOp[plan.spec.operation] = (guessedByOp[plan.spec.operation] ?? 0) + 1;
      }
    } else {
      mapped++;
      if (plan?.status === "ok" && plan.spec.operation === m.spec!.operation && plan.spec.metrics[0] === m.spec!.metrics[0]) sameOpMetric++;
    }
  }
  return { unsupported, refused, no_rule_matched: noRule, guessed, guessed_by_operation: guessedByOp, mapped, planner_same_operation_and_metric: sameOpMetric };
}
