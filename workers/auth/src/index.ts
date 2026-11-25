// auth: owner sign-in (passkeys), agent OAuth 2.1 (PKCE, DCR, CIMD), and the consent screen.
// Three logins kept apart: the owner's session cookie, agents' access tokens, and provider tokens
// (which never come here; they live in vault).
import { WorkerEntrypoint } from "cloudflare:workers";
import { AuthorizationError, OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { CATALOGUE, type Grant, type Level, type MetricId, type Purpose, PURPOSES, newId, sha256Hex, validateGrant } from "@askwearables/core";
import { consentPage, loginPage, messagePage, securityHeaders } from "./pages.js";
import { WEBAUTHN_BROWSER_JS } from "./vendor/webauthn-browser.js";
import { FAVICON_ICO_B64, FAVICON_SVG } from "./vendor/favicon.js";
import { type AgentTokenProps, type AuthRpc, SESSION_COOKIE } from "./rpc.js";
import type { GateRpc } from "../../gate/src/rpc.js";
import {
  SCOPE, authOptions, authVerify, authorize, cookie, insertGrant, json, logout, nonce, readGrantForm, registerOptions, registerVerify,
  revokeAgentTokens, sameOrigin, sessionFor, setupAllowed, userToday,
} from "./flows.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  GATE: Fetcher & Pick<GateRpc, "consentExample" | "notifyOrg">;
  ISSUER: string; // https://auth.askwearables.app
  MCP_RESOURCE: string; // https://mcp.askwearables.app/mcp
  API_RESOURCE: string; // https://api.askwearables.app/v1
  RP_ID: string; // askwearables.app
  COOKIE_DOMAIN: string; // askwearables.app
  CONSOLE_URL: string;
  OWNER_SETUP_TOKEN: string;
}

let server: OAuthAuthorizationServer<Env> | null = null;
function as(env: Env): OAuthAuthorizationServer<Env> {
  server ??= new OAuthAuthorizationServer<Env>({
    issuer: env.ISSUER,
    resources: [env.MCP_RESOURCE, env.API_RESOURCE],
    defaultResource: env.MCP_RESOURCE,
    scopesSupported: [SCOPE, "offline_access"],
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
    accessTokenTTL: 3600,
  } as ConstructorParameters<typeof OAuthAuthorizationServer<Env>>[0]);
  return server;
}

/** Hosted consent for a developer's end user, reached through a one-time link. */
async function devConsent(req: Request, env: Env, token: string, sub: string): Promise<Response> {
  const link = await env.DB.prepare(`SELECT * FROM consent_links WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL`).bind(await sha256Hex(token), new Date().toISOString())
    .first<{ token_hash: string; org_id: string; user_id: string; agent_id: string; request: string; return_url: string | null }>();
  if (!link) return new Response(messagePage("Link expired", "Ask the app that sent you here for a new link."), { status: 410, headers: { "content-type": "text/html; charset=utf-8" } });
  const requested = JSON.parse(link.request) as { purpose: Purpose; metrics: MetricId[]; max_level: Level; max_window_days: number; daily_packet_budget: number; days: number };
  if (sub === "example") {
    const u = new URL(req.url);
    const metric = u.searchParams.get("metric") as MetricId;
    const level = Number(u.searchParams.get("level")) as 0 | 1 | 2;
    if (!requested.metrics.includes(metric) || ![0, 1, 2].includes(level)) return json({ example: "" });
    return json({ example: await env.GATE.consentExample(link.user_id, metric, level) });
  }
  const agent = await env.DB.prepare(`SELECT a.name, a.verified_domain, o.name AS org_name FROM agents a LEFT JOIN orgs o ON o.id = a.org_id WHERE a.agent_id = ?`).bind(link.agent_id).first<{ name: string; verified_domain: string | null; org_name: string | null }>();
  if (req.method === "GET") {
    const n = nonce();
    const html = consentPage({
      agentName: agent?.name ?? link.agent_id, agentDomain: agent?.verified_domain ?? null, registeredBy: agent?.org_name ?? link.org_id, redirectHost: link.return_url ? new URL(link.return_url).host : null,
      redirectIsLoopback: false, handle: "link", postTo: `/consent/${token}`, exampleUrl: `/consent/${token}/example`, requested, today: await userToday(env, link.user_id),
    }, n);
    return new Response(html, { headers: securityHeaders(n) });
  }
  if (req.method !== "POST" || !sameOrigin(req, env)) return new Response("Method not allowed", { status: 405 });
  const form = await req.formData();
  await env.DB.prepare(`UPDATE consent_links SET used_at = ? WHERE token_hash = ?`).bind(new Date().toISOString(), link.token_hash).run();
  const back = (q: string) => (link.return_url ? Response.redirect(`${link.return_url}${link.return_url.includes("?") ? "&" : "?"}${q}`, 302) : new Response(messagePage("Done", "You can close this page."), { headers: { "content-type": "text/html; charset=utf-8" } }));
  if (form.get("decision") !== "approve") return back("askwearables=denied");
  const f = readGrantForm(form);
  // The user can narrow what the developer asked for, never widen it.
  if (f.purpose !== requested.purpose || f.metrics.some((m) => !requested.metrics.includes(m)) || f.max_level > requested.max_level || f.max_window_days > requested.max_window_days || f.daily_packet_budget > requested.daily_packet_budget) {
    return new Response(messagePage("Not allowed", "The request was changed beyond what the app asked for."), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const grant: Grant = { grant_id: newId("gr"), user_id: link.user_id, agent_id: link.agent_id, ...f, sensitive: [] };
  const errs = validateGrant(grant, new Date());
  if (errs.length) return new Response(messagePage("Check the form", errs.join(", ")), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
  await env.DB.prepare(`UPDATE grants SET revoked_at = ? WHERE user_id = ? AND agent_id = ? AND revoked_at IS NULL`).bind(new Date().toISOString(), link.user_id, link.agent_id).run();
  await insertGrant(env, grant);
  await env.GATE.notifyOrg(link.agent_id, { type: "grant.created", grant_id: grant.grant_id, metrics: grant.metrics, max_level: grant.max_level, expires_at: grant.expires_at });
  return back(`askwearables=approved&grant_id=${grant.grant_id}`);
}

export default class AuthServer extends WorkerEntrypoint<Env> implements AuthRpc {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/favicon.svg") return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      if (p === "/favicon.ico") return new Response(Uint8Array.from(atob(FAVICON_ICO_B64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/x-icon", "cache-control": "public, max-age=86400" } });
      if (p === "/static/webauthn-browser.js") return new Response(WEBAUTHN_BROWSER_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
      if (p === "/authorize") return await authorize(req, this.env, as(this.env).getOAuthApi(this.env));
      if (p === "/login" && req.method === "GET") {
        const n = nonce();
        const next = url.searchParams.get("next") ?? "/";
        const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
        return new Response(loginPage(safeNext === "/" ? this.env.CONSOLE_URL : safeNext, n), { headers: securityHeaders(n, "'self'") });
      }
      if (p === "/setup" && req.method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        if (!(await setupAllowed(this.env, token))) return new Response(messagePage("Setup closed", "The owner account already exists, or the link is wrong."), { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
        const n = nonce();
        return new Response(loginPage(this.env.CONSOLE_URL, n, token), { headers: securityHeaders(n, "'self'") });
      }
      if (req.method === "POST" && p.startsWith("/webauthn/")) {
        if (!sameOrigin(req, this.env)) return json({ error: "bad origin" }, 403);
        if (p === "/webauthn/register/options") return await registerOptions(req, this.env);
        if (p === "/webauthn/register/verify") return await registerVerify(req, this.env);
        if (p === "/webauthn/auth/options") return await authOptions(this.env);
        if (p === "/webauthn/auth/verify") return await authVerify(req, this.env);
      }
      if (p === "/logout" && req.method === "POST") return await logout(req, this.env);
      if (p === "/consent-example") {
        const s = await sessionFor(this.env, cookie(req, SESSION_COOKIE));
        const metric = url.searchParams.get("metric") as MetricId;
        const level = Number(url.searchParams.get("level")) as 0 | 1 | 2;
        if (!s || !(metric in CATALOGUE) || ![0, 1, 2].includes(level)) return json({ example: "" });
        return json({ example: await this.env.GATE.consentExample(s.userId, metric, level) });
      }
      const m = /^\/consent\/(cl_[0-9a-f]{32})(?:\/(example))?$/.exec(p);
      if (m) return await devConsent(req, this.env, m[1]!, m[2] ?? "");
      if (p === "/" || p === "") return Response.redirect(this.env.CONSOLE_URL, 302);
      return await as(this.env).fetch(req, this.env, this.ctx); // discovery, token, registration, revocation
    } catch (e) {
      // No health values ever reach this Worker, so an error message cannot leak one; still keep it short.
      console.error("auth_error", p, e instanceof Error ? e.name : "error");
      if (e instanceof AuthorizationError) return new Response(messagePage("Cannot connect", e.message), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response(messagePage("Something went wrong", "Try again."), { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  }

  async validateToken(resource: string, token: string) {
    return as(this.env).validateToken<AgentTokenProps>(resource, token, this.env);
  }

  async sessionUser(cookieValue: string) {
    return sessionFor(this.env, cookieValue);
  }

  async revokeAgentTokens(userId: string, clientId: string | null): Promise<number> {
    return revokeAgentTokens(as(this.env).getOAuthApi(this.env), userId, clientId);
  }

  async scheduled(): Promise<void> {
    await as(this.env).purgeExpiredData(this.env);
    await this.env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(new Date().toISOString()).run();
    await this.env.DB.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`).bind(new Date().toISOString()).run();
  }
}

export { PURPOSES };
