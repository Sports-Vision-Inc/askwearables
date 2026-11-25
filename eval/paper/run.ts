// Run the study. Writes one JSONL line per run to eval/paper/results/<suite>.jsonl, resumable.
// Usage: npx tsx eval/paper/run.ts --suite accuracy|repeat|privacy|phia|real --models open|frontier|<id,id> [--limit N]
// phia and real are the benchmark suites (eval/paper/BENCHMARKS.md): same conditions and agent loop, tasks from PHIA
// and from real Fitbit data, each anchored on the user's last data day.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Condition, buildStore, exportCsv, runAgent } from "./conditions.js";
import { FREE_MODELS, FRONTIER_MODELS, type ModelSpec, OPEN_MODELS, spend, SPEND_CAP_USD } from "./llm.js";
import { INJECTED_TITLE, SCENARIOS, scoreLeak } from "./privacy.js";
import { makePeople, TODAY, weightCanary } from "./synth.js";
import { parseAnswer, score, tasksFor } from "./tasks.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const suite = arg("suite", "accuracy")!;
const modelArg = arg("models", "open")!;
const limit = Number(arg("limit", "1000000"));
const conds = (arg("conditions", "A_raw,B_tools,C_broker")!).split(",") as Condition[];
const ALL = [...OPEN_MODELS, ...FRONTIER_MODELS, ...FREE_MODELS];
const models: ModelSpec[] = modelArg === "open" ? OPEN_MODELS : modelArg === "frontier" ? FRONTIER_MODELS : modelArg === "free" ? FREE_MODELS : modelArg === "all" ? ALL : modelArg.split(",").map((id) => ALL.find((m) => m.id === id)!).filter(Boolean);

const outDir = resolve(here, process.env.EVAL_RESULTS_DIR ?? "results");
// The frozen code version and evaluation date, recorded in every row.
const STUDY_COMMIT = process.env.STUDY_COMMIT ?? "uncommitted";
mkdirSync(outDir, { recursive: true });
const version = arg("version", "")!;
const out = resolve(outDir, `${suite}${version ? `_${version}` : ""}-${modelArg.replace(/[^a-z0-9.-]+/gi, "_")}.jsonl`);
const done = new Set<string>();
// Runs that ended in a provider error (rate limit, timeout) are retried on resume; the report keeps the last row per key.
// Last row per key wins: a later error row (including an invalidation) reopens the key.
if (existsSync(out)) for (const l of readFileSync(out, "utf8").split("\n")) if (l) { const r = JSON.parse(l); const k = `${r.condition}|${r.model}|${r.task}|${r.run}`; if (r.error) done.delete(k); else done.add(k); }
const write = (r: Record<string, unknown>) => appendFileSync(out, JSON.stringify({ commit: STUDY_COMMIT, ...r }) + "\n");

/** Round-robin across models so a slow or rate-limited model does not occupy every worker. */
function interleave<T extends { m: ModelSpec }>(jobs: T[]): T[] {
  const by = new Map<string, T[]>();
  for (const j of jobs) (by.get(j.m.id) ?? by.set(j.m.id, []).get(j.m.id)!).push(j);
  const lists = [...by.values()];
  const out: T[] = [];
  for (let i = 0; out.length < jobs.length; i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return out;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      // An exception becomes an error row (retried on resume), never a crashed lane.
      try { await fn(item); } catch (e) {
        const j = item as unknown as { m: ModelSpec; c: string; t?: { id: string }; s?: { id: string }; p?: { id: string }; run: number };
        write({ suite, condition: j.c, model: j.m.id, task: j.t?.id ?? `${j.s?.id}:${j.p?.id}`, run: j.run, error: `exception:${(e as Error).message?.slice(0, 200)}` });
      }
    }
  }));
}

const people = makePeople(suite === "privacy" ? INJECTED_TITLE : undefined);

if (suite === "accuracy" || suite === "repeat") {
  const stores = new Map(await Promise.all(people.map(async (p) => [p.id, await buildStore(p)] as const)));
  let tasks = people.flatMap(tasksFor);
  // Repeatability: 20 tasks (two per person), several runs each.
  const runs = suite === "repeat" ? Number(arg("runs", "5")) : 1;
  if (suite === "repeat") tasks = tasks.filter((t) => ["sleep_avg_7d", "sleep_vs_usual_3d"].includes(t.tag));
  tasks = tasks.slice(0, limit);
  const jobs = models.flatMap((m) => conds.flatMap((c) => tasks.flatMap((t) => Array.from({ length: runs }, (_, run) => ({ m, c, t, run })))))
    .filter((j) => !done.has(`${j.c}|${j.m.id}|${j.t.id}|${j.run}`));
  console.log(`${suite}: ${jobs.length} runs to do (${models.length} models × ${conds.length} conditions × ${tasks.length} tasks × ${runs})`);
  let n = 0;
  await pool(interleave(jobs), Number(process.env.EVAL_POOL ?? 60), async ({ m, c, t, run }) => {
    const r = await runAgent(c, m, stores.get(t.person)!, t.question);
    const ans = parseAnswer(r.final);
    write({ suite, today: TODAY, condition: c, model: m.id, provider: m.provider, task: t.id, tag: t.tag, trap: t.trap, run, answer: ans, correct: score(t, ans), accept: t.accept, ...r, packets: undefined, final: r.final?.slice(-600) ?? null, packet_levels: r.packets?.map((p) => p.packet?.level ?? p.status), packet_reasons: r.packets?.map((p) => (p.status === "ok" ? null : p.reasons ?? null)), packets_released: r.packets?.map((p) => p.packet ?? null) });
    if (++n % 50 === 0) console.log(`  ${n}/${jobs.length}  openrouter spend $${spend.openrouter.toFixed(2)} (cap $${SPEND_CAP_USD})`);
  });
}

if (suite === "privacy") {
  const canaries = new Map(people.map((p) => [p.id, weightCanary(p)]));
  const stores = new Map(await Promise.all(people.map(async (p) => [p.id, await buildStore(p, canaries.get(p.id)!.records)] as const)));
  const subset = people.slice(0, Number(arg("people", "10")));
  const runs = Number(arg("runs", "1"));
  const jobs = models.flatMap((m) => conds.flatMap((c) => SCENARIOS.flatMap((s) => subset.flatMap((p) => Array.from({ length: runs }, (_, run) => ({ m, c, s, p, run }))))))
    .filter((j) => !done.has(`${j.c}|${j.m.id}|${j.s.id}:${j.p.id}|${j.run}`));
  console.log(`privacy: ${jobs.length} runs to do`);
  await pool(interleave(jobs), Number(process.env.EVAL_POOL ?? 60), async ({ m, c, s, p, run }) => {
    const r = await runAgent(c, m, stores.get(p.id)!, s.prompt, { system: s.system, grant: s.grant(p) });
    const leak = scoreLeak(s, p, canaries.get(p.id)!.value, r.final);
    write({ suite, today: TODAY, condition: c, model: m.id, provider: m.provider, task: `${s.id}:${p.id}`, scenario: s.id, person: p.id, run, ...leak, ...r, packets: undefined, final: r.final?.slice(-1500) ?? null, packet_levels: r.packets?.map((x) => x.packet?.level ?? x.status), packet_reasons: r.packets?.map((x) => (x.status === "ok" ? null : x.reasons ?? null)) });
  });
}

if (suite === "phia" || suite === "real") {
  const { loadPhia, loadReal, scorePhia, scoreReal } = await import("./bench.js");
  const bench = suite === "phia" ? await loadPhia() : await loadReal();
  const tasks = bench.tasks.slice(0, limit);
  const aChars = new Map<string, number>();
  const exportChars = (id: string) => aChars.get(id) ?? aChars.set(id, exportCsv(bench.stores.get(id)!).length).get(id)!;
  const h12 = (x: string) => createHash("sha256").update(x).digest("hex").slice(0, 12);
  // PHIA is CC BY-NC 4.0: committed rows carry ids, hashes and parsed answers only. The full row (final text, tool
  // arguments, packets) goes to eval/data/results/, which is gitignored.
  const fullOut = resolve(here, "../data/results", out.split("/").at(-1)!.replace(/\.jsonl$/, ".full.jsonl"));
  if (suite === "phia") mkdirSync(dirname(fullOut), { recursive: true });
  const jobs = models.flatMap((m) => conds.flatMap((c) => tasks.map((t) => ({ m, c, t, run: 0 })))).filter((j) => !done.has(`${j.c}|${j.m.id}|${j.t.id}|${j.run}`));
  console.log(`${suite}: ${jobs.length} runs to do (${models.length} models × ${conds.length} conditions × ${tasks.length} tasks); ingest rejected ${JSON.stringify(bench.info.rejected)}`);
  let n = 0;
  await pool(interleave(jobs), Number(process.env.EVAL_POOL ?? 60), async ({ m, c, t, run }) => {
    const r = await runAgent(c, m, bench.stores.get(t.person)!, t.question, { today: t.today });
    const ans = parseAnswer(r.final);
    const base = { suite, benchmark: suite, dataset: t.dataset, today: t.today, condition: c, model: m.id, provider: m.provider, task: t.id, person: t.person, tag: t.tag, trap: t.trap, run, answer: ans, ...(c === "A_raw" ? { a_export_chars: exportChars(t.person) } : {}) };
    const full = { ...r, packets: undefined, final: r.final?.slice(-600) ?? null, packet_levels: r.packets?.map((p) => p.packet?.level ?? p.status), packet_reasons: r.packets?.map((p) => (p.status === "ok" ? null : p.reasons ?? null)), packets_released: r.packets?.map((p) => p.packet ?? null) };
    if (suite === "real") {
      write({ ...base, correct: scoreReal(t, ans), accept: t.accept, ...full });
    } else {
      const sc = scorePhia(t, ans);
      const p = t.phia!;
      const meta = { stratum: t.stratum, ...sc, question_hash: p.question_hash, window_differs: p.window_differs, definition_notes: p.definition_notes ?? [], reason_group: p.reason_group ?? null,
        // No label in committed files: answerable items are scored against PHIA's label at run time.
        accept: t.stratum === "unsupported" ? { labels: ["unknown"] } : { phia_label: true } };
      const answerLine = [...(r.final ?? "").matchAll(/ANSWER:\s*[^\n]*/gi)].at(-1)?.[0] ?? null;
      write({ ...base, ...meta, ...full, final: answerLine, reasoning: undefined, packets_released: undefined, transcript_tools: r.transcript_tools.map((x) => ({ name: x.name, args_hash: h12(x.args), result_chars: x.result_chars })) });
      appendFileSync(fullOut, JSON.stringify({ ...base, ...meta, ...full }) + "\n");
    }
    if (++n % 50 === 0) console.log(`  ${n}/${jobs.length}  openrouter spend $${spend.openrouter.toFixed(2)} (cap $${SPEND_CAP_USD})`);
  });
}

console.log(`done. openrouter spend this process: $${spend.openrouter.toFixed(2)}; workers-ai calls: ${spend.workersAiCalls}`);
