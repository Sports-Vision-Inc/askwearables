#!/usr/bin/env node
// Copies the study results into the public site, keeping only what the pages read.
//   eval/paper/out/results.json  ->  workers/site/public/data/results.json
// Run after `eval/.venv/bin/python eval/paper/report.py`:  node scripts/build-site-data.mjs
//
// It also stamps the self-hosting "Deploy to Cloudflare" button (see docs/deploy-button.md).
// Change DEPLOY_REPO_URL once the repository is public; leave DEPLOY_BUTTON_ENABLED false while
// the broker is a multi-Worker monorepo, which one button cannot deploy.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOY_REPO_URL = "https://github.com/Sports-Vision-Inc/askwearables/tree/main/selfhost";
export const DEPLOY_BUTTON_ENABLED = true;
const CLOUD = `<svg viewBox="0 0 24 16" aria-hidden="true"><path d="M19.4 6.6A7 7 0 0 0 6 5.1 5.4 5.4 0 0 0 5.6 16h13.2a4.7 4.7 0 0 0 .6-9.4z"/></svg>`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "eval/paper/out/results.json");
const out = resolve(root, "workers/site/public/data/results.json");
const MAX_FINAL = 1200; // characters of each model's final answer kept for the examples viewer

const r = JSON.parse(readFileSync(src, "utf8"));
const outDir = dirname(src);
const resDir = resolve(root, "eval/paper/results");

// The examples in results.json keep only each condition's final text. The landing page walks one C run through the
// broker, so join each example's C run back to its row in eval/paper/results/accuracy-*.jsonl (the same "last row
// wins, an error reopens the key" rule report.py uses) for what that run recorded: the questions the agent sent to
// ask_wearables, the released packet levels and, for runs that stored them, the packets themselves.
const cRows = new Map();
if (existsSync(resDir)) {
  for (const f of readdirSync(resDir).filter((x) => /^accuracy-.*\.jsonl$/.test(x)).sort()) {
    for (const line of readFileSync(resolve(resDir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.condition !== "C_broker") continue;
      cRows.set(`${row.model}\u0000${row.task}\u0000${row.run}`, row.error ? null : row);
    }
  }
}
function cRunFor(model, task, final) {
  let hit = null;
  for (const [k, row] of cRows) if (row && k.startsWith(`${model}\u0000${task}\u0000`) && (row.final ?? "").slice(-500) === final) hit = row;
  return hit;
}
function trimPacket(p) {
  if (!p || typeof p !== "object") return null;
  const dq = p.data_quality ?? {};
  return {
    level: p.level, operation: p.operation, metrics: p.metrics, window: p.window,
    findings: (p.findings ?? []).map((f) => pick(f, ["metric", "direction", "magnitude", "statement", "unknown_reason", "value", "unit", "values"])),
    data_quality: pick(dq, ["freshness_hours", "coverage", "sources", "baseline_days", "caveats"]),
    packet_id: p.packet_id ?? null,
  };
}
function brokerTrace(x) {
  const c = x.runs?.C_broker;
  if (!c) return {};
  const row = cRunFor(x.model, x.task, c.final ?? "");
  if (!row) return {};
  const asked = (row.transcript_tools ?? []).filter((t) => t.name === "ask_wearables").map((t) => {
    try { return String(JSON.parse(t.args).question ?? ""); } catch { return ""; }
  }).filter(Boolean);
  const packets = (row.packets_released ?? []).map(trimPacket).filter(Boolean);
  return { asked, levels: row.packet_levels ?? [], ...(packets.length ? { packets } : {}) };
}
// Which models are open-weights, frontier or free-tier, read from the model lists the runs used (eval/paper/llm.ts),
// so the site's "Open models" / "Frontier models" filters follow the study's own grouping.
function modelGroups() {
  const file = resolve(root, "eval/paper/llm.ts");
  if (!existsSync(file)) return {};
  const src = readFileSync(file, "utf8");
  const out = {};
  for (const [name, group] of [["OPEN_MODELS", "open"], ["FRONTIER_MODELS", "frontier"], ["FREE_MODELS", "free"]]) {
    const m = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(src);
    if (!m) continue;
    for (const e of m[1].matchAll(/\{\s*id:\s*"([^"]+)"[^}]*?family:\s*"([^"]+)"/g)) out[e[1]] = { group, family: e[2] };
  }
  return out;
}

// Opening rows of one synthetic person's export (eval/paper/exposure.ts), for the "what the agent sees" wall.
const sampleFile = resolve(outDir, "export_sample.json");
const exportSample = existsSync(sampleFile) ? JSON.parse(readFileSync(sampleFile, "utf8")) : null;
const num = (x, d = 4) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(d)) : x ?? null);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const data = {
  schema: 1,
  generated_note: r.generated_note ?? "",
  source_modified: statSync(src).mtime.toISOString(),
  conditions: r.conditions,
  models: modelGroups(),
  accuracy: (r.accuracy ?? []).map((a) => ({ model: a.model, condition: a.condition, correct: a.correct, n: a.n, rate: num(a.rate), ci: (a.ci ?? []).map((v) => num(v)) })),
  by_trap: (r.by_trap ?? []).map((a) => pick(a, ["trap", "condition", "correct", "n"])),
  by_question: (r.by_question ?? []).map((a) => pick(a, ["question", "condition", "correct", "n"])),
  privacy: (r.privacy ?? []).map((a) => pick(a, ["scenario", "condition", "leaked", "n"])),
  efficiency: (r.efficiency ?? []).map((e) => ({
    model: e.model,
    condition: e.condition,
    accuracy: num(e.accuracy),
    accuracy_ci: (e.accuracy_ci ?? []).map((v) => num(v)),
    n: e.n,
    // Context length: input tokens per question (median) for the agent model, and for the broker's planner (C only).
    agent_input_tokens: num(e.median_agent_input_tokens ?? e.median_prompt_tokens, 1),
    // The report gives planner input tokens when it has them; otherwise planner input + output (flagged).
    planner_tokens: num(e.median_planner_input_tokens ?? e.median_planner_tokens ?? 0, 1),
    planner_tokens_include_output: e.median_planner_input_tokens === undefined,
    output_tokens: num(e.median_completion_tokens, 1),
    median_latency_s: num(e.median_latency_s, 3),
    mean_cost_usd: num(e.mean_cost_usd, 6),
    cost_per_correct_usd: num(e.cost_per_correct_usd, 6),
    planner_usage_estimated: Boolean(e.planner_usage_estimated),
  })),
  // Median characters of health data delivered to the agent model per question, by condition (report.py).
  exposure_median_chars: r.exposure_median_chars
    ? Object.fromEntries(Object.entries(r.exposure_median_chars).map(([k, v]) => [k, num(v, 1)]))
    : null,
  export_sample: exportSample,
  examples: (r.examples ?? []).map((x) => ({
    id: `${x.model}/${x.task}`,
    model: x.model,
    task: x.task,
    trap: x.trap,
    question: x.question_tag,
    accept: x.accept,
    runs: Object.fromEntries(
      Object.entries(x.runs ?? {}).filter(([, v]) => v).map(([k, v]) => [k, {
        answer: v.answer ?? null,
        correct: Boolean(v.correct),
        final: typeof v.final === "string" ? (v.final.length > MAX_FINAL ? "…" + v.final.slice(-MAX_FINAL) : v.final) : "",
        tool_calls: v.tool_calls ?? null,
        ...(k === "C_broker" ? brokerTrace(x) : {}),
      }]),
    ),
  })),
};

mkdirSync(dirname(out), { recursive: true });
const text = JSON.stringify(data);
writeFileSync(out, text + "\n");
console.log(`wrote ${out.replace(root + "/", "")} (${text.length} bytes; ${data.accuracy.length} accuracy cells, ${data.examples.length} examples, ${data.privacy.length} privacy cells)`);

// Stamp the Deploy to Cloudflare button wherever the marker appears.
const deployHref = `https://deploy.workers.cloudflare.com/?url=${DEPLOY_REPO_URL}`;
for (const rel of ["workers/site/public/index.html", "workers/site/public/docs/self-hosting.html"]) {
  const file = resolve(root, rel);
  const html = readFileSync(file, "utf8");
  const next = html.replace(/<!-- deploy-button -->[\s\S]*?<!-- \/deploy-button -->/g, () => {
    const inner = DEPLOY_BUTTON_ENABLED
      ? `<a class="deploy-btn" href="${deployHref}" rel="noopener">${CLOUD}Deploy to Cloudflare</a>`
      : `<span class="deploy-btn" aria-disabled="true" data-href="${deployHref}">${CLOUD}Deploy to Cloudflare</span><span class="deploy-state">Not available for this project yet. Use the manual steps.</span>`;
    return `<!-- deploy-button -->${inner}<!-- /deploy-button -->`;
  });
  if (next !== html) { writeFileSync(file, next); console.log(`stamped deploy button in ${rel}`); }
}
