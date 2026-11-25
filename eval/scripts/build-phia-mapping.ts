// Build eval/phia/mapping.json from PHIA's objective questions (needs eval/data from fetch-datasets).
// The mapping is data: per question id, either the QuerySpec plus how the answer is extracted, or the
// reason it is unsupported. Rules live in eval/src/phia.ts (mapQuestion); review the diff after rebuilding.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapping, dataAvailable } from "../src/phia.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "../data");
if (!dataAvailable(dataDir)) {
  console.error("PHIA data missing: run `npm run fetch -w @askwearables/eval -- --only phia` first.");
  process.exit(1);
}
const entries = buildMapping(dataDir);
const out = {
  about: "PHIA objective questions (github.com/yahskapar/personal-health-insights-agent, CC BY-NC 4.0) mapped to AskWearables QuerySpecs. Question text and answers are not stored here; ids are <synthetic user>:<row in data/auto_eval/<persona>_final_v2.csv>. See eval/phia/NOTES.md.",
  generated_by: "eval/scripts/build-phia-mapping.ts",
  phia_commit: "c0abed8096641bd6dc2f8154f25558aa76a28453",
  extract_kinds: {
    "l2.value": "the finding's level 2 value (aggregate: the statistic; threshold_check: number of days meeting the condition)",
    sessions: "the level 3 session list: keep sessions whose provider activity name equals `title` (if set), take `field` (minutes = end - start), optionally slice/index in time order, then reduce",
  },
  counts: {
    questions: entries.length,
    mapped: entries.filter((e) => e.status === "mapped").length,
    unsupported: entries.filter((e) => e.status === "unsupported").length,
  },
  entries,
};
const path = join(here, "../phia/mapping.json");
// One entry per line keeps diffs reviewable.
const { entries: list, ...head } = out;
const headJson = JSON.stringify(head, null, 1).replace(/\n}$/, "");
writeFileSync(path, `${headJson},\n "entries": [\n${list.map((e) => `  ${JSON.stringify(e)}`).join(",\n")}\n ]\n}\n`);
console.log(`wrote ${path}: ${out.counts.questions} questions, ${out.counts.mapped} mapped, ${out.counts.unsupported} unsupported`);
