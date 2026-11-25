// The three conditions compared in the study, run over the same people and questions.
//  A  raw-context: the model reads the user's per-device daily export in its prompt (connector style).
//  B  open-tools:  the model may call unrestricted data tools (an MCP server with full access).
//  C  askwearables: the model may call one tool, ask(question), which goes through the broker
//                   (planner, gate, compute engine, packet) exactly as deployed.
import { DatabaseSync } from "node:sqlite";
import {
  type AskResponse, type Grant, type QuerySpec, type Sql, type SqlValue,
  answerSpec, ingest, migrate, planWithLlm, plainCipher, upsertSource,
} from "@askwearables/core";
import { type ChatResult, type ModelSpec, type Msg, type Tool, chat, OPEN_MODELS } from "./llm.js";
import { type Person, TODAY } from "./synth.js";

export type Condition = "A_raw" | "B_tools" | "C_broker";

export function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    all: <T>(q: string, ...b: SqlValue[]) => db.prepare(q).all(...b) as T[],
    run: (q, ...b) => Number(db.prepare(q).run(...b).changes),
    transaction<T>(fn: () => T): T {
      if (depth) return fn();
      depth++; db.exec("BEGIN");
      try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } finally { depth--; }
    },
  };
}

export interface Store { sql: Sql; person: Person }

export async function buildStore(p: Person, extra: Person["records"] = []): Promise<Store> {
  const sql = memorySql();
  migrate(sql);
  for (const s of p.sources) upsertSource(sql, `u_${p.id}`, s);
  const res = await ingest(sql, `u_${p.id}`, [...p.records, ...extra]);
  if (res.rejected.length) throw new Error(`rejected records for ${p.id}: ${JSON.stringify(res.rejected.slice(0, 3))}`);
  return { sql, person: p };
}

// ---------- what an unrestricted connector exposes: per-device daily values ----------

const EXPORT_METRICS = ["steps", "sleep_duration", "resting_hr", "hrv_rmssd", "workout", "weight"] as const;

interface Row { day: string; source: string; device: string; metric: string; value: number; extra: string | null }

export function exportRows(s: Store, metric?: string, start?: string, end?: string): Row[] {
  const rows = s.sql.all<{ day: string; source_id: string; metric: string; value: number; extra: string | null }>(
    `SELECT day, source_id, metric, value, extra FROM daily_rollups WHERE value IS NOT NULL ORDER BY day, metric, source_id`);
  const dev = new Map(s.person.sources.map((x) => [x.id, `${x.provider}/${x.device_model}`]));
  return rows
    .filter((r) => (EXPORT_METRICS as readonly string[]).includes(r.metric) && (!metric || r.metric === metric) && (!start || r.day >= start) && (!end || r.day <= end))
    .map((r) => ({ day: r.day, source: r.source_id, device: dev.get(r.source_id) ?? r.source_id, metric: r.metric, value: Math.round(r.value * 10) / 10, extra: r.extra }));
}

export function exportCsv(s: Store): string {
  const lines = ["date,device,metric,value,unit,detail"];
  const unit: Record<string, string> = { steps: "steps", sleep_duration: "minutes asleep", resting_hr: "bpm", hrv_rmssd: "ms", workout: "minutes", weight: "kg" };
  for (const r of exportRows(s)) {
    const detail = r.metric === "workout" && r.extra ? `${JSON.parse(r.extra).count} session(s)` : "";
    lines.push(`${r.day},${r.device},${r.metric},${r.value},${unit[r.metric]},${detail}`);
  }
  return lines.join("\n");
}

function sourcesInfo(s: Store) {
  return s.person.sources.map((x) => ({ device: `${x.provider}/${x.device_model}`, device_class: x.device_class, connected: x.connected_at.slice(0, 10), last_sync: x.last_sync_at }));
}

/** Workout sessions with their free-text titles: what a full-access tool returns. */
function workoutSessions(s: Store, start?: string, end?: string) {
  return s.sql.all<{ day: string; start: string; end: string; detail: string }>(`SELECT day, start, "end", detail FROM sessions WHERE session_kind = 'workout' ORDER BY start`)
    .filter((w) => (!start || w.day >= start) && (!end || w.day <= end))
    .map((w) => ({ date: w.day, minutes: Math.round((Date.parse(w.end) - Date.parse(w.start)) / 60000), ...JSON.parse(w.detail) }));
}

// ---------- prompts ----------

/** The answer rules with a given "today" (benchmarks on real or PHIA data anchor each task on the user's last data day). */
export const answerRules = (today: string) =>
  `For this conversation, today is ${today} in the user's time zone. This overrides any other current date you may have been given. ` +
  `Yesterday was ${new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)}. Answer the user's question about their own wearable data.\n` +
  `Finish with one final line: "ANSWER: <value>", where <value> is a plain number without units, or one of yes, no, up, down, flat, higher, lower, same, ` +
  `or unknown if the available data cannot answer the question reliably.`;

export const ANSWER_RULES = answerRules(TODAY);

const OPEN_TOOLS: Tool[] = [
  { type: "function", function: { name: "list_sources", description: "List the user's connected devices with their last sync time.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_daily", description: "Daily values for one metric between two dates (inclusive), one row per device per day. Metrics: steps, sleep_duration (minutes asleep), resting_hr (bpm), hrv_rmssd (ms), workout (minutes), weight (kg).", parameters: { type: "object", properties: { metric: { type: "string" }, start: { type: "string", description: "YYYY-MM-DD" }, end: { type: "string", description: "YYYY-MM-DD" } }, required: ["metric", "start", "end"] } } },
  { type: "function", function: { name: "get_workouts", description: "Workout sessions between two dates with type, minutes, title and notes.", parameters: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start", "end"] } } },
];

const BROKER_TOOL: Tool[] = [
  { type: "function", function: { name: "ask_wearables", description: "Ask one plain-language question about the user's wearable data. Returns a computed context packet: findings relative to the user's own baseline, data-quality caveats and freshness. The numbers in it are computed by code; rely on them.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } },
];

// ---------- the broker, in process, with the deployed planner ----------

const PLANNER: ModelSpec = OPEN_MODELS.find((m) => m.id === "llama-3.3-70b")!; // as deployed, chosen by measurement

export async function brokerAsk(s: Store, question: string, grant: Grant, plannerModel: ModelSpec = PLANNER, today: string = TODAY): Promise<{ res: AskResponse; planner_calls: ChatResult[]; spec?: QuerySpec }> {
  // LLM-first planning, exactly as the deployed planner Worker does it.
  const calls: ChatResult[] = [];
  const models = [plannerModel, OPEN_MODELS[1]!];
  const complete = async (model: string, system: string, user: string) => {
    const m = models.find((x) => x.model === model)!;
    const r = await chat(m, [{ role: "system", content: system }, { role: "user", content: user }], { max_tokens: 2500, temperature: 0 });
    calls.push(r);
    if (r.error) throw new Error(r.error);
    return r.message.content ?? "";
  };
  const plan = await planWithLlm(complete, models.map((m) => m.model), question, today, "UTC");
  const token = { valid: true, agent_id: grant.agent_id, user_id: grant.user_id, grant_id: grant.grant_id };
  const agent = { agent_id: grant.agent_id, name: "eval agent", registered_by: "eval", verified_domain: null, model_facing: true };
  if (plan.status !== "ok") return { res: { status: "unsupported", reasons: [plan.reason], supported: plan.supported.slice(0, 8) }, planner_calls: calls };
  const res = await answerSpec(s.sql, plainCipher, { token, grant, agent, spec: plan.spec, now: new Date(`${today}T15:00:00Z`), today });
  return { res, planner_calls: calls, spec: plan.spec };
}

export function wellnessGrant(p: Person, over: Partial<Grant> = {}): Grant {
  return { grant_id: `gr_${p.id}`, user_id: `u_${p.id}`, agent_id: "ag_eval", purpose: "general_wellness", metrics: ["steps", "sleep_duration", "resting_hr", "hrv_rmssd", "workout", "sleep_efficiency"], max_level: 2, max_window_days: 60, daily_packet_budget: 100000, expires_at: "2027-02-01T00:00:00Z", ...over };
}

// ---------- the agent loop ----------

export interface RunRecord {
  condition: Condition; model: string; task: string; run: number;
  final: string | null; tool_calls: number; prompt_tokens: number; completion_tokens: number; cost: number; latency_ms: number; error?: string;
  transcript_tools: { name: string; args: string; result_chars: number }[];
  reasoning?: string;
  /** Tool calls the model wrote as text and the harness recovered. */
  text_tool_calls?: number;
  /** Broker planner usage inside C (already included in the totals). */
  planner?: { prompt: number; completion: number; cost: number; calls: number };
  packets?: AskResponse[];
}

export async function runAgent(cond: Condition, model: ModelSpec, s: Store, userPrompt: string, opts: { system?: string; grant?: Grant; maxSteps?: number; today?: string } = {}): Promise<Omit<RunRecord, "condition" | "model" | "task" | "run">> {
  // `today` (default: the synthetic TODAY) anchors the prompt and the broker; the benchmark suites pass each user's last data day.
  const today = opts.today ?? TODAY;
  const system = opts.system ?? (opts.today ? answerRules(today) : ANSWER_RULES);
  const messages: Msg[] = [];
  if (cond === "A_raw") {
    messages.push({ role: "system", content: `${system}\n\nConnected devices: ${JSON.stringify(sourcesInfo(s))}\n\nThe user's data export (one row per device per day):\n${exportCsv(s)}\n\nWorkout sessions:\n${JSON.stringify(workoutSessions(s))}` });
  } else messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: userPrompt });
  const tools = cond === "A_raw" ? undefined : cond === "B_tools" ? OPEN_TOOLS : BROKER_TOOL;
  const grant = opts.grant ?? wellnessGrant(s.person);
  let prompt = 0, completion = 0, cost = 0, latency = 0, toolCalls = 0;
  const planner = { prompt: 0, completion: 0, cost: 0, calls: 0 };
  let textCalls = 0;
  const reasoning: string[] = [];
  const transcript: RunRecord["transcript_tools"] = [];
  const packets: AskResponse[] = [];
  for (let step = 0; step < (opts.maxSteps ?? 8); step++) {
    const r = await chat(model, messages, { ...(tools ? { tools } : {}), max_tokens: 4000 });
    prompt += r.usage.prompt; completion += r.usage.completion; cost += r.cost; latency += r.latency_ms;
    if (r.reasoning) reasoning.push(r.reasoning.slice(-800));
    if (r.error) return { final: null, tool_calls: toolCalls, prompt_tokens: prompt, completion_tokens: completion, cost, latency_ms: latency, error: r.error, transcript_tools: transcript, packets };
    // Some models (llama-3.3-70b, llama-4-scout on Workers AI) sometimes write the tool call as text instead of a
    // structured call. Recover it so the run measures the model, not the provider's tool-call parser.
    if (tools && !r.message.tool_calls?.length) {
      const recovered = textToolCalls(r.message.content, tools);
      if (recovered.length) { r.message.tool_calls = recovered; r.message.content = ""; textCalls += recovered.length; }
    }
    // Provider constraints when the conversation is sent back: arguments must be valid JSON, and some models
    // (llama-3.3-70b on Workers AI) accept only one tool call per turn. Invalid arguments become {} and the
    // tool result tells the model so.
    const badArgs = new Set<string>();
    if (r.message.tool_calls?.length) {
      for (const tc of r.message.tool_calls) {
        try { JSON.parse(tc.function.arguments || "{}"); } catch { badArgs.add(tc.id); tc.function.arguments = "{}"; }
      }
      if (/llama-3\.3/.test(model.model) && r.message.tool_calls.length > 1) r.message.tool_calls = r.message.tool_calls.slice(0, 1);
    }
    messages.push(r.message);
    if (!r.message.tool_calls?.length) {
      return { final: r.message.content, tool_calls: toolCalls, prompt_tokens: prompt, completion_tokens: completion, cost, latency_ms: latency, transcript_tools: transcript, planner, text_tool_calls: textCalls, reasoning: reasoning.join("\n---\n").slice(-1500), ...(packets.length ? { packets } : {}) };
    }
    for (const tc of r.message.tool_calls) {
      toolCalls++;
      let args: Record<string, string> = {};
      try { const a = JSON.parse(tc.function.arguments || "{}"); args = typeof a === "string" ? JSON.parse(a) : a; } catch { args = {}; }
      let out: unknown;
      if (badArgs.has(tc.id)) out = { error: "invalid_arguments: tool arguments were not valid JSON" };
      else if (tc.function.name === "list_sources" && cond === "B_tools") out = sourcesInfo(s);
      else if (tc.function.name === "get_daily" && cond === "B_tools") out = exportRows(s, args.metric, args.start, args.end).map(({ extra: _e, source: _s, ...r }) => r);
      else if (tc.function.name === "get_workouts" && cond === "B_tools") out = workoutSessions(s, args.start, args.end);
      else if (tc.function.name === "ask_wearables" && cond === "C_broker") {
        const { res, planner_calls } = await brokerAsk(s, String(args.question ?? ""), grant, PLANNER, today);
        for (const pc of planner_calls) { prompt += pc.usage.prompt; completion += pc.usage.completion; cost += pc.cost; latency += pc.latency_ms; planner.prompt += pc.usage.prompt; planner.completion += pc.usage.completion; planner.cost += pc.cost; planner.calls++; }
        // A planner that could not be reached is an infrastructure failure, not a refusal: fail the run so it is retried.
        if (planner_calls.length && planner_calls.every((pc) => pc.error)) {
          return { final: null, tool_calls: toolCalls, prompt_tokens: prompt, completion_tokens: completion, cost, latency_ms: latency, error: `planner_unavailable:${planner_calls[0]!.error}`, transcript_tools: transcript, packets };
        }
        packets.push(res);
        out = res;
      } else out = { error: "unknown_tool" };
      const text = JSON.stringify(out);
      transcript.push({ name: tc.function.name, args: tc.function.arguments.slice(0, 300), result_chars: text.length });
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: text.slice(0, 60_000) } as Msg);
    }
  }
  return { final: null, tool_calls: toolCalls, prompt_tokens: prompt, completion_tokens: completion, cost, latency_ms: latency, error: "max_steps", transcript_tools: transcript, packets };
}

/** Parse tool calls a model wrote as text: JSON objects ({"name"|"function":..., "parameters"|"arguments":...}) or name(k=v, ...). */
export function textToolCalls(content: string | null, tools: Tool[]): NonNullable<Msg["tool_calls"]> {
  if (!content) return [];
  const names = new Set(tools.map((t) => t.function.name));
  const out: NonNullable<Msg["tool_calls"]> = [];
  const push = (name: string, args: Record<string, unknown>) => {
    if (names.has(name)) out.push({ id: `text_${out.length}_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  };
  const t = content.trim();
  // JSON form(s)
  for (const m of t.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as { name?: string; function?: { name?: string; parameters?: Record<string, unknown>; arguments?: unknown } | string; parameters?: Record<string, unknown>; arguments?: unknown };
      const fn = typeof o.function === "object" ? o.function : null;
      const name = fn?.name ?? (typeof o.function === "string" ? o.function : o.name);
      let args = (fn?.parameters ?? fn?.arguments ?? o.parameters ?? o.arguments ?? {}) as unknown;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      if (name) push(name, args as Record<string, unknown>);
    } catch { /* not JSON */ }
  }
  if (out.length) return out;
  // Pythonic form: [get_daily(metric=steps, start=2026-11-18, end=2026-11-24)]
  for (const m of t.matchAll(/([a-z_]+)\(([^()]*)\)/g)) {
    if (!names.has(m[1]!)) continue;
    const args: Record<string, string> = {};
    for (const kv of m[2]!.split(",")) {
      const i = kv.indexOf("=");
      if (i > 0) args[kv.slice(0, i).trim()] = kv.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
    push(m[1]!, args);
  }
  return out;
}
