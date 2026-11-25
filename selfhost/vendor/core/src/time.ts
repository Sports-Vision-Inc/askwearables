// Time rules: store UTC plus the original offset. A "day" is the user's local day at the time of the sample.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Local calendar date of a UTC instant, given the offset (minutes east of UTC) in force at that instant. */
export function localDay(isoUtc: string, tzOffsetMin: number): string {
  const t = Date.parse(isoUtc);
  if (Number.isNaN(t)) throw new Error(`bad_timestamp:${isoUtc}`);
  return new Date(t + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/** Local hour (0-23) of a UTC instant. */
export function localHour(isoUtc: string, tzOffsetMin: number): number {
  return new Date(Date.parse(isoUtc) + tzOffsetMin * 60_000).getUTCHours();
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Offset of an IANA time zone at an instant, minutes east of UTC. Works in Workers and Node (Intl). */
export function tzOffsetAt(timeZone: string, at: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Today's local date in a time zone. */
export function todayIn(timeZone: string, now: Date): string {
  return localDay(now.toISOString(), tzOffsetAt(timeZone, now));
}

/** Parse "+02:00", "-0500", "Z" into minutes east of UTC. */
export function parseOffset(s: string): number {
  if (s === "Z" || s === "z") return 0;
  const mt = /^([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
  if (!mt) throw new Error(`bad_offset:${s}`);
  const v = Number(mt[2]) * 60 + Number(mt[3]);
  return mt[1] === "-" ? -v : v;
}

/** ISO week start (Monday) for a date. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sun
  return addDays(day, -((dow + 6) % 7));
}

export function hoursBetween(aIso: string, bIso: string): number {
  return (Date.parse(bIso) - Date.parse(aIso)) / 3_600_000;
}
