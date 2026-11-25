// The policy gate: plain code that runs before any data is read. It releases the coarsest level that
// answers the question, only for metrics granted to this agent for this purpose. Deny by default.
import { CATALOGUE, RELATED_METRICS, requiredLevel, type Category } from "./catalogue.js";
import { addDays, daysBetween } from "./time.js";
import type { Agent, DateWindow, GateDecision, Grant, Level, MetricId, Purpose, QuerySpec, TermsFlags } from "./types.js";

export const PURPOSES: Purpose[] = ["scheduling", "training_advice", "sleep_coaching", "general_wellness", "personal_research"];

/** What each purpose plausibly needs. The contextual-integrity check can lower or deny, never raise. */
export const PURPOSE_POLICY: Record<Purpose, { categories: Category[]; max_level: Level; label: string }> = {
  scheduling: { categories: ["sleep", "heart", "activity"], max_level: 1, label: "Scheduling (when to plan demanding work or rest)" },
  training_advice: { categories: ["activity", "heart", "sleep", "training", "body"], max_level: 3, label: "Training advice" },
  sleep_coaching: { categories: ["sleep", "heart", "body"], max_level: 2, label: "Sleep coaching" },
  general_wellness: { categories: ["activity", "heart", "sleep", "training", "body"], max_level: 2, label: "General wellness questions" },
  personal_research: { categories: ["activity", "heart", "sleep", "training", "body", "sensitive"], max_level: 3, label: "Personal research (the owner's own analysis)" },
};

export const MAX_GRANT_DAYS = 90;

export interface GateInput {
  /** Result of token verification by auth: the token is valid and bound to this agent. */
  token: { valid: boolean; agent_id?: string; user_id?: string; grant_id?: string };
  grant: Grant | null;
  agent: Agent | null;
  spec: QuerySpec;
  now: Date;
  /** The user's local date today. */
  today: string;
  /** Packets released to this agent today (denials are not metered). */
  releasedToday: number;
  /** Sources holding data for each requested metric, with their terms flags. */
  sources: { id: string; provider: string; terms_flags: TermsFlags; metrics: MetricId[] }[];
  paused: boolean;
  /** Optional contextual-integrity check. On by default. */
  contextualIntegrity?: boolean;
}

function deny(spec: QuerySpec, reasons: string[], denied: MetricId[] = []): GateDecision {
  return { allow: false, level: 0, spec, denied_metrics: denied, excluded_sources: [], reasons };
}

function clampWindow(w: DateWindow, earliest: string, today: string): DateWindow | null {
  const start = w.start < earliest ? earliest : w.start;
  const end = w.end > today ? today : w.end;
  return start > end ? null : { start, end };
}

/** The gate's decision order, step by step, as the spec lists it. */
export function decide(input: GateInput): GateDecision {
  const { spec, grant, agent, token, now } = input;
  const reasons: string[] = [];

  // 1. Token valid, bound to this agent, grant not expired or revoked.
  if (!token.valid) return deny(spec, ["token_invalid"]);
  if (!grant) return deny(spec, ["no_grant"]);
  if (!agent) return deny(spec, ["token_invalid"]);
  if (token.agent_id !== grant.agent_id || agent.agent_id !== grant.agent_id || token.grant_id !== grant.grant_id || token.user_id !== grant.user_id) return deny(spec, ["agent_mismatch"]);
  if (grant.revoked_at) return deny(spec, ["grant_revoked"]);
  if (Date.parse(grant.expires_at) <= now.getTime()) return deny(spec, ["grant_expired"]);
  if (input.paused) return deny(spec, ["paused"]);

  // 2. Every requested metric is in the grant; otherwise deny that metric and say so.
  const denied: MetricId[] = [];
  for (const m of spec.metrics) {
    if (!grant.metrics.includes(m)) {
      denied.push(m);
      reasons.push(`metric_not_in_grant:${m}`);
      for (const alt of RELATED_METRICS[m] ?? []) if (grant.metrics.includes(alt)) reasons.push(`granted_alternative:${m}:${alt}`);
    }
  }

  // 3. Provider terms flags: data from a no-AI source never reaches a model-facing agent.
  const excluded: string[] = [];
  if (agent.model_facing) {
    for (const s of input.sources) {
      if (s.terms_flags.no_ai || s.terms_flags.no_intermediary) {
        excluded.push(s.id);
        if (s.metrics.some((m) => spec.metrics.includes(m))) reasons.push(`terms_no_ai:${s.provider}`);
      }
    }
  }

  // 4. Sensitive categories are excluded unless the grant names them one by one.
  for (const m of spec.metrics) {
    if (CATALOGUE[m].sensitive && !(grant.sensitive ?? []).includes(m) && !denied.includes(m)) {
      denied.push(m);
      reasons.push(`sensitive_not_named:${m}`);
    }
  }
  // Operations over two metrics (correlate) need both; others need their one metric.
  if (denied.length) return deny(spec, reasons, denied);

  // 5. Clamp the window(s) to max_window_days, ending no later than today.
  const earliest = addDays(input.today, -(grant.max_window_days - 1));
  const window = clampWindow(spec.window, earliest, input.today);
  if (!window) return deny(spec, [...reasons, "window_outside_grant"]);
  const clamped: QuerySpec = { ...spec, window, params: { ...(spec.params ?? {}) } };
  if (window.start !== spec.window.start || window.end !== spec.window.end) reasons.push("window_clamped");
  if (spec.params?.compare_window) {
    const cw = clampWindow(spec.params.compare_window, earliest, input.today);
    if (!cw) return deny(spec, [...reasons, "compare_window_outside_grant"]);
    if (cw.start !== spec.params.compare_window.start || cw.end !== spec.params.compare_window.end) reasons.push("compare_window_clamped");
    clamped.params!.compare_window = cw;
  }

  // 6. Level = the lowest of the grant's maximum and the lowest level that can answer the operation.
  const need = requiredLevel(spec);
  let level = Math.min(grant.max_level, need) as Level;
  if (grant.max_level < need) reasons.push("level_lowered_by_grant");

  // 7. Budget: stop when the agent passes its daily packet count.
  if (input.releasedToday >= grant.daily_packet_budget) return deny(clamped, [...reasons, "budget_exhausted"]);

  // 8. Optional contextual-integrity check on purpose: may downgrade or deny, never raise.
  if (input.contextualIntegrity !== false) {
    const pol = PURPOSE_POLICY[grant.purpose];
    for (const m of spec.metrics) {
      if (!pol.categories.includes(CATALOGUE[m].category)) return deny(clamped, [...reasons, `purpose_mismatch:${m}`], [m]);
    }
    if (level > pol.max_level) {
      level = pol.max_level;
      reasons.push("level_lowered_by_purpose");
    }
  }

  // 9. The caller writes the receipt, including denials.
  reasons.push(`level:${level}`);
  return { allow: true, level, spec: clamped, denied_metrics: [], excluded_sources: excluded, reasons };
}

/** Validate a grant before it is stored (the consent screen calls this). */
export function validateGrant(g: Grant, now: Date): string[] {
  const errs: string[] = [];
  if (!PURPOSES.includes(g.purpose)) errs.push("purpose");
  if (!g.metrics.length) errs.push("metrics_empty");
  for (const m of g.metrics) if (!CATALOGUE[m]) errs.push(`metric_unknown:${m}`);
  for (const m of g.sensitive ?? []) if (!CATALOGUE[m]?.sensitive || !g.metrics.includes(m)) errs.push(`sensitive_invalid:${m}`);
  for (const m of g.metrics) if (CATALOGUE[m]?.sensitive && !(g.sensitive ?? []).includes(m)) errs.push(`sensitive_not_named:${m}`);
  if (![0, 1, 2, 3].includes(g.max_level)) errs.push("max_level");
  if (!Number.isInteger(g.max_window_days) || g.max_window_days < 1 || g.max_window_days > 365) errs.push("max_window_days");
  if (!Number.isInteger(g.daily_packet_budget) || g.daily_packet_budget < 1 || g.daily_packet_budget > 1000) errs.push("daily_packet_budget");
  const exp = Date.parse(g.expires_at);
  if (Number.isNaN(exp) || exp <= now.getTime()) errs.push("expires_at");
  else if (daysBetween(now.toISOString().slice(0, 10), g.expires_at.slice(0, 10)) > MAX_GRANT_DAYS) errs.push("expires_at_over_90_days");
  return errs;
}
