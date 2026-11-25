// edge: adapters only. MCP on mcp.askwearables.app/mcp, REST on api.askwearables.app/v1.
// It holds no data and no policy: it plans through planner and asks gate, which re-checks everything.
// The handlers themselves are in handlers.ts; this file hosts them behind the two OAuth resource servers.
import { OAuthResourceServer, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import type { AgentAuth } from "../../gate/src/rpc.js";
import type { AgentTokenProps } from "../../auth/src/rpc.js";
import { type Env, json, mcpFetch, rest, restAgent } from "./handlers.js";

export type { Env };

let mcpRS: OAuthResourceServer<Env, AgentTokenProps> | null = null;
let apiRS: OAuthResourceServer<Env, AgentTokenProps> | null = null;

function mcpResource(env: Env) {
  mcpRS ??= new OAuthResourceServer<Env, AgentTokenProps>({
    resourceMetadata: { resource: env.MCP_RESOURCE, authorization_servers: [env.ISSUER], resource_name: "AskWearables MCP" },
    requiredScopes: ["wearables:ask"],
    validateToken: (e) => e.AUTH.validateToken.bind(e.AUTH) as never,
    handler: {
      async fetch(request: Request, e: Env, ctx: OAuthResourceContext<AgentTokenProps>) {
        const auth: AgentAuth = { kind: "oauth", resource: e.MCP_RESOURCE, token: ctx.auth.token };
        return mcpFetch(request, e, ctx as unknown as ExecutionContext, auth);
      },
    },
  });
  return mcpRS;
}

function apiResource(env: Env) {
  apiRS ??= new OAuthResourceServer<Env, AgentTokenProps>({
    resourceMetadata: { resource: env.API_RESOURCE, authorization_servers: [env.ISSUER], resource_name: "AskWearables REST API" },
    requiredScopes: ["wearables:ask"],
    validateToken: (e) => e.AUTH.validateToken.bind(e.AUTH) as never,
    handler: {
      async fetch(request: Request, e: Env, ctx: OAuthResourceContext<AgentTokenProps>) {
        return restAgent(request, e, { kind: "oauth", resource: e.API_RESOURCE, token: ctx.auth.token });
      },
    },
  });
  return apiRS;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname;
    // MCP lives at /mcp (and its RFC 9728 metadata); everything else is REST, whichever host it arrived on.
    const isMcp = host !== env.API_HOST && (url.pathname === "/mcp" || url.pathname.startsWith("/.well-known/oauth-protected-resource/mcp"));
    try {
      if (isMcp) return await mcpResource(env).fetch(req, env, ctx);
      return await rest(req, env, (r) => apiResource(env).fetch(r, env, ctx));
    } catch (e) {
      console.error("edge_error", e instanceof Error ? e.name : "error");
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
