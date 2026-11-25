// Test helpers: a node:sqlite adapter for the Sql interface, and a deterministic synthetic user.
import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlValue } from "../src/sql.js";
import { migrate, upsertSource } from "../src/store.js";
import { addDays } from "../src/time.js";
import type { Agent, CanonicalRecord, DeviceClass, Grant, Source } from "../src/types.js";

export function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    all: <T>(q: string, ...b: SqlValue[]) => db.prepare(q).all(...b) as T[],
    run: (q, ...b) => Number(db.prepare(q).run(...b).changes),
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

export function freshStore(): Sql {
  const sql = memorySql();
  migrate(sql);
  return sql;
}

export const USER = "u_test";

export function source(id: string, cls: DeviceClass, provider = id, extra: Partial<Source> = {}): Source {
  return { id, provider, device_model: `${provider}-model`, device_class: cls, connected_at: "2026-01-01T00:00:00Z", earliest_readable: null, last_sync_at: null, terms_flags: {}, ...extra };
}

/** Seeded PRNG so every run builds the same data. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  sourceId: string;
  start: string; // first local day
  days: number;
  tzOffsetMin?: number | ((day: string) => number);
  seed?: number;
  skipDays?: Set<string>;
  sleepMin?: (day: string, i: number) => number;
  stepsPerHour?: number;
  restingHr?: (day: string, i: number) => number;
  hrv?: (day: string, i: number) => number;
  workoutEvery?: number;
  workoutTitle?: string;
}

/** A plausible user: hourly steps 07-21, a night of sleep ending ~07:00 local, nightly HRV and resting HR, workouts. */
export function synthUser(o: SynthOptions): CanonicalRecord[] {
  const r = rng(o.seed ?? 1);
  const recs: CanonicalRecord[] = [];
  for (let i = 0; i < o.days; i++) {
    const day = addDays(o.start, i);
    if (o.skipDays?.has(day)) continue;
    const off = typeof o.tzOffsetMin === "function" ? o.tzOffsetMin(day) : o.tzOffsetMin ?? 0;
    const utc = (localHour: number, minute = 0) => new Date(Date.parse(`${day}T00:00:00Z`) + (localHour * 60 + minute - off) * 60_000).toISOString();
    for (let h = 7; h <= 21; h++) {
      recs.push({ kind: "sample", metric: "steps", start: utc(h), end: utc(h + 1), value: Math.round((o.stepsPerHour ?? 600) * (0.6 + r() * 0.8)), unit: "count", source_id: o.sourceId, method: "measured", external_id: `st-${day}-${h}`, tz_offset_min: off });
    }
    const sleepMin = o.sleepMin ? o.sleepMin(day, i) : 420 + Math.round((r() - 0.5) * 50);
    const wake = utc(7);
    const bedStart = new Date(Date.parse(wake) - (sleepMin + 20) * 60_000).toISOString();
    recs.push({ kind: "session", session_kind: "sleep", start: bedStart, end: wake, source_id: o.sourceId, external_id: `sl-${day}`, tz_offset_min: off, is_main: true,
      detail: { deep_min: Math.round(sleepMin * 0.18), rem_min: Math.round(sleepMin * 0.22), light_min: sleepMin - Math.round(sleepMin * 0.18) - Math.round(sleepMin * 0.22), awake_min: 20, in_bed_min: sleepMin + 20 } });
    const hrv = o.hrv ? o.hrv(day, i) : 50 + (r() - 0.5) * 10;
    recs.push({ kind: "sample", metric: "hrv_rmssd", start: new Date(Date.parse(wake) - 120 * 60_000).toISOString(), end: new Date(Date.parse(wake) - 115 * 60_000).toISOString(), value: Math.round(hrv * 10) / 10, unit: "ms", source_id: o.sourceId, method: "measured", external_id: `hrv-${day}`, tz_offset_min: off });
    const rhr = o.restingHr ? o.restingHr(day, i) : 55 + Math.round((r() - 0.5) * 4);
    recs.push({ kind: "sample", metric: "resting_hr", start: `${day}T00:00:00.000Z`, end: `${day}T23:59:00.000Z`, value: rhr, unit: "bpm", source_id: o.sourceId, method: "vendor_daily", external_id: `rhr-${day}`, tz_offset_min: 0 });
    if (o.workoutEvery && i % o.workoutEvery === 0) {
      recs.push({ kind: "session", session_kind: "workout", start: utc(18), end: utc(18, 45), source_id: o.sourceId, external_id: `wo-${day}`, tz_offset_min: off,
        detail: { type: "Running", load: 80, ...(o.workoutTitle ? { title: o.workoutTitle } : {}) } });
    }
  }
  return recs;
}

export function seedSources(sql: Sql, sources: Source[]) {
  for (const s of sources) upsertSource(sql, USER, s);
}

export function testAgent(over: Partial<Agent> = {}): Agent {
  return { agent_id: "ag_test", name: "Test agent", registered_by: "owner", verified_domain: null, model_facing: true, ...over };
}

export function testGrant(over: Partial<Grant> = {}): Grant {
  return {
    grant_id: "gr_test", user_id: USER, agent_id: "ag_test", purpose: "general_wellness",
    metrics: ["sleep_duration", "resting_hr", "steps", "hrv_rmssd", "workout", "sleep_efficiency"],
    max_level: 2, max_window_days: 90, daily_packet_budget: 50, expires_at: "2027-03-01T00:00:00Z", ...over,
  };
}
