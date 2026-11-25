// Print RMSSD and SDNN per MMASH user night (needs eval/data from fetch-datasets --only mmash).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mmashAvailable, runMmash } from "../src/mmash.js";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
if (!mmashAvailable(dataDir)) {
  console.error("MMASH data missing: run `npm run fetch -w @askwearables/eval -- --only mmash` first.");
  process.exit(1);
}
const { nights, skipped } = await runMmash(dataDir);
console.log("user      beats  rejected   RMSSD ms   SDNN ms   store RMSSD  store SDNN");
for (const n of nights) console.log(`${n.user.padEnd(8)} ${String(n.beats).padStart(6)} ${String(n.rejected).padStart(9)} ${n.rmssd.toFixed(2).padStart(10)} ${n.sdnn.toFixed(2).padStart(9)} ${String(n.store_rmssd).padStart(12)} ${String(n.store_sdnn).padStart(11)}`);
if (skipped.length) console.log(`\nskipped: ${skipped.join("; ")}`);
