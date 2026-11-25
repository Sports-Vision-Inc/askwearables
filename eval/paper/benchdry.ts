// Benchmark dry run: the C-condition packet for every benchmark task next to its reference, with no agent model.
// The packet is also read directly at level 3 (value, flag or direction, no model) and scored against the reference:
// this checks the references and the importers, not the agents.
//
//   npx tsx eval/paper/benchdry.ts --suite phia|real [--planner llm|none] [--limit N] [--quiet]
//
// --planner llm (default): the deployed LLM planner (llama-3.3-70b on Workers AI) turns the question into a spec,
//   exactly as in condition C; the printed packet is the one C's agent would receive (grant level 2).
// --planner none: fixed specs, no API calls (PHIA: the hand-built mapping's spec; real: one spec per template).
// Writes eval/paper/out/benchdry_<suite>_<planner>.json (summary; PHIA ids only) and per-task detail to
// eval/data/benchmarks/benchdry_<suite>_<planner>.jsonl (gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AskResponse, type QuerySpec, compute, validateQuerySpec } from "@askwearables/core";
import { type BenchTask, DATA_DIR, loadPhia, loadReal, phiaSampleRecord, readPacket, scorePhia, scoreReal } from "./bench.js";
import { brokerAsk, wellnessGrant } from "./conditions.js";
import type { Answer } from "./tasks.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const suite = arg("suite", "real") as "phia" | "real";
const planner = arg("planner", "llm") as "llm" | "none";
const quiet = process.argv.includes("--quiet");
const bench = suite === "phia" ? await loadPhia() : await loadReal();
const tasks = bench.tasks.slice(0, Number(arg("limit", "100000")));
const here = import.meta.dirname;
if (suite === "phia") {
  mkdirSync(join(here, "benchmarks"), { recursive: true });
  writeFileSync(join(here, "benchmarks/phia_sample.json"), JSON.stringify(phiaSampleRecord(bench), null, 1) + "\n");
}
console.log(`${suite}: ${tasks.length} tasks, planner ${planner}; ingest rejected ${JSON.stringify(bench.info.rejected)}`);

interface Row { t: BenchTask; status: string; spec?: QuerySpec; statement: string; caveats: string[]; read: Answer; correct: boolean; as_worded?: boolean; cause?: string }
const rows: Row[] = [];

async function one(t: BenchTask): Promise<Row> {
  const s = bench.stores.get(t.person)!;
  let spec: QuerySpec | undefined;
  let res: AskResponse | undefined;
  if (planner === "llm") {
    const r = await brokerAsk(s, t.question, wellnessGrant(s.person), undefined, t.today);
    if (r.planner_calls.length && r.planner_calls.every((c) => c.error)) throw new Error(`planner unavailable: ${r.planner_calls[0]!.error}`);
    res = r.res;
    spec = r.spec;
  } else if (t.spec) {
    const v = validateQuerySpec(t.spec);
    if (!v.ok) throw new Error(`${t.id}: fixed spec invalid ${v.errors.join(",")}`);
    spec = v.spec;
  }
  let read: Answer = "unknown";
  let statement = res?.reasons?.join(",") ?? "unsupported";
  let caveats: string[] = [];
  const status = res ? res.status : spec ? "ok" : "unsupported";
  if (spec && status === "ok") {
    // Level 3, read directly: the same spec computed with raw detail, as the store owner would see it.
    const out = compute({ sql: s.sql, spec, now: new Date(`${t.today}T15:00:00Z`), includeRaw: true });
    const f = out.findings[0];
    caveats = out.quality.caveats;
    read = readPacket(t, spec, f, caveats, suite === "real");
    statement = res?.packet?.findings[0]?.statement ?? f?.l2.statement ?? "";
  }
  if (suite === "phia") {
    const sc = scorePhia(t, read);
    return { t, status, spec, statement, caveats, read, correct: sc.correct, as_worded: sc.correct_as_worded };
  }
  return { t, status, spec, statement, caveats, read, correct: scoreReal(t, read) };
}

/** The main reason a direct reading disagrees with the reference. */
function cause(r: Row): string {
  const t = r.t;
  if (r.status !== "ok") return t.stratum === "unsupported" ? "ok" : `packet_${r.status}`;
  if (suite === "phia") {
    if (t.stratum === "unsupported") return "planner_answered_unsupported_question";
    if (r.as_worded) return "phia_window_convention (correct as worded)";
    if (t.phia!.definition_notes?.length) return t.phia!.definition_notes.join("+");
    if (r.spec && t.phia!.spec && (r.spec.operation !== t.phia!.spec.operation || r.spec.metrics[0] !== t.phia!.spec.metrics[0])) return `planner_chose_${r.spec.operation}:${r.spec.metrics[0]}`;
    if (r.spec && t.phia!.spec && (r.spec.window.start !== t.phia!.spec.window.start || r.spec.window.end !== t.phia!.spec.window.end)) return "planner_window_differs";
    const near = (x: number | null) => typeof r.read === "number" && x !== null && Math.abs(r.read - x) <= Math.abs(x) * 0.02;
    if (near(t.phia!.label) || near(t.phia!.as_worded)) return "two_significant_digit_rounding_boundary (within 2%)";
    return r.read === "unknown" ? "packet_unknown" : "value_differs";
  }
  const ref = t.accept;
  if (r.spec && t.spec && (r.spec.operation !== t.spec.operation || r.spec.metrics[0] !== t.spec.metrics[0])) return `planner_chose_${r.spec.operation}:${r.spec.metrics[0]}`;
  if (r.spec && t.spec && (r.spec.window.start !== t.spec.window.start || r.spec.window.end !== t.spec.window.end)) return "planner_window_differs";
  if (r.read === "unknown") return ref.number !== undefined ? "packet_unknown_reference_has_value" : "packet_unknown_reference_label";
  if (typeof r.read === "number" && ref.number === undefined) return "packet_value_reference_unknown (missing day)";
  if (typeof r.read === "number") return `value_differs_${t.tag}`;
  return `label_differs_${t.tag}`;
}

let i = 0;
await Promise.all(Array.from({ length: planner === "llm" ? 8 : 1 }, async () => {
  while (i < tasks.length) {
    const t = tasks[i++]!;
    let r: Row;
    try { r = await one(t); } catch (e) { console.log(`${t.id} ERROR ${(e as Error).message}`); continue; }
    r.cause = r.correct ? "ok" : cause(r);
    rows.push(r);
    if (!quiet) {
      const ref = suite === "phia" ? (t.stratum === "unsupported" ? "unknown" : `label ${t.phia!.label} | as worded ${t.phia!.as_worded}`) : JSON.stringify(t.accept);
      console.log(`${t.id.padEnd(30)} ${r.status.padEnd(11)} read ${String(r.read).padEnd(10)} ${r.correct ? "MATCH   " : "mismatch"} ref ${ref} | ${r.statement.slice(0, 110)}${r.caveats.length ? " | cav: " + r.caveats.join("; ").slice(0, 120) : ""}`);
    }
  }
}));

// ---------------------------------------------------------------- summary
const pct = (k: number, n: number) => `${k}/${n} (${n ? ((100 * k) / n).toFixed(1) : "–"}%)`;
const group = (key: (r: Row) => string) => {
  const g = new Map<string, Row[]>();
  for (const r of rows) (g.get(key(r)) ?? g.set(key(r), []).get(key(r))!).push(r);
  return [...g].sort((a, b) => a[0].localeCompare(b[0])).map(([k, rs]) => ({ key: k, n: rs.length, match: rs.filter((r) => r.correct).length, ...(suite === "phia" ? { match_as_worded: rs.filter((r) => r.as_worded).length } : {}) }));
};
const causes: Record<string, number> = {};
for (const r of rows) if (!r.correct) causes[r.cause!] = (causes[r.cause!] ?? 0) + 1;
const summary = {
  suite, planner, tasks: rows.length, match: rows.filter((r) => r.correct).length,
  ...(suite === "phia" ? { match_as_worded: rows.filter((r) => r.as_worded).length, match_either: rows.filter((r) => r.correct || r.as_worded).length } : {}),
  by_stratum: group((r) => (suite === "phia" ? r.t.stratum! : r.t.dataset)),
  by_tag: group((r) => r.t.tag),
  causes: Object.fromEntries(Object.entries(causes).sort((a, b) => b[1] - a[1])),
  packet_status: Object.fromEntries(group((r) => r.status).map((x) => [x.key, x.n])),
};
console.log(`\n== ${suite} dry run (${planner === "llm" ? "LLM planner, as in C" : "fixed specs, no LLM"}): packet read directly at level 3 matches the reference on ${pct(summary.match, summary.tasks)}`);
if (suite === "phia") console.log(`   matches PHIA's label: ${pct(summary.match, summary.tasks)}; matches the question as worded: ${pct(summary.match_as_worded!, summary.tasks)}; either: ${pct(summary.match_either!, summary.tasks)}`);
for (const s of summary.by_stratum) console.log(`   ${s.key.padEnd(12)} ${pct(s.match, s.n)}${"match_as_worded" in s ? `  as worded ${pct(s.match_as_worded as number, s.n)}` : ""}`);
console.log("   by question:");
for (const s of summary.by_tag) console.log(`     ${s.key.padEnd(44)} ${pct(s.match, s.n)}${"match_as_worded" in s ? `  as worded ${pct(s.match_as_worded as number, s.n)}` : ""}`);
console.log("   mismatch causes:");
for (const [k, v] of Object.entries(summary.causes)) console.log(`     ${String(v).padStart(4)}  ${k}`);
mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, `out/benchdry_${suite}_${planner}.json`), JSON.stringify(summary, null, 1) + "\n");
mkdirSync(resolve(DATA_DIR, "benchmarks"), { recursive: true });
writeFileSync(resolve(DATA_DIR, `benchmarks/benchdry_${suite}_${planner}.jsonl`), rows.map((r) => JSON.stringify({ id: r.t.id, tag: r.t.tag, status: r.status, spec: r.spec, read: r.read, correct: r.correct, as_worded: r.as_worded, cause: r.cause, accept: r.t.accept, phia: r.t.phia, statement: r.statement, caveats: r.caveats })).join("\n") + "\n");
