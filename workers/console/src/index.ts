// console: app.askwearables.app. Static assets plus a small /api that forwards the owner's session
// to gate. It never reads health data or provider tokens itself.
import type { GateRpc } from "../../gate/src/rpc.js";

export interface Env {
  ASSETS: Fetcher;
  GATE: Fetcher & GateRpc;
  AUTH_URL: string;
  CONSOLE_ORIGIN: string;
}

const SESSION_COOKIE = "__Secure-aw_session";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

const SECURITY = {
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://auth.askwearables.app",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
};

async function api(req: Request, env: Env, path: string): Promise<Response> {
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    let res: Response;
    if (url.pathname.startsWith("/api/")) res = await api(req, env, url.pathname.slice(5));
    else res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;
