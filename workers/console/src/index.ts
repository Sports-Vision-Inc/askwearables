// console: app.askwearables.app. Static assets plus a small /api that forwards the owner's session
// to gate. It never reads health data or provider tokens itself.
import type { GateRpc } from "../../gate/src/rpc.js";
import type { PlannerRpc } from "../../planner/src/rpc.js";
import { api } from "./api.js";

export interface Env {
  ASSETS: Fetcher;
  GATE: Fetcher & GateRpc;
  /** The same LLM planner agents use: the console's Ask box sends only the question text to it. */
  PLANNER: Fetcher & PlannerRpc;
  AUTH_URL: string;
  CONSOLE_ORIGIN: string;
}

const SECURITY = {
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://auth.askwearables.app",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
};

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
