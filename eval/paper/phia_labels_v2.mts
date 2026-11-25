// Reference values for the second-iteration PHIA sample, for eval/paper/phia_failures.py (EVAL_PHIA_V2=1).
// Written to eval/data/benchmarks/ (gitignored): PHIA is CC BY-NC 4.0, so labels are not committed.
// Usage: EVAL_PHIA_FRESH=1 npx tsx eval/paper/phia_labels_v2.mts
import { writeFileSync } from "node:fs";
import { loadPhia } from "./bench.ts";
const b = await loadPhia();
const lines = b.tasks.map((t) => JSON.stringify({ id: t.id, stratum: t.stratum, phia: { label: t.phia!.label, as_worded: t.phia!.as_worded } }));
writeFileSync(new URL("../data/benchmarks/phia_labels_v2.jsonl", import.meta.url), lines.join("\n") + "\n");
console.log("labels", lines.length);
