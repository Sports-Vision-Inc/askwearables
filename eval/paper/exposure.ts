// Data exposure per condition: how much of the user's health record the agent model received.
// A: the whole export in the prompt. B: everything the open tools returned. C: only the packets.
// Writes eval/paper/out/exposure_a.json with the per-person export size (values and characters) for condition A,
// and eval/paper/out/export_sample.json: the opening rows of one synthetic person's export, which the site shows
// as the "wall of rows" an agent reads in condition A (synthetic data; no real person).
import { writeFileSync } from "node:fs";
import { buildStore, exportCsv, exportRows } from "./conditions.js";
import { makePeople } from "./synth.js";
const SAMPLE_PERSON = "p1";
const SAMPLE_LINES = 120;
const out: Record<string, { values: number; chars: number }> = {};
let sample: { person: string; trap: string; chars: number; lines_total: number; lines: string[] } | null = null;
for (const p of makePeople()) {
  const s = await buildStore(p);
  const csv = exportCsv(s);
  out[p.id] = { values: exportRows(s).length, chars: csv.length };
  if (p.id === SAMPLE_PERSON) {
    const lines = csv.split("\n");
    sample = { person: p.id, trap: p.trap, chars: csv.length, lines_total: lines.length, lines: lines.slice(0, SAMPLE_LINES) };
  }
}
writeFileSync(new URL("./out/exposure_a.json", import.meta.url), JSON.stringify(out, null, 1));
if (sample) writeFileSync(new URL("./out/export_sample.json", import.meta.url), JSON.stringify(sample, null, 1));
console.log(out);
