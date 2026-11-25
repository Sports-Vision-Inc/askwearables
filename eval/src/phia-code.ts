// Parse and evaluate the pandas expressions PHIA uses as reference answers for its objective questions,
// e.g. daily_metrics.query('steps > 5000').during('last 7 days')['datetime'].drop_duplicates().count().
// The evaluator reproduces PHIA's own semantics (data_utils.ChiaDataFrame.during), so the eval can check
// that it reads each reference answer the way PHIA computed it, and see which window PHIA actually used.

export type Base = "daily_metrics" | "exercise_entries";

export type Step =
  | { k: "query"; cond: string }
  | { k: "during"; arg: { literal: string } | { composed: string } }
  | { k: "col"; name: string }
  | { k: "slice"; from?: number; to?: number }
  | { k: "index"; i: number }
  | { k: "call"; fn: string };

export interface Chain {
  base: Base;
  steps: Step[];
}

/** Parse a method chain. Throws on anything outside the subset PHIA's generator uses. */
export function parseChain(src: string): Chain {
  const s = src.trim();
  let i = 0;
  const m = /^(daily_metrics|exercise_entries)/.exec(s);
  if (!m) throw new Error(`unknown_base:${s.slice(0, 30)}`);
  const base = m[1] as Base;
  i = m[0].length;
  const steps: Step[] = [];
  const readParen = (): string => {
    // s[i] === "("; return inner text up to the matching ")", respecting quotes.
    let depth = 0;
    const start = i + 1;
    for (; i < s.length; i++) {
      const c = s[i]!;
      if (c === "'" || c === '"') {
        const q = s.indexOf(c, i + 1);
        if (q < 0) throw new Error("unterminated_string");
        i = q;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          const inner = s.slice(start, i);
          i++;
          return inner;
        }
      }
    }
    throw new Error("unbalanced_paren");
  };
  const unquote = (t: string) => {
    const x = t.trim();
    if ((x.startsWith("'") && x.endsWith("'")) || (x.startsWith('"') && x.endsWith('"'))) return x.slice(1, -1);
    return null;
  };
  while (i < s.length) {
    if (s[i] === ".") {
      const mm = /^\.([a-z_]+)/.exec(s.slice(i));
      if (!mm) throw new Error(`bad_method_at:${i}`);
      const fn = mm[1]!;
      i += mm[0].length;
      if (s[i] !== "(") throw new Error(`not_a_call:${fn}`);
      const inner = readParen();
      if (fn === "query") {
        const q = unquote(inner);
        if (q === null) throw new Error("query_not_literal");
        steps.push({ k: "query", cond: q });
      } else if (fn === "during") {
        const q = unquote(inner);
        steps.push({ k: "during", arg: q !== null ? { literal: q } : { composed: inner.trim() } });
      } else {
        if (inner.trim()) throw new Error(`call_with_args:${fn}`);
        steps.push({ k: "call", fn });
      }
      continue;
    }
    if (s[i] === "[") {
      const close = s.indexOf("]", i);
      if (close < 0) throw new Error("unbalanced_bracket");
      const inner = s.slice(i + 1, close).trim();
      i = close + 1;
      const q = unquote(inner);
      if (q !== null) steps.push({ k: "col", name: q });
      else if (/^-?\d*:-?\d*$/.test(inner)) {
        const [a, b] = inner.split(":");
        const st: Step = { k: "slice" };
        if (a) st.from = Number(a);
        if (b) st.to = Number(b);
        steps.push(st);
      } else if (/^-?\d+$/.test(inner)) steps.push({ k: "index", i: Number(inner) });
      else throw new Error(`bad_index:${inner}`);
      continue;
    }
    throw new Error(`unexpected:${s.slice(i, i + 10)}`);
  }
  return { base, steps };
}

// ---------- conditions ----------

export interface Atom {
  col: string;
  op: "==" | "!=" | "<" | "<=" | ">" | ">=";
  value: number | string;
}

/** Parse "steps > 5000", 'activityName == "Run" and elevationGain <= 64', "sleep_minutes <= 6*60". */
export function parseCond(cond: string): Atom[] {
  return cond.split(/\s+and\s+/).map((part) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|<=|>=|<|>)\s*(.+?)\s*$/.exec(part);
    if (!m) throw new Error(`bad_condition:${part}`);
    const raw = m[3]!;
    let value: number | string;
    const q = /^["'](.*)["']$/.exec(raw);
    if (q) value = q[1]!;
    else if (/^[\d.\s*/+-]+$/.test(raw)) value = evalArith(raw);
    else throw new Error(`bad_value:${raw}`);
    return { col: m[1]!, op: m[2] as Atom["op"], value };
  });
}

function evalArith(e: string): number {
  // Only products and quotients of numbers appear (e.g. "6*60", "1.5*60").
  const parts = e.replace(/\s+/g, "").split(/(?=[*/])/);
  let v = Number(parts[0]);
  for (const p of parts.slice(1)) v = p[0] === "*" ? v * Number(p.slice(1)) : v / Number(p.slice(1));
  if (!Number.isFinite(v)) throw new Error(`bad_number:${e}`);
  return v;
}

// ---------- PHIA's semantics ----------

export interface PhiaRow {
  /** Index date: summary `datetime`, or the date of an exercise's startTime. */
  date: string;
  /** For exercises: startTime (used as the "datetime" column). */
  stamp: string;
  num: Record<string, number>;
  str: Record<string, string>;
}

export interface PhiaUserData {
  daily: PhiaRow[];
  exercise: PhiaRow[];
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * "Last N days" spans. PHIA's released data_utils.py reads "last N days" as N days ending on the reference date
 * ("n"). PHIA's reference answers, recomputed from its released data, match N + 1 days ending on the reference
 * date ("n_plus_1"); see eval/phia/NOTES.md.
 */
export type LastNSpan = "n" | "n_plus_1";

/**
 * Reference date for `during`. "filtered": the last date of the frame `during` is called on, as PHIA's released
 * data_utils.py does (after any .query()). "base": the last date of the whole table (daily_metrics or
 * exercise_entries), which is what PHIA's reference answers match; see eval/phia/NOTES.md.
 */
export type Anchor = "filtered" | "base";

export interface Convention { span: LastNSpan; anchor: Anchor }
export const RELEASED_CODE: Convention = { span: "n", anchor: "filtered" };
export const REFERENCE_ANSWERS: Convention = { span: "n_plus_1", anchor: "base" };

/** PHIA's ChiaDataFrame._get_date_range: "today", "yesterday", "last N days". */
export function phiaRange(expr: string, ref: string, span: LastNSpan = "n"): { start: string; end: string } {
  const e = expr.toLowerCase().trim();
  if (e === "today") return { start: ref, end: ref };
  if (e === "yesterday") return { start: addDays(ref, -1), end: addDays(ref, -1) };
  const m = /^last (\d+) days$/.exec(e);
  if (m) return { start: addDays(ref, -(Number(m[1]) - (span === "n" ? 1 : 0))), end: ref };
  throw new Error(`unknown_time_expression:${expr}`);
}

const OPS: Record<Atom["op"], (a: number | string, b: number | string) => boolean> = {
  "==": (a, b) => a === b, "!=": (a, b) => a !== b,
  "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b,
};

function matches(r: PhiaRow, atoms: Atom[]): boolean {
  return atoms.every((a) => {
    const v = typeof a.value === "string" ? r.str[a.col] : r.num[a.col];
    if (v === undefined || (typeof v === "number" && Number.isNaN(v))) return false;
    return OPS[a.op](v, a.value);
  });
}

export interface PhiaEval {
  value: number | string | null;
  /** The window `during` used, from PHIA's anchor (the max index date of the frame it was called on). */
  window?: { start: string; end: string };
}

/** Evaluate a chain with PHIA's semantics, including `during(<another chain>)` (window from the other chain's dates). */
export function evalPhia(ch: Chain, data: PhiaUserData, conv: Convention = RELEASED_CODE): PhiaEval {
  const r = evalInner(ch, data, conv);
  return r.window ? { value: r.value, window: r.window } : { value: r.value };
}

interface Inner { value: number | string | null; series: (number | string)[] | null; window?: { start: string; end: string } }

function evalInner(ch: Chain, data: PhiaUserData, conv: Convention): Inner {
  const all = ch.base === "daily_metrics" ? data.daily : data.exercise;
  let rows = all;
  let series: (number | string)[] | null = null;
  let window: Inner["window"];
  const out = (value: Inner["value"]): Inner => ({ value, series, ...(window ? { window } : {}) });
  for (const st of ch.steps) {
    switch (st.k) {
      case "query": rows = rows.filter((r) => matches(r, parseCond(st.cond))); break;
      case "during": {
        if ("literal" in st.arg) {
          const frame = conv.anchor === "filtered" ? rows : all;
          if (!frame.length) break;
          const ref = frame.reduce((a, r) => (r.date > a ? r.date : a), frame[0]!.date);
          window = phiaRange(st.arg.literal, ref, conv.span);
        } else {
          const inner = evalInner(parseChain(st.arg.composed), data, conv);
          const dates = (inner.value !== null && typeof inner.value === "string" ? [inner.value] : (inner.series ?? []).filter((v): v is string => typeof v === "string")).map((d) => d.slice(0, 10));
          if (!dates.length) { rows = []; break; }
          window = { start: dates.reduce((a, b) => (b < a ? b : a)), end: dates.reduce((a, b) => (b > a ? b : a)) };
        }
        const w = window;
        rows = rows.filter((r) => r.date >= w.start && r.date <= w.end);
        break;
      }
      case "col":
        series = rows.map((r) => (st.name === "datetime" ? (ch.base === "daily_metrics" ? r.date : r.stamp) : st.name in r.str ? r.str[st.name]! : r.num[st.name] ?? NaN));
        break;
      case "slice": series = (series ?? []).slice(st.from, st.to); break;
      case "index": {
        const s = series ?? [];
        const v = st.i < 0 ? s[s.length + st.i] : s[st.i];
        return out(v === undefined ? null : v);
      }
      case "call": {
        if (st.fn === "drop_duplicates") { series = [...new Set(series ?? [])]; break; }
        if (st.fn === "count") {
          // DataFrame.count() gives a count per column; PHIA reads it as the number of rows.
          if (series === null) return out(rows.length);
          return out(series.filter((v) => !(typeof v === "number" && Number.isNaN(v))).length);
        }
        const all = series ?? [];
        if (all.length && all.every((v) => typeof v === "string") && (st.fn === "max" || st.fn === "min")) {
          const ss = all as string[];
          return out(st.fn === "max" ? ss.reduce((a, b) => (b > a ? b : a)) : ss.reduce((a, b) => (b < a ? b : a)));
        }
        const xs = all.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
        return out(reduce(st.fn, xs));
      }
    }
  }
  if (series && series.length === 1) return out(series[0]!);
  return out(null);
}

export function reduce(fn: string, xs: number[]): number {
  switch (fn) {
    case "sum": return xs.reduce((a, b) => a + b, 0);
    case "mean": return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
    case "min": return xs.length ? Math.min(...xs) : NaN;
    case "max": return xs.length ? Math.max(...xs) : NaN;
    case "median": {
      if (!xs.length) return NaN;
      const s = [...xs].sort((a, b) => a - b);
      const h = s.length >> 1;
      return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
    }
    case "std": {
      if (xs.length < 2) return NaN;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    }
    default: throw new Error(`unknown_reduce:${fn}`);
  }
}

/** Agreement to two significant digits ("match within two digits"). */
export function sig2(x: number): number {
  if (x === 0) return 0;
  // Clean binary noise first, so 57.49999999999999 and 57.5 round the same way.
  return Number(Number(x.toPrecision(12)).toPrecision(2));
}

export function agree2(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return sig2(a) === sig2(b);
}
