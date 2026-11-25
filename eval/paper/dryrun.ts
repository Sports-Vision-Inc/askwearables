// Dry run: the broker's packets for every task, with no agent model. Checks the harness and planner coverage.
import { brokerAsk, buildStore, wellnessGrant } from "./conditions.js";
import { makePeople } from "./synth.js";
import { tasksFor } from "./tasks.js";
const people = makePeople();
for (const p of people.slice(0, Number(process.argv[2] ?? 10))) {
  const s = await buildStore(p);
  for (const t of tasksFor(p)) {
    const { res } = await brokerAsk(s, t.question, wellnessGrant(p));
    const f = res.packet?.findings[0];
    console.log(`${t.id.padEnd(26)} ${res.status.padEnd(11)} ${(f?.statement ?? res.reasons?.join(",") ?? "").slice(0, 110)} | ref ${JSON.stringify(t.accept)}${res.packet?.data_quality.caveats.length ? " | cav: " + res.packet.data_quality.caveats.join("; ").slice(0, 120) : ""}`);
  }
}
