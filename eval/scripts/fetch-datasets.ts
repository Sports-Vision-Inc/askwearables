// Download the open datasets used by the evaluation into eval/data/ (gitignored; never commit data).
//
//   npm run fetch -w @askwearables/eval                       # phia, pmdata, mmash, lifesnaps
//   npm run fetch -w @askwearables/eval -- --only phia,mmash
//   npm run fetch -w @askwearables/eval -- --pmdata-hr       # also PMData heart_rate.json (~120 MB per person)
//
// Licences are printed before each download. See docs/datasets.md for the sources and terms.
// Zip archives are extracted with the system `unzip` (Node-only script; the importers themselves never touch the file system).
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data");

export const PHIA_COMMIT = "c0abed8096641bd6dc2f8154f25558aa76a28453";
export const PHIA_REPO = "yahskapar/personal-health-insights-agent";
/** The four synthetic users PHIA's README names as its evaluation subjects, and their question files. */
export const PHIA_PERSONAS = [
  { user: "465", persona: "health_behavior" },
  { user: "333", persona: "sedentary_sleeper" },
  { user: "171", persona: "inactive_insomniacs" },
  { user: "41", persona: "active_achiver" },
] as const;
export const PMDATA_HF = "aai530-group6/pmdata";
export const PMDATA_REV = "2c97bcd6713edd075e1d88fa8401ca0b881c9464";
export const LIFESNAPS_RECORD = "7229547"; // Zenodo, latest version of 6832242
export const MMASH_ZIP = "https://physionet.org/files/mmash/1.0.0/MMASH.zip";

const LICENCES: Record<string, string> = {
  phia: "PHIA (Merrill et al., Google): CC BY-NC 4.0 (repo LICENSE). Non-commercial use only; attribution required.",
  pmdata: "PMData (Thambawita et al., Simula): Simula's page and the HF card metadata say CC BY 4.0; the dataset's own license.txt says CC BY-NC 4.0. Treat as CC BY-NC 4.0 (the stricter).",
  lifesnaps: "LifeSnaps (Yfantidou et al., Zenodo 7229547): CC BY 4.0.",
  mmash: "MMASH (Rossi et al., PhysioNet): Open Data Commons Open Database License v1.0 (ODbL 1.0); share-alike for derived databases.",
};

function args() {
  const a = process.argv.slice(2);
  const only = a.find((x) => x.startsWith("--only"));
  const onlyVal = only?.includes("=") ? only.split("=")[1] : only ? a[a.indexOf(only) + 1] : undefined;
  return {
    only: new Set((onlyVal ?? "phia,pmdata,mmash,lifesnaps").split(",").map((s) => s.trim())),
    pmdataHr: a.includes("--pmdata-hr"),
    force: a.includes("--force"),
  };
}

async function download(url: string, dest: string, force = false): Promise<number> {
  if (!force && existsSync(dest) && statSync(dest).size > 0) return statSync(dest).size;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "askwearables-eval-fetch" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      execFileSync("mv", [tmp, dest]);
      return statSync(dest).size;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`  retry ${attempt} ${url}: ${(e as Error).message}`);
    }
  }
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": "askwearables-eval-fetch" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function unzip(zip: string, into: string) {
  mkdirSync(into, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zip, "-d", into], { stdio: "inherit" });
}

function dirSize(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((a, f) => a + dirSize(join(p, f)), 0);
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

async function fetchPhia(force: boolean) {
  const base = `https://raw.githubusercontent.com/${PHIA_REPO}/${PHIA_COMMIT}`;
  const dir = join(DATA_DIR, "phia");
  const files = ["LICENSE", "README.md", "Objective Query - PHIA.xlsx", "data_utils.py"];
  for (const p of PHIA_PERSONAS) {
    files.push(`data/auto_eval/${p.persona}_final_v2.csv`);
    files.push(`synthetic_wearable_users/summary_df_${p.user}.csv`, `synthetic_wearable_users/exercise_df_${p.user}.csv`);
  }
  for (const f of files) await download(`${base}/${f.split("/").map(encodeURIComponent).join("/")}`, join(dir, f), force);
  writeFileSync(join(dir, "SOURCE.txt"), `https://github.com/${PHIA_REPO} @ ${PHIA_COMMIT}\nfetched ${new Date().toISOString()}\n${LICENCES.phia}\n`);
  return dirSize(dir);
}

async function fetchPmdata(withHr: boolean, force: boolean) {
  const tree = await json<{ type: string; path: string; size: number }[]>(
    `https://huggingface.co/api/datasets/${PMDATA_HF}/tree/${PMDATA_REV}?recursive=1`);
  const dir = join(DATA_DIR, "pmdata");
  const want = tree.filter((f) => f.type === "file" && !f.path.includes("food-images") && !f.path.startsWith(".") &&
    (withHr || !f.path.endsWith("heart_rate.json") || f.path.endsWith("resting_heart_rate.json")));
  let i = 0;
  for (const f of want) {
    i++;
    if (i % 25 === 0) console.log(`  pmdata ${i}/${want.length}`);
    await download(`https://huggingface.co/datasets/${PMDATA_HF}/resolve/${PMDATA_REV}/${f.path}`, join(dir, f.path), force);
  }
  writeFileSync(join(dir, "SOURCE.txt"), `https://huggingface.co/datasets/${PMDATA_HF} @ ${PMDATA_REV} (mirror of https://datasets.simula.no/pmdata/)\nheart_rate.json included: ${withHr}\nfetched ${new Date().toISOString()}\n${LICENCES.pmdata}\n`);
  return dirSize(dir);
}

async function fetchMmash(force: boolean) {
  const dir = join(DATA_DIR, "mmash");
  const zip = join(dir, "MMASH.zip");
  await download(MMASH_ZIP, zip, force);
  if (force || !existsSync(join(dir, "extracted"))) unzip(zip, join(dir, "extracted"));
  // The outer zip contains a nested data zip in some mirrors; unpack any we find.
  for (const z of findFiles(join(dir, "extracted"), (p) => p.endsWith(".zip"))) {
    const out = z.replace(/\.zip$/, "");
    if (!existsSync(out)) unzip(z, out);
  }
  writeFileSync(join(dir, "SOURCE.txt"), `${MMASH_ZIP}\nfetched ${new Date().toISOString()}\n${LICENCES.mmash}\n`);
  return dirSize(dir);
}

async function fetchLifesnaps(force: boolean) {
  const dir = join(DATA_DIR, "lifesnaps");
  const rec = await json<{ files: { key: string; size: number; links: { self: string } }[] }>(`https://zenodo.org/api/records/${LIFESNAPS_RECORD}`);
  const f = rec.files.find((x) => x.key === "rais_anonymized.zip");
  if (!f) throw new Error("rais_anonymized.zip not in Zenodo record");
  console.log(`  lifesnaps archive is ${mb(f.size)}`);
  if (f.size > 2e9) { console.log("  skipped: archive over 2 GB"); return 0; }
  const zip = join(dir, "rais_anonymized.zip");
  await download(f.links.self, zip, force);
  // Only the CSV variant is needed; leave the MongoDB dump packed.
  if (force || !existsSync(join(dir, "csv"))) {
    mkdirSync(join(dir, "csv"), { recursive: true });
    execFileSync("unzip", ["-q", "-o", zip, "*csv_rais_anonymized/*", "-d", join(dir, "csv")], { stdio: "inherit" });
  }
  writeFileSync(join(dir, "SOURCE.txt"), `https://zenodo.org/records/${LIFESNAPS_RECORD}\nfetched ${new Date().toISOString()}\n${LICENCES.lifesnaps}\n`);
  return dirSize(dir);
}

export function findFiles(root: string, pred: (p: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const f of readdirSync(root)) {
    const p = join(root, f);
    if (statSync(p).isDirectory()) out.push(...findFiles(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}

async function main() {
  const a = args();
  mkdirSync(DATA_DIR, { recursive: true });
  const jobs: [string, () => Promise<number>][] = [
    ["phia", () => fetchPhia(a.force)],
    ["pmdata", () => fetchPmdata(a.pmdataHr, a.force)],
    ["mmash", () => fetchMmash(a.force)],
    ["lifesnaps", () => fetchLifesnaps(a.force)],
  ];
  const summary: string[] = [];
  for (const [name, job] of jobs) {
    if (!a.only.has(name)) continue;
    console.log(`\n== ${name}\nLicence: ${LICENCES[name]}`);
    try {
      const size = await job();
      summary.push(`${name.padEnd(10)} ${mb(size).padStart(10)}  ${LICENCES[name]}`);
    } catch (e) {
      summary.push(`${name.padEnd(10)} FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`\nDatasets in ${DATA_DIR}:\n${summary.join("\n")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
