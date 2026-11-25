import type { PlanResult } from "@askwearables/core";
export interface PlannerRpc {
  plan(question: string, tz: string, nowIso: string): Promise<PlanResult & { model?: string }>;
}
