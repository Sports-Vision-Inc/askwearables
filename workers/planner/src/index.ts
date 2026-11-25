// planner: question to QuerySpec. No data bindings: it sees the question and the metric catalogue only.
// LLM-first (Workers AI, structured output). The output is validated in code; anything invalid is retried on
// the second model, then refused. The keyword rules run only if both models are unavailable.
import { WorkerEntrypoint } from "cloudflare:workers";
import { type PlanResult, planWithLlm, querySpecJsonSchema, SUPPORTED_HELP, todayIn } from "@askwearables/core";
import type { PlannerRpc } from "./rpc.js";

export interface Env {
  AI: Ai;
  PLANNER_MODEL: string;
  PLANNER_FALLBACK_MODEL: string;
  AI_GATEWAY_ID?: string;
}

export function extractText(out: unknown): string {
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  const raw = o?.choices?.[0]?.message?.content ?? o?.response ?? out;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export default class Planner extends WorkerEntrypoint<Env> implements PlannerRpc {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }

  async plan(question: string, tz: string, nowIso: string): Promise<PlanResult & { model?: string }> {
    const q = String(question ?? "").slice(0, 500);
    const today = todayIn(tz, new Date(nowIso));
    let reachable = false;
    const complete = async (model: string, system: string, user: string) => {
      const out = await this.env.AI.run(
        model as keyof AiModels,
        {
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: { type: "json_schema", json_schema: { name: "plan", strict: true, schema: querySpecJsonSchema() } },
          temperature: 0,
          max_tokens: 2500,
          // Only reasoning models accept a reasoning effort.
          ...(/gpt-oss|inkling/.test(model) ? { reasoning_effort: "low" } : {}),
        } as never,
        this.env.AI_GATEWAY_ID ? { gateway: { id: this.env.AI_GATEWAY_ID, skipCache: false, collectLog: false } } : {},
      );
      reachable = true;
      return extractText(out);
    };
    const res = await planWithLlm(complete, [this.env.PLANNER_MODEL, this.env.PLANNER_FALLBACK_MODEL], q, today, tz);
    if (res.status === "ok" || reachable) return res;
    // Both models unreachable: no keyword fallback; the agent is told the planner is unavailable and can retry.
    return { status: "unsupported", reason: "planner_unavailable", supported: SUPPORTED_HELP };
  }
}
