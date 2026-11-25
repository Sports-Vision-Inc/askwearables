// The console's /api: forwards the owner's session to gate. Used by the console Worker and, unchanged,
// by the self-host edition.
import type { GateRpc } from "../../gate/src/rpc.js";
import type { PlannerRpc } from "../../planner/src/rpc.js";

export interface ApiEnv {
  GATE: GateRpc;
  /** The LLM planner: receives only the question text, holds no data. */
  PLANNER: PlannerRpc;
  AUTH_URL: string;
  CONSOLE_ORIGIN: string;
}

const SESSION_COOKIE = "__Secure-aw_session";

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export async function api(req: Request, env: ApiEnv, path: string): Promise<Response> {
  const session = cookie(req, SESSION_COOKIE);
  if (!session) return json({ error: "unauthenticated", login: `${env.AUTH_URL}/login?next=/` }, 401);
  // CSRF: state-changing calls must come from this origin with the custom header.
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin !== env.CONSOLE_ORIGIN || req.headers.get("x-aw-csrf") !== "1") return json({ error: "bad_origin" }, 403);
  }
  const cred = { session };
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const g = env.GATE;
  try {
    switch (`${req.method} ${path}`) {
      case "GET status": return json(await g.ownerStatus(cred));
      case "GET receipts": {
        const u = new URL(req.url);
        return json(await g.ownerReceipts(cred, Number(u.searchParams.get("limit") ?? 100), u.searchParams.get("before") ? Number(u.searchParams.get("before")) : undefined));
      }
      case "POST pause": return json(await g.ownerSetPaused(cred, body.paused === true));
      case "POST revoke": return json(await g.ownerRevokeGrant(cred, String(body.grant_id ?? "")));
      case "POST tz": return json(await g.ownerSetTz(cred, String(body.tz ?? "")));
      case "POST query": return json(await g.ownerQuery(cred, body.spec));
      case "POST ask": {
        // Plan with the LLM planner (question text only), then release through the gate like any query.
        const question = String(body.question ?? "").slice(0, 500);
        const tz = typeof body.tz === "string" && body.tz ? body.tz : "UTC";
        if (!question.trim()) return json({ status: "unsupported", reason: "empty_question" });
        const plan = await env.PLANNER.plan(question, tz, new Date().toISOString());
        if (plan.status !== "ok") return json({ status: plan.status, reason: plan.reason, supported: plan.supported });
        return json({ ...(await g.ownerQuery(cred, plan.spec)), spec: plan.spec });
      }
      case "POST import": return json(await g.ownerIngest(cred, body.source as never, (body.records ?? []) as never));
      case "POST keys": return json(await g.ownerCreateKey(cred, body.kind === "sync" ? "sync" : "owner", body.source as never));
      case "POST developer": return json(await g.ownerCreateDeveloperKey(cred, String(body.org ?? ""), String(body.agent ?? ""), typeof body.webhook_url === "string" ? body.webhook_url : undefined));
      case "GET export": {
        const data = await g.ownerExport(cred);
        return new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="askwearables-export-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" } });
      }
      case "POST delete": return json(await g.ownerDeleteEverything(cred, String(body.confirm ?? "")));
    }
  } catch (e) {
    const code = e instanceof Error ? e.message : "error";
    return json({ error: /^[a-z_]+$/.test(code) ? code : "error" }, code === "unauthenticated" ? 401 : 400);
  }
  return json({ error: "not_found" }, 404);
}

