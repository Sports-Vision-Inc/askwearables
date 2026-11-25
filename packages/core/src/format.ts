import { CATALOGUE } from "./catalogue.js";
import type { MetricId } from "./types.js";

const NIGHT_METRICS = new Set<MetricId>(["sleep_duration", "sleep_efficiency", "sleep_stages", "hrv_rmssd", "hrv_sdnn", "spo2", "respiratory_rate", "skin_temp_deviation", "breathing_disturbances"]);

export function dayNoun(metric: MetricId, n: number): string {
  const base = NIGHT_METRICS.has(metric) ? "night" : "day";
  return n === 1 ? base : `${base}s`;
}

/** Round a value for release at level 2: whole numbers for counts, minutes, bpm and kcal; one decimal otherwise. */
export function roundFor(metric: MetricId, v: number): number {
  const u = CATALOGUE[metric].unit;
  if (["count", "minutes", "bpm", "kcal", "mg/dL"].includes(u)) return Math.round(v);
  if (u === "degC") return Math.round(v * 100) / 100;
  return Math.round(v * 10) / 10;
}

export function fmtValue(metric: MetricId, v: number): string {
  const u = CATALOGUE[metric].unit;
  const r = roundFor(metric, v);
  switch (u) {
    case "minutes": {
      const h = Math.floor(r / 60);
      const mm = r % 60;
      return h ? `${h} h ${mm} min` : `${mm} min`;
    }
    case "count":
      return r.toLocaleString("en-US");
    case "percent":
      return `${r}%`;
    case "degC":
      return `${r >= 0 ? "+" : ""}${r} °C`;
    default:
      return `${r} ${u}`;
  }
}

export function label(metric: MetricId): string {
  return CATALOGUE[metric].label;
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
