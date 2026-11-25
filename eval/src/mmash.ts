// MMASH HRV check: per user, RMSSD and SDNN for the night from beat-to-beat RR intervals,
// ingested as two separate metrics and read back from the store's nightly rollups.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ingest, upsertSource } from "@askwearables/core";
import { USER, freshStore } from "@askwearables/core/testing";
import { importMmash } from "@askwearables/importers";

export function mmashDir(dataDir: string): string {
  return join(dataDir, "mmash/extracted/DataPaper");
}

export function mmashAvailable(dataDir: string): boolean {
  return existsSync(join(mmashDir(dataDir), "user_1/RR.csv"));
}

export interface MmashNight {
  user: string;
  beats: number;
  rejected: number;
  rmssd: number;
  sdnn: number;
  store_rmssd: number | null;
  store_sdnn: number | null;
  day: string | null;
}

export async function runMmash(dataDir: string): Promise<{ nights: MmashNight[]; skipped: string[] }> {
  const dir = mmashDir(dataDir);
  const users = readdirSync(dir).filter((u) => /^user_\d+$/.test(u)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const nights: MmashNight[] = [];
  const skipped: string[] = [];
  for (const u of users) {
    const b = importMmash(readFileSync(join(dir, u, "RR.csv"), "utf8"), readFileSync(join(dir, u, "sleep.csv"), "utf8"), { user: u });
    if (!b.night || !Number.isFinite(b.night.rmssd)) {
      skipped.push(`${u}: ${Object.keys(b.stats.skipped).join(",") || "no night"}`);
      continue;
    }
    const sql = freshStore();
    for (const s of b.sources) upsertSource(sql, USER, s);
    const res = await ingest(sql, USER, b.records);
    if (res.rejected.length) throw new Error(`${u}: rejected ${JSON.stringify(res.rejected)}`);
    const get = (m: string) => sql.all<{ day: string; value: number }>(`SELECT day, value FROM daily_rollups WHERE metric = ?`, m)[0] ?? null;
    const r = get("hrv_rmssd");
    const s = get("hrv_sdnn");
    nights.push({ user: u, beats: b.night.beats, rejected: b.night.rejected, rmssd: b.night.rmssd, sdnn: b.night.sdnn, store_rmssd: r?.value ?? null, store_sdnn: s?.value ?? null, day: r?.day ?? null });
  }
  return { nights, skipped };
}
