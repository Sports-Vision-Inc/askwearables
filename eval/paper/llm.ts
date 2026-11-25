// One chat client for every model in the study: Workers AI (OpenAI-compatible endpoint) and OpenRouter.
// Records tokens, latency and cost per call. Stops all OpenRouter calls once the spend cap is reached.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface ModelSpec {
  id: string; // short name used in tables
  provider: "workers-ai" | "openrouter";
  model: string;
  family: string;
  /** USD per million tokens, input and output, for cost estimates where the provider reports none. */
  price?: [number, number];
}

export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface Tool { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }

export interface ChatResult { message: Msg; usage: { prompt: number; completion: number }; cost: number; latency_ms: number; error?: string; reasoning?: string }

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID ?? "d628e95a0bbafdd45ff52ca1189daae5";

function cfToken(): string {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const toml = readFileSync(`${homedir()}/Library/Preferences/.wrangler/config/default.toml`, "utf8");
  const m = /oauth_token\s*=\s*"([^"]+)"/.exec(toml);
  if (!m) throw new Error("No Cloudflare token: set CF_API_TOKEN or run wrangler login");
  return m[1]!;
}

/** Total OpenRouter spend allowed on the key, across all runs (the key itself is capped at $50). */
export const SPEND_CAP_USD = Number(process.env.EVAL_SPEND_CAP ?? 45);
export const spend = { openrouter: 0, workersAiCalls: 0, baseline: null as number | null };

/** The key's usage before this process started, read from OpenRouter, so the cap is global, not per process. */
async function orBaseline(): Promise<number> {
  if (spend.baseline !== null) return spend.baseline;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
    const j = (await r.json()) as { data?: { usage?: number } };
    spend.baseline = j.data?.usage ?? 0;
  } catch { spend.baseline = 0; }
  return spend.baseline;
}

// Documented limits (read 2026-11-25):
//  - Cloudflare API: 1,200 requests / 5 minutes per user token; exceeding it blocks all API calls for 5 minutes
//    (developers.cloudflare.com/fundamentals/api/reference/limits). Workers AI REST calls count against it.
//  - Workers AI text generation: 300 requests/minute per model (developers.cloudflare.com/workers-ai/platform/limits).
//  - OpenRouter ":free" models: 20 requests/minute; 50/day, or 1,000/day once 10+ credits were purchased
//    (openrouter.ai/docs/api-reference/limits). Paid models: no platform-level cap.
// We stay at 200/min on the Cloudflare token (headroom for deploys) and 18/min for free OpenRouter models.
function rateBucket(perMinute: number) {
  const stamps: number[] = [];
  return async () => {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0]! > 60_000) stamps.shift();
      if (stamps.length < perMinute) { stamps.push(now); return; }
      await new Promise((r) => setTimeout(r, 60_000 - (now - stamps[0]!) + 50));
    }
  };
}
const buckets = { cf: rateBucket(Number(process.env.EVAL_CF_RPM ?? 200)), orFree: rateBucket(18) };
// Models marked require_workers_paid in the Workers AI catalogue are limited to 20 requests/minute per model.
const PAID_TIER = new Set(["@cf/thinkingmachines/inkling-2-small"]);
const modelBuckets = new Map<string, () => Promise<void>>();
const modelBucket = (model: string) => modelBuckets.get(model) ?? modelBuckets.set(model, rateBucket(Number(process.env.EVAL_PAID_RPM ?? 18))).get(model)!;

// A small semaphore per provider for concurrency.
function limiter(n: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => q.push(r));
    active++;
    try { return await fn(); } finally { active--; q.shift()?.(); }
  };
}
const lim = { "workers-ai": limiter(Number(process.env.EVAL_CF_CONCURRENCY ?? 48)), openrouter: limiter(Number(process.env.EVAL_OR_CONCURRENCY ?? 6)) };

export async function chat(m: ModelSpec, messages: Msg[], opts: { tools?: Tool[]; max_tokens?: number; temperature?: number } = {}): Promise<ChatResult> {
  return lim[m.provider](async () => {
    if (m.provider === "openrouter" && (await orBaseline()) + spend.openrouter >= SPEND_CAP_USD) {
      return { message: { role: "assistant", content: null }, usage: { prompt: 0, completion: 0 }, cost: 0, latency_ms: 0, error: "spend_cap" };
    }
    const url = m.provider === "workers-ai"
      ? `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`
      : "https://openrouter.ai/api/v1/chat/completions";
    const key = m.provider === "workers-ai" ? cfToken() : process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    // Workers AI rejects null content; an assistant turn that only calls tools carries "".
    const wire = messages.map((x) => (x.content === null ? { ...x, content: "" } : x));
    const body: Record<string, unknown> = { model: m.model, messages: wire, max_tokens: opts.max_tokens ?? 4000 };
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (m.provider === "openrouter") body.usage = { include: true };
    for (let attempt = 0; attempt < 5; attempt++) {
      if (m.provider === "workers-ai") { if (PAID_TIER.has(m.model)) await modelBucket(m.model)(); await buckets.cf(); }
      else if (m.model.endsWith(":free")) await buckets.orFree();
      const t0 = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(m.provider === "openrouter" ? { "x-title": "AskWearables evaluation" } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
      } catch (e) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        if (attempt === 4) return { message: { role: "assistant", content: null }, usage: { prompt: 0, completion: 0 }, cost: 0, latency_ms: Date.now() - t0, error: `network:${(e as Error).name}` };
        continue;
      }
      const latency = Date.now() - t0;
      // The Wrangler OAuth token expires hourly. On a 401 from Workers AI, refresh it (any wrangler command does)
      // and retry, instead of recording an infrastructure failure.
      if (res.status === 401 && m.provider === "workers-ai" && attempt < 4) {
        try { (await import("node:child_process")).execSync("npx wrangler whoami", { stdio: "ignore", timeout: 60_000 }); } catch { /* retry anyway */ }
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt)));
        if (attempt < 4) continue;
      }
      const j = (await res.json().catch(() => ({}))) as { choices?: { message?: Msg }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }; error?: { message?: string }; errors?: { message?: string }[] };
      if (!res.ok || !j.choices?.[0]?.message) {
        return { message: { role: "assistant", content: null }, usage: { prompt: 0, completion: 0 }, cost: 0, latency_ms: latency, error: `http_${res.status}:${(j.error?.message ?? j.errors?.[0]?.message ?? "").slice(0, 400)}` };
      }
      const usage = { prompt: j.usage?.prompt_tokens ?? 0, completion: j.usage?.completion_tokens ?? 0 };
      let cost = j.usage?.cost ?? 0;
      if (!cost && m.price) cost = (usage.prompt * m.price[0] + usage.completion * m.price[1]) / 1e6;
      if (m.provider === "openrouter") spend.openrouter += cost;
      else spend.workersAiCalls++;
      const msg = j.choices[0].message as Msg & { reasoning?: string; reasoning_content?: string };
      const reasoning = (msg.reasoning ?? msg.reasoning_content ?? "").slice(-2000) || undefined;
      // Some models put the final text in reasoning fields only; keep content as given.
      return { message: { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) }, usage, cost, latency_ms: latency, ...(reasoning ? { reasoning } : {}) };
    }
    return { message: { role: "assistant", content: null }, usage: { prompt: 0, completion: 0 }, cost: 0, latency_ms: 0, error: "retries_exhausted" };
  });
}

/** The models in the study. Workers AI prices: developers.cloudflare.com/workers-ai/platform/pricing (USD per million input/output tokens, read 2026-11-25). */
export const OPEN_MODELS: ModelSpec[] = [
  { id: "inkling-2-small", provider: "workers-ai", model: "@cf/thinkingmachines/inkling-2-small", family: "Thinking Machines", price: [0.3, 1.0] },
  { id: "gpt-oss-120b", provider: "workers-ai", model: "@cf/openai/gpt-oss-120b", family: "OpenAI (open weights)", price: [0.35, 0.75] },
  { id: "gpt-oss-20b", provider: "workers-ai", model: "@cf/openai/gpt-oss-20b", family: "OpenAI (open weights)", price: [0.2, 0.3] },
  { id: "llama-3.3-70b", provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", family: "Meta", price: [0.293, 2.253] },
  { id: "llama-4-scout", provider: "workers-ai", model: "@cf/meta/llama-4-scout-17b-16e-instruct", family: "Meta", price: [0.27, 0.85] },
  { id: "gemma-4-26b", provider: "workers-ai", model: "@cf/google/gemma-4-26b-a4b-it", family: "Google (open weights)", price: [0.1, 0.3] },
  { id: "mistral-small-3.1", provider: "workers-ai", model: "@cf/mistralai/mistral-small-3.1-24b-instruct", family: "Mistral", price: [0.351, 0.555] },
];

export const FRONTIER_MODELS: ModelSpec[] = [
  { id: "claude-fable-5.2", provider: "openrouter", model: "anthropic/claude-fable-5.2", family: "Anthropic", price: [8, 40] },
  { id: "gpt-6.2-astra", provider: "openrouter", model: "openai/gpt-6.2-astra", family: "OpenAI", price: [8, 40] },
  { id: "gemini-4-neon", provider: "openrouter", model: "google/gemini-4-neon", family: "Google", price: [3, 15] },
];

/** Large open model served free on OpenRouter (20 requests/minute, daily cap). */
export const FREE_MODELS: ModelSpec[] = [
  { id: "nemotron-3-ultra-550b", provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", family: "NVIDIA (open weights)", price: [0, 0] },
];
