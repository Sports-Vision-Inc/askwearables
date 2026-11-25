// AskWearables, self-host edition: one Worker for one owner.
//
// The hosted service runs seven Workers in separate trust zones (site, console, auth, edge, planner, gate,
// vault) joined by service bindings. Here the same code runs in one Worker: each zone's class or handler is
// imported from vendor/ (copied unchanged from workers/* and packages/*) and called in-process instead of
// over a binding. Nothing below re-implements policy, planning, compute or receipts; it only routes.
//
//   /mcp, /v1/*              agents (OAuth access token), via the combined OAuthProvider's apiRoute
//   /v1/* with aw_own_...    the owner's API key; aw_sync_... a phone's sync key (ingest only)
//   /authorize               the eight-item consent screen (defaultHandler)
//   /setup, /login, /webauthn/*, /logout   owner sign-in with a passkey
//   /, /api/*                the owner's console
import { OAuthProvider, type OAuthHelpers, type OAuthProviderOptions, type OAuthResourceAuth, getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { ValidatedAccessToken } from "@cloudflare/workers-oauth-provider";
import Gate from "../vendor/workers/gate/src/index.js";
import VaultService, { UserVault } from "../vendor/workers/vault/src/index.js";
import Planner from "../vendor/workers/planner/src/index.js";
import type { AgentAuth } from "../vendor/workers/gate/src/rpc.js";
import { type AgentTokenProps, type AuthRpc, SESSION_COOKIE } from "../vendor/workers/auth/src/rpc.js";
import {
  type FlowEnv, SCOPE, authOptions, authVerify, authorize, cookie, html, logout, nonce, registerOptions, registerVerify,
  revokeAgentTokens, sameOrigin, sessionFor, setupAllowed,
} from "../vendor/workers/auth/src/flows.js";
import { loginPage, messagePage, securityHeaders } from "../vendor/workers/auth/src/pages.js";
import { WEBAUTHN_BROWSER_JS } from "../vendor/workers/auth/src/vendor/webauthn-browser.js";
import { type Env as EdgeEnv, json, mcpFetch, rest, restAgent } from "../vendor/workers/edge/src/handlers.js";
import { api } from "../vendor/workers/console/src/api.js";
import { CATALOGUE, type MetricId } from "@askwearables/core";
import { OPERATOR_NOTICE, SELFHOST_TERMS } from "./terms.js";

export { UserVault };

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  USER_VAULT: DurableObjectNamespace<UserVault>;
  AI: Ai;
  ASSETS: Fetcher;
  MASTER_KEY: string;
  OWNER_SETUP_TOKEN: string;
  PLANNER_MODEL: string;
  PLANNER_FALLBACK_MODEL: string;
  AI_GATEWAY_ID?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
}

/** REST routes of the hosted developer platform. A self-hosted instance has one owner and no developers. */
const NOT_IN_SELFHOST = new Set(["/v1/developer", "/v1/users", "/v1/usage"]);

// ---------- the zones, wired in-process ----------

/** gate's key for developer signing secrets, derived from MASTER_KEY so the deployer sets one secret, not two. */
const gateSecrets = new Map<string, Promise<string>>();
function gateSecret(masterB64: string): Promise<string> {
  let p = gateSecrets.get(masterB64);
  if (!p) {
    p = (async () => {
      const raw = Uint8Array.from(atob(masterB64), (c) => c.charCodeAt(0));
      const key = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("askwearables-selfhost:gate") }, key, 256);
      return btoa(String.fromCharCode(...new Uint8Array(bits)));
    })();
    gateSecrets.set(masterB64, p);
  }
  return p;
}

/** auth's RPC surface (what gate calls to re-check a token or a session), backed by this Worker's OAuth store. */
function authRpc(env: Env, oauth: OAuthHelpers): AuthRpc {
  return {
    async validateToken(resource: string, token: string): Promise<ValidatedAccessToken<AgentTokenProps> | null> {
      const t = await oauth.unwrapToken<AgentTokenProps>(token); // null when unknown or expired
      if (!t) return null;
      const audience = Array.isArray(t.audience) ? t.audience : t.audience ? [t.audience] : [];
      if (!audience.includes(resource)) return null;
      return { props: t.grant.props, audience: resource, expiresAt: t.expiresAt, scope: t.scope, userId: t.userId, clientId: t.grant.clientId };
    },
    sessionUser: (value: string) => sessionFor(env, value),
    revokeAgentTokens: (userId: string, clientId: string | null) => revokeAgentTokens(oauth, userId, clientId),
  };
}

interface Zones { gate: Gate; edgeEnv: EdgeEnv; flowEnv: FlowEnv }

async function zones(env: Env, ctx: ExecutionContext, origin: string, oauth: OAuthHelpers): Promise<Zones> {
  const vault = new VaultService(ctx, { USER_VAULT: env.USER_VAULT, ANCHORS: undefined as never, MASTER_KEY: env.MASTER_KEY });
  const auth = authRpc(env, oauth);
  const gate = new Gate(ctx, { DB: env.DB, VAULT: vault as never, AUTH: auth as never, GATE_SECRET: await gateSecret(env.MASTER_KEY) });
  const planner = new Planner(ctx, {
    AI: env.AI, PLANNER_MODEL: env.PLANNER_MODEL, PLANNER_FALLBACK_MODEL: env.PLANNER_FALLBACK_MODEL,
    ...(env.AI_GATEWAY_ID ? { AI_GATEWAY_ID: env.AI_GATEWAY_ID } : {}),
  });
  const host = new URL(origin).hostname;
  const resource = resourceFor(origin);
  const edgeEnv: EdgeEnv = {
    AUTH: auth as never, GATE: gate as never, PLANNER: planner as never,
    ISSUER: origin, MCP_RESOURCE: resource, API_RESOURCE: resource, MCP_HOST: host, API_HOST: host,
  };
  const flowEnv: FlowEnv = { DB: env.DB, GATE: gate, ISSUER: origin, RP_ID: host, COOKIE_DOMAIN: "", OWNER_SETUP_TOKEN: env.OWNER_SETUP_TOKEN, TERMS: SELFHOST_TERMS };
  return { gate, edgeEnv, flowEnv };
}

// ---------- OAuth: one combined provider per origin ----------

/** One protected resource, the origin itself, so both /mcp and /v1 sit under it. */
const resourceFor = (origin: string) => `${origin}/`;

/**
 * MCP clients may name the server URL itself (`<origin>/mcp`) as the RFC 8707 resource rather than the
 * resource from the metadata. The provider maps only query variants onto a configured resource, so the
 * two endpoint URLs are mapped onto the origin here, as RFC 8707 §2.2 allows an authorization server to
 * do. The token is no broader for it: its audience is the one resource this Worker serves.
 */
async function mapResourceParam(req: Request, origin: string): Promise<Request> {
  const url = new URL(req.url);
  const endpoints = new Set([`${origin}/mcp`, `${origin}/v1`]);
  const map = (params: URLSearchParams) => {
    const values = params.getAll("resource");
    if (!values.some((v) => endpoints.has(v))) return false;
    params.delete("resource");
    for (const v of new Set(values.map((v) => (endpoints.has(v) ? resourceFor(origin) : v)))) params.append("resource", v);
    return true;
  };
  if (url.pathname === "/authorize" && req.method === "GET") {
    return map(url.searchParams) ? new Request(url, req) : req;
  }
  if (url.pathname === "/oauth/token" && req.method === "POST" && (req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await req.clone().text());
    if (!map(form)) return req;
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    return new Request(req.url, { method: "POST", headers, body: form.toString() });
  }
  return req;
}

const providers = new Map<string, { options: OAuthProviderOptions<Env>; provider: OAuthProvider<Env> }>();

function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    const options: OAuthProviderOptions<Env> = {
      apiRoute: ["/mcp", "/v1"],
      apiHandler: { fetch: (req, env, ctx) => agentApi(req, env as Env, ctx) },
      defaultHandler: { fetch: (req, env, ctx) => site(req, env as Env, ctx) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE, "offline_access"],
      requiredScopes: [SCOPE],
      accessTokenTTL: 3600,
      resourceMetadata: { resource: resourceFor(origin), authorization_servers: [origin], resource_name: "AskWearables (self-hosted)" },
    };
    p = { options, provider: new OAuthProvider<Env>(options) };
    providers.set(origin, p);
  }
  return p;
}

const helpersFor = (env: Env, origin: string): OAuthHelpers => env.OAUTH_PROVIDER ?? getOAuthApi(providerFor(origin).options, env);

/** apiRoute: requests that arrived with a valid OAuth access token. */
async function agentApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const { auth } = ctx as unknown as { auth: OAuthResourceAuth };
  const z = await zones(env, ctx, url.origin, helpersFor(env, url.origin));
  const agent: AgentAuth = { kind: "oauth", resource: auth.audience, token: auth.token };
  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return mcpFetch(req, z.edgeEnv, ctx, agent);
  return restAgent(req, z.edgeEnv, agent);
}

// ---------- pages: sign-in, consent, console ----------

const CONSOLE_SECURITY: Record<string, string> = {
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function withHeaders(res: Response, headers: Record<string, string>, https: boolean): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  if (https) out.headers.set("strict-transport-security", "max-age=31536000");
  return out;
}

async function ownerExists(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL`).first());
}

function notSetUpPage(): Response {
  return html(messagePage("Finish setting up AskWearables",
    "This instance has no owner yet. Open /setup?token=… with the OWNER_SETUP_TOKEN secret you set when you deployed, then create a passkey. " + OPERATOR_NOTICE), 200);
}

/** defaultHandler: everything that is not an agent API call. */
async function site(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const https = url.protocol === "https:";
  const z = await zones(env, ctx, url.origin, helpersFor(env, url.origin));
  const f = z.flowEnv;

  if (p === "/static/webauthn-browser.js") return new Response(WEBAUTHN_BROWSER_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  if (p === "/authorize") return await authorize(req, f, helpersFor(env, url.origin));
  if (p === "/setup" && req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    if (!(await setupAllowed(f, token))) return html(messagePage("Setup closed", "The owner account already exists, or the link is wrong."), 403);
    const n = nonce();
    return new Response(loginPage("/", n, token, SELFHOST_TERMS), { headers: securityHeaders(n, "'self'") });
  }
  if (p === "/login" && req.method === "GET") {
    if (!(await ownerExists(env))) return notSetUpPage();
    const n = nonce();
    const next = url.searchParams.get("next") ?? "/";
    const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    return new Response(loginPage(safeNext, n), { headers: securityHeaders(n, "'self'") });
  }
  if (req.method === "POST" && p.startsWith("/webauthn/")) {
    if (!sameOrigin(req, f)) return json({ error: "bad origin" }, 403);
    ctx.waitUntil(cleanup(env));
    if (p === "/webauthn/register/options") return await registerOptions(req, f);
    if (p === "/webauthn/register/verify") return await registerVerify(req, f);
    if (p === "/webauthn/auth/options") return await authOptions(f);
    if (p === "/webauthn/auth/verify") return await authVerify(req, f);
  }
  if (p === "/logout" && req.method === "POST") return await logout(req, f);
  if (p === "/consent-example") {
    const s = await sessionFor(f, cookie(req, SESSION_COOKIE));
    const metric = url.searchParams.get("metric") as MetricId;
    const level = Number(url.searchParams.get("level")) as 0 | 1 | 2;
    if (!s || !(metric in CATALOGUE) || ![0, 1, 2].includes(level)) return json({ example: "" });
    return json({ example: await z.gate.consentExample(s.userId, metric, level) });
  }
  if (p.startsWith("/api/")) {
    const path = p.slice(5);
    if (path === "developer") return withHeaders(json({ error: "not_available_in_selfhost" }, 404), CONSOLE_SECURITY, https);
    return withHeaders(await api(req, { GATE: z.gate, AUTH_URL: url.origin, CONSOLE_ORIGIN: url.origin }, path), CONSOLE_SECURITY, https);
  }
  if ((p === "/" || p === "/index.html") && !(await ownerExists(env))) return notSetUpPage();
  return withHeaders(await env.ASSETS.fetch(req), CONSOLE_SECURITY, https);
}

/** The hosted service purges these on a cron; here, after sign-in traffic. */
async function cleanup(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM nonces WHERE expires_at < ?`).bind(now),
  ]);
}

function missingSecrets(env: Env): string[] {
  const out: string[] = [];
  try { if (atob(env.MASTER_KEY ?? "").length !== 32) out.push("MASTER_KEY (32 random bytes, base64: openssl rand -base64 32)"); } catch { out.push("MASTER_KEY (not valid base64)"); }
  if (!env.OWNER_SETUP_TOKEN || env.OWNER_SETUP_TOKEN.length < 16) out.push("OWNER_SETUP_TOKEN (at least 16 characters: openssl rand -hex 24)");
  return out;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      const missing = missingSecrets(env);
      if (missing.length) {
        return html(messagePage("Secrets missing", `Set these Worker secrets in the Cloudflare dashboard (Settings, Variables and Secrets), then reload: ${missing.join("; ")}.`), 503);
      }
      const { provider, options } = providerFor(url.origin);
      if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
        // Owner and sync keys are handled by edge's REST code itself, before OAuth; agent tokens fall through to it.
        const authz = req.headers.get("authorization") ?? "";
        if (authz.startsWith("Bearer aw_dev_") || NOT_IN_SELFHOST.has(url.pathname) || (url.pathname === "/v1/grants" && req.method === "POST")) {
          return json({ error: "not_available_in_selfhost" }, 404);
        }
        if (authz.startsWith("Bearer aw_own_") || authz.startsWith("Bearer aw_sync_")) {
          const z = await zones(env, ctx, url.origin, getOAuthApi(options, env));
          return await rest(req, z.edgeEnv, (r) => provider.fetch(r, env, ctx));
        }
      }
      return await provider.fetch(await mapResourceParam(req, url.origin), env, ctx);
    } catch (e) {
      console.error("selfhost_error", url.pathname, e instanceof Error ? `${e.name}: ${e.message}` : "error");
      if (url.pathname.startsWith("/mcp") || url.pathname.startsWith("/v1") || url.pathname.startsWith("/api/")) return json({ error: "internal_error" }, 500);
      return html(messagePage("Something went wrong", "Try again."), 500);
    }
  },
} satisfies ExportedHandler<Env>;
