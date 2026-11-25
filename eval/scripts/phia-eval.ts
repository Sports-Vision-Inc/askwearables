// Run the PHIA accuracy evaluation and print the per-operation table.
//   npm run eval:phia -w @askwearables/eval
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type MappingEntry, dataAvailable, formatTable, plannerCheck, runPhiaEval, summarize } from "../src/phia.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "../data");
if (!dataAvailable(dataDir)) {
  console.error("PHIA data missing: run `npm run fetch -w @askwearables/eval -- --only phia` first.");
  process.exit(1);
}
const mapping = (JSON.parse(readFileSync(join(here, "../phia/mapping.json"), "utf8")) as { entries: MappingEntry[] }).entries;
const q = await runPhiaEval(dataDir, mapping, "question");
const r = await runPhiaEval(dataDir, mapping, "reference");
const table = summarize(q.results);
const refTable = summarize(r.results);
console.log("== Windows as the questions mean them (anchored on the user's last day; \"last N days\" = N days)\n");
console.log(formatTable(table));
console.log("\n== Same specs with PHIA's effective windows (how its reference answers were computed)\n");
console.log(formatTable(refTable).split("\n\nUnsupported")[0]);
const pc = plannerCheck(dataDir, mapping);
console.log(`\n== Rule planner (packages/core planWithRules, no LLM) on the same questions, informational\n`);
console.log(`unsupported questions: ${pc.unsupported}; planner refused: ${pc.refused}; no rule matched (would go to the LLM): ${pc.no_rule_matched}; planner returned a spec (a guess): ${pc.guessed} ${JSON.stringify(pc.guessed_by_operation)}`);
console.log(`mapped questions: ${pc.mapped}; planner chose the same operation and metric: ${pc.planner_same_operation_and_metric}`);
if (q.rejected) console.log(`\nWARNING: ${q.rejected} records rejected on ingest`);
mkdirSync(join(dataDir, "results"), { recursive: true });
writeFileSync(join(dataDir, "results/phia-results.json"), JSON.stringify({ table, reference_table: refTable, planner: pc, results: q.results, reference_results: r.results }, null, 1));
console.log(`\nPer-question results: ${join(dataDir, "results/phia-results.json")} (gitignored)`);
