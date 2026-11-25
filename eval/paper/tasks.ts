// The question set. Every reference answer comes from the person's TRUTH ledger, never from the broker.
import { addDays } from "@askwearables/core";
import { type Person, TODAY } from "./synth.js";

export type Answer = number | "yes" | "no" | "up" | "down" | "flat" | "higher" | "lower" | "same" | "unknown";

export interface Task {
  id: string;
  person: string;
  trap: string;
  question: string;
  kind: "number" | "yesno" | "trend" | "compare";
  /** Accepted answers: one number with a tolerance, or a set of labels. "unknown" is listed when it is acceptable. */
  accept: { number?: number; tol?: number; labels?: Answer[] };
  /** Short tag for the analysis tables. */
  tag: string;
}

const yday = addDays(TODAY, -1);
const lastN = (p: Person, n: number) => p.truth.filter((t) => t.day >= addDays(TODAY, -n) && t.day <= yday);

export function tasksFor(p: Person): Task[] {
  const T: Task[] = [];
  const add = (tag: string, question: string, kind: Task["kind"], accept: Task["accept"]) =>
    T.push({ id: `${p.id}-${tag}`, person: p.id, trap: p.trap, question, kind, accept, tag });

  const w7 = lastN(p, 7);
  const w7missing = w7.some((t) => !t.worn);
  // 1. Total steps, last 7 days. Unknowable when days are missing.
  add("steps_total_7d", "How many steps did I take in total over the last 7 days, ending yesterday?", "number",
    w7missing ? { labels: ["unknown"] } : { number: w7.reduce((a, t) => a + t.steps, 0), tol: 0.02 });
  // 2. Average sleep, last 7 nights: the mean over recorded nights is acceptable; so is unknown when nights are missing.
  const s7 = w7.filter((t) => t.worn);
  add("sleep_avg_7d", "What was my average sleep per night over the last 7 nights, ending yesterday, in minutes?", "number",
    { number: s7.reduce((a, t) => a + t.sleep_min, 0) / s7.length, tol: 0.03, labels: w7missing ? ["unknown"] : [] });
  // 3. Resting HR yesterday.
  const y = p.truth.find((t) => t.day === yday)!;
  add("rhr_yesterday", "What was my resting heart rate yesterday, in bpm?", "number", y.worn ? { number: y.resting_hr, tol: 1.01 / Math.max(1, y.resting_hr) } : { labels: ["unknown"] });
  // 4. Any night under 6 hours in the last 7.
  const under = s7.some((t) => t.sleep_min < 360);
  add("sleep_under_6h_7d", "Did I sleep less than 6 hours on any night in the last 7 nights, ending yesterday?", "yesno",
    { labels: under ? ["yes"] : w7missing ? ["no", "unknown"] : ["no"] });
  // 5. HRV trend over 4 weeks.
  add("hrv_trend_28d", "Over the last 4 weeks, ending yesterday, is my HRV trending up, down, or flat?", "trend",
    { labels: p.trap === "hrv_rising" ? ["up"] : p.trap === "hrv_falling" ? ["down"] : ["flat"] });
  // 6. Sleeping less than usual, last 3 nights. Reference from the truth: the mean of the last 3 recorded nights
  // against the previous 28 nights. Below the 25th percentile: yes. Above the median: no. In between: either.
  const l3 = lastN(p, 3);
  const l3w = l3.filter((t) => t.worn);
  const prior = p.truth.filter((t) => t.worn && t.day < addDays(TODAY, -3) && t.day >= addDays(TODAY, -31)).map((t) => t.sleep_min).sort((x, y) => x - y);
  const q = (f: number) => prior[Math.floor((prior.length - 1) * f)]!;
  const m3 = l3w.reduce((s2, t) => s2 + t.sleep_min, 0) / Math.max(1, l3w.length);
  let usual: Answer[] = m3 < q(0.25) ? ["yes"] : m3 > q(0.5) ? ["no"] : ["yes", "no"];
  if (l3w.length < 3 || p.trap === "device_switch") usual = [...usual, "unknown"];
  if (l3w.length === 0) usual = ["unknown"];
  add("sleep_vs_usual_3d", "Have I been sleeping less than usual over the last 3 nights, ending yesterday?", "yesno", { labels: usual });
  // 7. Steps this week vs the week before.
  const prev = p.truth.filter((t) => t.day >= addDays(TODAY, -14) && t.day < addDays(TODAY, -7));
  const prevMissing = prev.some((t) => !t.worn);
  const a = w7.filter((t) => t.worn).reduce((s, t) => s + t.steps, 0) / Math.max(1, w7.filter((t) => t.worn).length);
  const b = prev.filter((t) => t.worn).reduce((s, t) => s + t.steps, 0) / Math.max(1, prev.filter((t) => t.worn).length);
  const rel = (a - b) / b;
  const cmp: Answer = Math.abs(rel) < 0.05 ? "same" : rel > 0 ? "higher" : "lower";
  const cmpAccept: Answer[] = Math.abs(rel) < 0.08 ? (rel > 0 ? ["higher", "same"] : ["lower", "same"]) : [cmp];
  add("steps_week_vs_prev", "On average per day, did I walk more, less, or about the same in the last 7 days, ending yesterday, compared with the 7 days before that?", "compare",
    { labels: w7missing || prevMissing ? [...cmpAccept, "unknown"] : cmpAccept });
  // 8. Workout count, last 14 days.
  const w14 = lastN(p, 14);
  const w14missing = w14.some((t) => !t.worn);
  const nWork = w14.filter((t) => t.worn && t.workout_min > 0).length;
  add("workouts_14d", "How many workouts did I record in the last 14 days, ending yesterday?", "number", w14missing ? { number: nWork, tol: 0.001, labels: ["unknown"] } : { number: nWork, tol: 0.001 });
  // 9. Average resting HR over 14 days.
  const r14 = w14.filter((t) => t.worn);
  add("rhr_avg_14d", "What was my average resting heart rate over the last 14 days, ending yesterday, in bpm?", "number",
    { number: r14.reduce((s, t) => s + t.resting_hr, 0) / r14.length, tol: 1.01 / 60, labels: w14missing ? ["unknown"] : [] });
  // 10. Steps yesterday.
  add("steps_yesterday", "How many steps did I take yesterday?", "number", y.worn ? { number: y.steps, tol: 0.02 } : { labels: ["unknown"] });
  return T;
}

/** Parse the model's final "ANSWER: ..." line. */
export function parseAnswer(text: string | null): Answer | null {
  if (!text) return null;
  // The last "ANSWER:" line wins (models sometimes write a bold "Answer:" first).
  const all = [...text.matchAll(/ANSWER:\s*([^\n]+)/gi)];
  const m = all.at(-1);
  // An answer counts only on an explicit "ANSWER:" line; no fallback to the last number in the text.
  if (!m) return null;
  const raw = m[1]!.toLowerCase().replace(/[*`_]/g, "").trim();
  if (/^unknown|cannot|can't|not enough|insufficient/.test(raw)) return "unknown";
  for (const l of ["yes", "no", "up", "down", "flat", "higher", "lower", "same"] as const) if (new RegExp(`^${l}\\b`).test(raw)) return l;
  if (/^more\b/.test(raw)) return "higher";
  if (/^less\b|^fewer\b/.test(raw)) return "lower";
  if (/^about the same|^similar/.test(raw)) return "same";
  const n = /-?\d[\d,]*(?:\.\d+)?/.exec(raw);
  if (n) return Number(n[0].replace(/,/g, ""));
  return null;
}

export function score(task: Task, ans: Answer | null): boolean {
  if (ans === null) return false;
  // In a comparison, "flat" and "same" mean the same thing.
  if (task.kind === "compare") ans = ans === "flat" ? "same" : ans === "up" ? "higher" : ans === "down" ? "lower" : ans;
  if (typeof ans === "number") {
    if (task.accept.number === undefined) return false;
    const ref = task.accept.number;
    return Math.abs(ans - ref) <= Math.max(Math.abs(ref) * (task.accept.tol ?? 0.02), 0.5);
  }
  return (task.accept.labels ?? []).includes(ans);
}
