// Smoke-import the real PMData and LifeSnaps files through the importers and the store.
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ingest, upsertSource } from "@askwearables/core";
import { USER, freshStore } from "@askwearables/core/testing";
import { type ImportBatch, importLifeSnapsDaily, importLifeSnapsHourly, importPmdata } from "@askwearables/importers";

export interface ImportSummary { id: string; records: number; written: number; rejected: Record<string, number>; days: number }

async function load(id: string, b: ImportBatch): Promise<ImportSummary> {
  const sql = freshStore();
  for (const s of b.sources) upsertSource(sql, USER, s);
  const res = await ingest(sql, USER, b.records);
  const rejected: Record<string, number> = {};
  for (const r of res.rejected) rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
  const days = sql.all<{ n: number }>(`SELECT COUNT(DISTINCT day) AS n FROM daily_rollups`)[0]!.n;
  return { id, records: b.records.length, written: res.written, rejected, days };
}

export const pmdataDir = (dataDir: string) => join(dataDir, "pmdata");
export const lifesnapsCsvDir = (dataDir: string) => join(dataDir, "lifesnaps/csv/rais_anonymized/csv_rais_anonymized");

export async function importPmdataParticipants(dataDir: string, participants?: string[]): Promise<ImportSummary[]> {
  const dir = pmdataDir(dataDir);
  const ps = participants ?? readdirSync(dir).filter((p) => /^p\d+$/.test(p)).sort();
  const out: ImportSummary[] = [];
  for (const p of ps) {
    const f = (rel: string) => (existsSync(join(dir, p, rel)) ? join(dir, p, rel) : null);
    const text = (rel: string) => { const x = f(rel); return x ? readFileSync(x, "utf8") : undefined; };
    const stream = (rel: string) => { const x = f(rel); return x ? (createReadStream(x, { encoding: "utf8" }) as AsyncIterable<string>) : undefined; };
    const files = {
      ...(stream("fitbit/steps.json") ? { "steps.json": stream("fitbit/steps.json")! } : {}),
      ...(stream("fitbit/heart_rate.json") ? { "heart_rate.json": stream("fitbit/heart_rate.json")! } : {}),
      ...(text("fitbit/resting_heart_rate.json") ? { "resting_heart_rate.json": text("fitbit/resting_heart_rate.json")! } : {}),
      ...(text("fitbit/sleep.json") ? { "sleep.json": text("fitbit/sleep.json")! } : {}),
      ...(text("fitbit/exercise.json") ? { "exercise.json": text("fitbit/exercise.json")! } : {}),
      ...(text("googledocs/reporting.csv") ? { "reporting.csv": text("googledocs/reporting.csv")! } : {}),
    };
    out.push(await load(p, await importPmdata(files, { participant: p })));
  }
  return out;
}

export async function importLifeSnaps(dataDir: string, participants?: string[]): Promise<ImportSummary[]> {
  const dir = lifesnapsCsvDir(dataDir);
  const opts = participants ? { participants } : {};
  const res = await importLifeSnapsDaily(createReadStream(join(dir, "daily_fitbit_sema_df_unprocessed.csv"), { encoding: "utf8" }) as AsyncIterable<string>, opts);
  await importLifeSnapsHourly(createReadStream(join(dir, "hourly_fitbit_sema_df_unprocessed.csv"), { encoding: "utf8" }) as AsyncIterable<string>, opts, res);
  const out: ImportSummary[] = [];
  for (const [id, b] of res) out.push(await load(id, b));
  return out;
}
