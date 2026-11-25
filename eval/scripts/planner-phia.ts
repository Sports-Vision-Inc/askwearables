// Planner honesty and agreement on PHIA: does the rule planner refuse what the operation set cannot answer,
// and pick the same operation and metric as the hand-built mapping for what it can?
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { planWithRules } from "@askwearables/core";
import { type MappingEntry, loadQuestions, loadUserFiles, toPhiaData, userToday } from "../src/phia.js";

const dataDir = resolve(import.meta.dirname, "../data");
const mapping: MappingEntry[] = JSON.parse(readFileSync(resolve(import.meta.dirname, "../phia/mapping.json"), "utf8")).entries;
const byId = new Map(mapping.map((m) => [m.id, m]));
const qs = loadQuestions(dataDir);
const todayFor = new Map<string, string>();
const c = { unsup: { n: 0, refused: 0, deferred: 0, guessed: 0 }, mapped: { n: 0, same: 0, other: 0, deferred: 0, refused: 0 } };
const guessedReasons = new Map<string, number>();
for (const q of qs) {
  const m = byId.get(q.id);
  if (!m) continue;
  if (!todayFor.has(q.user)) todayFor.set(q.user, userToday(toPhiaData(loadUserFiles(dataDir, q.user))));
  const r = planWithRules(q.question, todayFor.get(q.user)!);
  if (m.status === "unsupported") {
    c.unsup.n++;
    if (!r) c.unsup.deferred++;
    else if (r.status === "unsupported") c.unsup.refused++;
    else { c.unsup.guessed++; guessedReasons.set(m.reason ?? "?", (guessedReasons.get(m.reason ?? "?") ?? 0) + 1); }
  } else {
    c.mapped.n++;
    if (!r) c.mapped.deferred++;
    else if (r.status === "unsupported") c.mapped.refused++;
    else if (r.spec.operation === m.spec!.operation && r.spec.metrics.join() === m.spec!.metrics.join()) c.mapped.same++;
    else c.mapped.other++;
  }
}
console.log(JSON.stringify(c, null, 1));
console.log("guessed on unsupported, by mapping reason:", Object.fromEntries([...guessedReasons].sort((a, b) => b[1] - a[1])));
if (process.argv.includes("--show")) {
  let shown = 0, shownM = 0;
  for (const q of qs) {
    const m = byId.get(q.id)!; const r = planWithRules(q.question, todayFor.get(q.user)!);
    if (m.status === "unsupported" && r?.status === "ok" && shown++ < 14) console.log("GUESS", m.reason, "|", q.question, "→", r.spec.operation, r.spec.metrics.join());
    if (m.status === "mapped" && r?.status === "ok" && (r.spec.operation !== m.spec!.operation || r.spec.metrics.join() !== m.spec!.metrics.join()) && shownM++ < 14) console.log("DIFF", "|", q.question, "→ rules", r.spec.operation, r.spec.metrics.join(), "| map", m.spec!.operation, m.spec!.metrics.join());
  }
}
