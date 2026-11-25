// Shared helpers for importers. Pure TypeScript: runs in browsers, Workers and Node.
import { tzOffsetAt } from "@askwearables/core";
import type { CanonicalRecord, DeviceClass, Source } from "@askwearables/core";

/** One unit of importer output: new sources to register first, then records to ingest. */
export interface ImportBatch {
  /** Sources first seen in this batch. Register them (upsertSource) before ingesting the records. */
  sources: Source[];
  records: CanonicalRecord[];
}

export interface ImportStats {
  records: number;
  skipped: Record<string, number>;
}

export function bump(stats: ImportStats, reason: string, n = 1) {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + n;
}

/** Time zone handling for sources whose timestamps are local wall-clock times without an offset. */
export type TimeZoneOption = string | number; // IANA name (e.g. "Europe/Oslo") or fixed minutes east of UTC

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/** Parse a local wall-clock time ("2019-11-02 00:09:30", "2019-11-02T07:19:30.000") as milliseconds of a fake-UTC clock. */
export function wallMs(s: string): number {
  const m = WALL_RE.exec(s.trim());
  if (!m) throw new Error(`bad_wall_time:${s}`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0), +(m[7] ?? "0").padEnd(3, "0"));
}

/**
 * Convert a local wall-clock time to UTC plus the offset in force, for a fixed offset or an IANA zone.
 * In a daylight-saving gap or overlap, the offset in force before the change is used.
 */
export function wallToUtc(wall: string | number, tz: TimeZoneOption): { iso: string; offset: number } {
  const w = typeof wall === "number" ? wall : wallMs(wall);
  if (typeof tz === "number") return { iso: new Date(w - tz * 60_000).toISOString(), offset: tz };
  // The offsets in force a day either side cover both sides of any transition near this wall time.
  const cands = [...new Set([tzOffsetAt(tz, new Date(w - 86_400_000)), tzOffsetAt(tz, new Date(w)), tzOffsetAt(tz, new Date(w + 86_400_000))])];
  const valid = cands.filter((o) => tzOffsetAt(tz, new Date(w - o * 60_000)) === o);
  // Overlap (clocks back): two valid offsets, take the earlier instant (larger offset).
  // Gap (clocks forward): none valid, take the offset from before the change (smaller offset).
  const off = valid.length ? Math.max(...valid) : Math.min(...cands);
  return { iso: new Date(w - off * 60_000).toISOString(), offset: off };
}

const OFFSET_TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)? ?([+-])(\d{2}):?(\d{2})$/;

/** Parse a timestamp that carries its own offset ("2026-01-02 07:00:00 -0500") into UTC ISO plus the offset. */
export function parseOffsetTimestamp(s: string): { iso: string; ms: number; offset: number } {
  const m = OFFSET_TS_RE.exec(s);
  if (!m) throw new Error(`bad_timestamp:${s}`);
  const offset = (m[7] === "-" ? -1 : 1) * (+m[8]! * 60 + +m[9]!);
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) - offset * 60_000;
  return { iso: new Date(ms).toISOString(), ms, offset };
}

/** 32-bit FNV-1a, hex. Stable ids without crypto (sync, browser-safe). Not for security. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Infer a device class from model, hardware and source names. */
export function inferDeviceClass(...hints: (string | null | undefined)[]): DeviceClass {
  const s = hints.filter(Boolean).join(" ").toLowerCase();
  if (!s) return "other";
  if (/\boura\b|\bring\b|ultrahuman|circular/.test(s)) return "ring";
  if (/watch|garmin|forerunner|fenix|polar|coros|suunto|amazfit|pixel watch|galaxy watch|versa|sense\b/.test(s)) return "watch";
  if (/whoop|fitbit|charge|inspire|\bband\b|mi band|xiaomi/.test(s)) return "band";
  if (/withings|scale|renpho|eufy|body\+|qardio/.test(s)) return "scale";
  if (/dexcom|libre|\bcgm\b|guardian/.test(s)) return "cgm";
  if (/iphone|ipad|\bphone\b|android/.test(s)) return "phone";
  return "other";
}

/** Run an iterable/async iterable of string or byte chunks through a decoder, yielding strings. */
export async function* textChunks(input: string | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<string> {
  if (typeof input === "string") {
    yield input;
    return;
  }
  const decoder = new TextDecoder("utf-8");
  const iter: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array> =
    typeof (input as ReadableStream<Uint8Array>).getReader === "function" ? readerIterable(input as ReadableStream<Uint8Array>) : (input as AsyncIterable<string | Uint8Array>);
  for await (const c of iter) {
    if (typeof c === "string") yield c;
    else {
      const s = decoder.decode(c, { stream: true });
      if (s) yield s;
    }
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

async function* readerIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function round(x: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

export function toNumber(s: string | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  if (t === "" || /^(nan|null|none|na)$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
