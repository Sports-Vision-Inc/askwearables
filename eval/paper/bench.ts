// Benchmark task sources for the A/B/C comparison beyond the synthetic cohort (see eval/paper/BENCHMARKS.md):
//   phia  PHIA's objective questions on its 4 synthetic users, scored against PHIA's own labels.
//   real  PMData (Fitbit Versa 2) and LifeSnaps (Fitbit Sense) participants, scored against references computed
//         from the raw files by eval/paper/real_reference.py (independent of the AskWearables engine).
// Both feed the same runAgent as the synthetic suite; only the store, the question and "today" change per task.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CanonicalRecord, type LeveledFinding, type QuerySpec, type Source, addDays, ingest, migrate, upsertSource } from "@askwearables/core";
import { importLifeSnapsDaily, importLifeSnapsHourly, importPhia, importPmdata, toNumber } from "@askwearables/importers";
import { type MappingEntry, loadQuestions, loadUserFiles, PERSONAS, toPhiaData, userToday } from "../src/phia.js";
import { type Convention, REFERENCE_ANSWERS, agree2, evalPhia, parseChain } from "../src/phia-code.js";
import { type Store, memorySql } from "./conditions.js";
import type { Person, Trap } from "./synth.js";
import { type Answer, type Task, score } from "./tasks.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(here, "../data");
export const SEED = 20261124;

export interface BenchTask extends Task {
  benchmark: "phia" | "real";
  /** The user's "today": their last data day. */
  today: string;
  dataset: "phia" | "pmdata" | "lifesnaps";
  /** PHIA: "answerable" (mapped, read from the packet value) or "unsupported" (correct answer: unknown). */
  stratum?: "answerable" | "unsupported";
  /** PHIA reference values; never written to committed files. */
  phia?: { label: number | null; as_worded: number | null; window_differs: boolean; reason?: string; reason_group?: string; operation?: string; metric?: string; definition_notes?: string[]; question_hash: string; spec?: QuerySpec };
  /** Fixed spec used by the dry run's no-LLM mode (real: per template; PHIA: the mapping's spec). */
  spec?: QuerySpec;
}

export interface Bench { tasks: BenchTask[]; stores: Map<string, Store>; info: Record<string, unknown> }

/** A deterministic per-item draw for a fixed seed, independent of list order. */
const draw = (seed: number, id: string) => createHash("sha256").update(`${seed}:${id}`).digest().readUInt32BE(0);
export const hash12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Largest-remainder allocation of n across strata proportional to size, at least `min` each (capped at size). */
function allocate(sizes: Map<string, number>, n: number, min = 0): Map<string, number> {
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, number>();
  for (const [k, s] of sizes) out.set(k, Math.min(s, min));
  let left = n - [...out.values()].reduce((a, b) => a + b, 0);
  const rest = total - [...out.values()].reduce((a, b) => a + b, 0);
  const quota = [...sizes].map(([k, s]) => ({ k, q: ((s - out.get(k)!) * left) / Math.max(1, rest), cap: s - out.get(k)! }));
  for (const x of quota) { const f = Math.min(x.cap, Math.floor(x.q)); out.set(x.k, out.get(x.k)! + f); left -= f; }
  for (const x of quota.sort((a, b) => (b.q % 1) - (a.q % 1) || a.k.localeCompare(b.k))) {
    if (left <= 0) break;
    if (out.get(x.k)! < sizes.get(x.k)!) { out.set(x.k, out.get(x.k)! + 1); left--; }
  }
  return out;
}

function sampleStrata<T extends { id: string }>(items: T[], key: (t: T) => string, n: number, min = 0, seed = SEED): T[] {
  const by = new Map<string, T[]>();
  for (const t of items) (by.get(key(t)) ?? by.set(key(t), []).get(key(t))!).push(t);
  const alloc = allocate(new Map([...by].map(([k, v]) => [k, v.length])), n, min);
  return [...by].flatMap(([k, v]) => [...v].sort((a, b) => draw(seed, a.id) - draw(seed, b.id) || a.id.localeCompare(b.id)).slice(0, alloc.get(k)!));
}

/** Second-iteration PHIA sample (EVAL_PHIA_FRESH=1): drawn with its own seed from questions the study never used,
 *  excluding the study's PHIA sample and both planner-study samples (the planner prompt was revised with those in view). */
export const FRESH_SEED = 20261126;
const fresh = process.env.EVAL_PHIA_FRESH === "1";
function usedIds(): Set<string> {
  const used = new Set<string>();
  for (const f of ["planner-phia.jsonl", "planner-phia-heldout.jsonl"]) {
    const p = join(here, "results/final", f);
    if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) if (l.trim()) used.add((JSON.parse(l) as { id: string }).id);
  }
  return used;
}

function storeFor(id: string, sources: Source[], records: CanonicalRecord[]): Promise<{ store: Store; rejected: number }> {
  const sql = memorySql();
  migrate(sql);
  // The source's last sync is the end of its newest record (what a live connection would report).
  const last = records.reduce((a, r) => { const e = r.kind === "vendor_score" ? `${r.day}T23:59:59.000Z` : r.end; return e > a ? e : a; }, "");
  for (const s of sources) { s.last_sync_at = last || null; upsertSource(sql, `u_${id}`, s); }
  return ingest(sql, `u_${id}`, records).then((res) => {
    const person: Person = { id, trap: "real" as Trap, truth: [], sources, records: [], last_sync: last };
    return { store: { sql, person }, rejected: res.rejected.length };
  });
}

// ---------------------------------------------------------------- PHIA

/** Reasons whose question is computable from what A and B can see (daily export, workout list), though outside C's operation set. */
const COMPUTABLE_FROM_EXPORT = new Set(["statistic_not_offered", "composed_query_window_depends_on_another_query", "equality_threshold_not_offered"]);
/** "Last N days" read as N days ending on the user's last day (the question as worded). */
const AS_WORDED: Convention = { span: "n", anchor: "base" };
export const PHIA_ANSWERABLE = 120;
export const PHIA_UNSUPPORTED = 60;

export async function loadPhia(): Promise<Bench> {
  const mapping = (JSON.parse(readFileSync(join(here, "../phia/mapping.json"), "utf8")) as { entries: MappingEntry[] }).entries;
  const qs = new Map(loadQuestions(DATA_DIR).map((q) => [q.id, q]));
  const data = new Map<string, ReturnType<typeof toPhiaData>>(PERSONAS.map((p) => [p.user, toPhiaData(loadUserFiles(DATA_DIR, p.user))]));
  const stores = new Map<string, Store>();
  let rejected = 0;
  for (const p of PERSONAS) {
    const f = loadUserFiles(DATA_DIR, p.user);
    const b = importPhia(f.summary, f.exercise);
    const r = await storeFor(`phia${p.user}`, b.sources, b.records);
    stores.set(`phia${p.user}`, r.store);
    rejected += r.rejected;
  }
  const value = (code: string, user: string, conv: Convention) => {
    try { const v = evalPhia(parseChain(code), data.get(user)!, conv).value; return typeof v === "number" && Number.isFinite(v) ? v : null; } catch { return null; }
  };
  // Eligible answerable items: mapped, read directly from the packet value (aggregate, threshold count), numeric label
  // that PHIA's own code reproduces (16 labels in the whole set do not reproduce: reference defects, NOTES.md item 7).
  const answerable = mapping.filter((m) => {
    if (m.status !== "mapped" || m.extract?.from !== "l2.value") return false;
    const q = qs.get(m.id)!;
    const label = toNumber(q.label);
    if (label === null || !Number.isFinite(label)) return false;
    const ref = value(q.code, m.user, REFERENCE_ANSWERS);
    return ref !== null && agree2(ref, label);
  });
  const unsupported = mapping.filter((m) => m.status === "unsupported");
  let pickA = sampleStrata(answerable, (m) => `${m.user}|${m.operation}`, PHIA_ANSWERABLE);
  let pickU = sampleStrata(unsupported, (m) => m.reason!.split(":")[0]!, PHIA_UNSUPPORTED, 2);
  let excluded = 0;
  if (fresh) {
    const used = usedIds();
    for (const m of [...pickA, ...pickU]) used.add(m.id);
    const freeA = answerable.filter((m) => !used.has(m.id)), freeU = unsupported.filter((m) => !used.has(m.id));
    excluded = answerable.length - freeA.length;
    pickA = sampleStrata(freeA, (m) => `${m.user}|${m.operation}`, PHIA_ANSWERABLE, 0, FRESH_SEED);
    pickU = sampleStrata(freeU, (m) => m.reason!.split(":")[0]!, PHIA_UNSUPPORTED, 2, FRESH_SEED);
  }
  const tasks: BenchTask[] = [];
  // Seeded order (not file order), so `--limit N` takes a mix of users and strata.
  for (const m of [...pickA, ...pickU].sort((a, b) => draw(SEED + 1, a.id) - draw(SEED + 1, b.id) || a.id.localeCompare(b.id))) {
    const q = qs.get(m.id)!;
    const today = userToday(data.get(m.user)!);
    const label = toNumber(q.label);
    const base = { id: `phia${m.id.replace(":", "_")}`, person: `phia${m.user}`, question: q.question, today, benchmark: "phia" as const, dataset: "phia" as const, tag: "", trap: "" };
    if (m.status === "mapped") {
      const worded = value(q.code, m.user, AS_WORDED);
      tasks.push({ ...base, tag: `${m.operation}:${m.spec!.metrics[0]}`, trap: "phia_answerable", kind: "number", stratum: "answerable", accept: { number: label! },
        spec: m.spec!, phia: { label, as_worded: worded, window_differs: worded === null || !agree2(worded, label!), operation: m.operation!, metric: m.spec!.metrics[0]!, definition_notes: m.definition_notes ?? [], question_hash: m.question_hash, spec: m.spec! } });
    } else {
      const g = m.reason!.split(":")[0]!;
      tasks.push({ ...base, tag: `unsupported:${g}`, trap: COMPUTABLE_FROM_EXPORT.has(g) ? "phia_unsupported_computable" : "phia_unsupported_not_in_data", kind: "number", stratum: "unsupported", accept: { labels: ["unknown"] },
        phia: { label: label !== null && Number.isFinite(label) ? label : null, as_worded: null, window_differs: false, reason: m.reason!, reason_group: g, question_hash: m.question_hash } });
    }
  }
  return { tasks, stores, info: { rejected, eligible_answerable: answerable.length, unsupported_pool: unsupported.length, ...(fresh ? { sample: "fresh", seed: FRESH_SEED, answerable_excluded_as_used: excluded } : {}) } };
}

export interface PhiaScore { correct: boolean; correct_phia: boolean; correct_as_worded: boolean; correct_2pct: boolean; label_match: boolean }

/** PHIA scoring: two-significant-digit agreement with PHIA's label (agree2, as eval:phia), unknown for unsupported. */
export function scorePhia(t: BenchTask, ans: Answer | null): PhiaScore {
  const p = t.phia!;
  const num = typeof ans === "number";
  const label_match = num && p.label !== null && agree2(ans, p.label);
  if (t.stratum === "unsupported") return { correct: ans === "unknown", correct_phia: ans === "unknown", correct_as_worded: ans === "unknown", correct_2pct: ans === "unknown", label_match };
  const correct_as_worded = num && p.as_worded !== null && agree2(ans, p.as_worded);
  const correct_2pct = num && p.label !== null && Math.abs(ans - p.label) <= Math.max(Math.abs(p.label) * 0.02, 0.5);
  return { correct: label_match, correct_phia: label_match, correct_as_worded, correct_2pct, label_match };
}

/** The committed record of the PHIA selection: ids and hashes only (PHIA is CC BY-NC 4.0). */
export function phiaSampleRecord(b: Bench) {
  return {
    about: "PHIA benchmark selection (eval/paper/bench.ts loadPhia). Ids are <user>:<row> in PHIA's data/auto_eval/<persona>_final_v2.csv; question text and labels are not stored.",
    seed: SEED, answerable_target: PHIA_ANSWERABLE, unsupported_target: PHIA_UNSUPPORTED, ...b.info,
    items: b.tasks.map((t) => ({ id: t.id.replace(/^phia/, "").replace("_", ":"), stratum: t.stratum, tag: t.tag, group: t.trap, question_hash: t.phia!.question_hash, today: t.today, window_differs: t.phia!.window_differs, definition_notes: t.phia!.definition_notes ?? [] })),
  };
}

// ---------------------------------------------------------------- real (PMData, LifeSnaps)

interface RefPerson { dataset: "pmdata" | "lifesnaps"; id: string; today: string; full_days: number; traps: Record<string, unknown>; tasks: { id: string; person: string; tag: string; question: string; kind: Task["kind"]; accept: Task["accept"]; basis: unknown }[] }

export const REAL_REFERENCE = join(DATA_DIR, "benchmarks/real_reference.json");

function templateSpec(tag: string, today: string): QuerySpec | undefined {
  const y = addDays(today, -1);
  const w = (n: number) => ({ start: addDays(today, -n), end: y });
  const S: Record<string, QuerySpec> = {
    steps_total_7d: { metrics: ["steps"], operation: "aggregate", window: w(7), params: { statistic: "total" } },
    sleep_avg_7d: { metrics: ["sleep_duration"], operation: "aggregate", window: w(7), params: { statistic: "mean" } },
    rhr_yesterday: { metrics: ["resting_hr"], operation: "aggregate", window: w(1), params: { statistic: "mean" } },
    sleep_under_6h_7d: { metrics: ["sleep_duration"], operation: "threshold_check", window: w(7), params: { comparator: "<", threshold: 6, threshold_unit: "hours", mode: "any" } },
    rhr_trend_28d: { metrics: ["resting_hr"], operation: "trend", window: w(28) },
    sleep_vs_usual_3d: { metrics: ["sleep_duration"], operation: "compare_to_baseline", window: w(3) },
    steps_week_vs_prev: { metrics: ["steps"], operation: "compare_periods", window: w(7), params: { compare_window: { start: addDays(today, -14), end: addDays(today, -8) } } },
    workouts_14d: { metrics: ["workout"], operation: "list_sessions", window: w(14), params: { session_kind: "workout" } },
    rhr_avg_14d: { metrics: ["resting_hr"], operation: "aggregate", window: w(14), params: { statistic: "mean" } },
    steps_yesterday: { metrics: ["steps"], operation: "aggregate", window: w(1), params: { statistic: "total" } },
  };
  return S[tag];
}

export async function loadReal(): Promise<Bench> {
  if (!existsSync(REAL_REFERENCE)) throw new Error(`missing ${REAL_REFERENCE}: run eval/.venv/bin/python eval/paper/real_reference.py`);
  const ref = JSON.parse(readFileSync(REAL_REFERENCE, "utf8")) as { people: RefPerson[] };
  const stores = new Map<string, Store>();
  const rejected: Record<string, number> = {};
  const ls = ref.people.filter((p) => p.dataset === "lifesnaps").map((p) => p.id);
  if (ls.length) {
    const root = join(DATA_DIR, "lifesnaps/csv/rais_anonymized/csv_rais_anonymized");
    const out = await importLifeSnapsDaily(readFileSync(join(root, "daily_fitbit_sema_df_unprocessed.csv"), "utf8"), { participants: ls });
    await importLifeSnapsHourly(readFileSync(join(root, "hourly_fitbit_sema_df_unprocessed.csv"), "utf8"), { participants: ls }, out);
    for (const id of ls) {
      const b = out.get(id)!;
      const r = await storeFor(id, b.sources, b.records);
      stores.set(id, r.store);
      rejected[id] = r.rejected;
    }
  }
  for (const p of ref.people.filter((x) => x.dataset === "pmdata")) {
    const dir = join(DATA_DIR, "pmdata", p.id, "fitbit");
    const rd = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
    // Only the files the questions need: minute steps, resting HR, sleep logs and exercise logs.
    const b = await importPmdata({ "steps.json": rd("steps.json"), "resting_heart_rate.json": rd("resting_heart_rate.json"), "sleep.json": rd("sleep.json"), "exercise.json": rd("exercise.json") }, { participant: p.id });
    const r = await storeFor(p.id, b.sources, b.records);
    stores.set(p.id, r.store);
    rejected[p.id] = r.rejected;
  }
  const tasks: BenchTask[] = ref.people.flatMap((p) => p.tasks.map((t) => ({
    id: t.id, person: p.id, question: t.question, kind: t.kind, accept: t.accept, tag: t.tag, trap: naturalTrap(p),
    today: p.today, benchmark: "real" as const, dataset: p.dataset, spec: templateSpec(t.tag, p.today),
  })));
  return { tasks, stores, info: { rejected, people: ref.people.map((p) => ({ dataset: p.dataset, id: p.id, today: p.today, traps: p.traps })) } };
}

/** One label per participant for the by-trap table: the dominant natural trap in the 31 days the questions read. */
function naturalTrap(p: RefPerson): string {
  const w = (p.traps as { question_window: Record<string, number | null> }).question_window;
  const parts = [];
  if ((w.missing_steps_days ?? 0) + (w.missing_sleep_nights ?? 0) + (w.missing_rhr_days ?? 0) > 0) parts.push("missing_days");
  if ((w.low_wear_days ?? 0) > 0) parts.push("low_wear");
  if ((w.tz_changes ?? 0) > 0) parts.push("dst");
  return `${p.dataset}:${parts.join("+") || "clean"}`;
}

export const scoreReal = (t: BenchTask, ans: Answer | null) => score(t, ans);

// ---------------------------------------------------------------- reading a packet directly (dry run)

/**
 * What the packet alone answers, read mechanically at level 3 (no model): the finding's value for numbers, its
 * flag for yes/no, its direction for trends and comparisons. A number over a window the packet says is incomplete
 * ("have no ... data", or a total it calls unknown) reads as unknown, which is the real suite's missing-day rule. PHIA's
 * labels are pandas statistics over the recorded days (NaN skipped), so for PHIA the value is read as given.
 */
export function readPacket(t: Task, spec: QuerySpec, f: LeveledFinding | undefined, caveats: string[], missingIsUnknown = true): Answer {
  if (!f || f.unknown_reason) return "unknown";
  if (t.kind === "number") {
    if (f.l2.value === undefined) return "unknown";
    if (missingIsUnknown && spec.operation !== "list_sessions" && (/true total is unknown/.test(f.l2.statement) || caveats.some((c) => /have no .* data/.test(c)))) return "unknown";
    return f.l2.value;
  }
  if (t.kind === "trend") return f.l1.direction === "up" || f.l1.direction === "down" || f.l1.direction === "flat" ? f.l1.direction : "unknown";
  if (t.kind === "compare") return f.l1.direction === "up" ? "higher" : f.l1.direction === "down" ? "lower" : f.l1.direction === "flat" ? "same" : "unknown";
  // yes/no
  if (spec.operation === "compare_to_baseline") return f.l1.direction === "below" ? "yes" : f.l1.direction === "unknown" ? "unknown" : "no";
  return f.l0.flag;
}
