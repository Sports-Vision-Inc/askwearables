// auth: owner sign-in (passkeys), agent OAuth 2.1 (PKCE, DCR, CIMD), and the consent screen.
// Three logins kept apart: the owner's session cookie, agents' access tokens, and provider tokens
// (which never come here; they live in vault).
import { WorkerEntrypoint } from "cloudflare:workers";
import { AuthorizationError, OAuthAuthorizationServer, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { CATALOGUE, type Grant, type Level, type MetricId, type Purpose, PURPOSES, newId, sha256Hex, todayIn, validateGrant } from "@askwearables/core";
import { consentPage, loginPage, messagePage, securityHeaders } from "./pages.js";
import { type AgentTokenProps, type AuthRpc, SESSION_COOKIE } from "./rpc.js";
import type { GateRpc } from "../../gate/src/rpc.js";

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

const SESSION_DAYS = 14;
const SCOPE = "wearables:ask";

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

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

function cookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") ?? "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function nonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

function sameOrigin(req: Request, env: Env): boolean {
  const o = req.headers.get("origin");
  return !o || o === new URL(env.ISSUER).origin;
}

async function sessionFor(env: Env, value: string | null): Promise<{ userId: string; role: string } | null> {
  if (!value || value.length < 20) return null;
  const row = await env.DB.prepare(`SELECT s.user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL`)
    .bind(await sha256Hex(value), new Date().toISOString()).first<{ user_id: string; role: string }>();
  return row ? { userId: row.user_id, role: row.role } : null;
}

async function newSession(env: Env, userId: string): Promise<string> {
  const value = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const exp = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(await sha256Hex(value), userId, new Date().toISOString(), exp.toISOString()).run();
  const domain = env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== "localhost" ? `; Domain=${env.COOKIE_DOMAIN}` : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${domain}`;
}

// ---------- passkeys ----------

async function saveChallenge(env: Env, challenge: string, userId: string | null): Promise<string> {
  const id = newId("ch");
  await env.DB.prepare(`INSERT INTO webauthn_challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)`).bind(id, challenge, userId, new Date(Date.now() + 300_000).toISOString()).run();
  return id;
}
async function takeChallenge(env: Env, id: string | null): Promise<{ challenge: string; user_id: string | null } | null> {
  if (!id) return null;
  const row = await env.DB.prepare(`SELECT challenge, user_id FROM webauthn_challenges WHERE id = ? AND expires_at > ?`).bind(id, new Date().toISOString()).first<{ challenge: string; user_id: string | null }>();
  await env.DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(id).run();
  return row;
}
const challengeCookie = (id: string) => `__Host-aw_ch=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`;

async function setupAllowed(env: Env, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !env.OWNER_SETUP_TOKEN || token.length !== env.OWNER_SETUP_TOKEN.length) return false;
  let d = 0;
  for (let i = 0; i < token.length; i++) d |= token.charCodeAt(i) ^ env.OWNER_SETUP_TOKEN.charCodeAt(i);
  if (d !== 0) return false;
  const owner = await env.DB.prepare(`SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL`).first();
  return !owner; // setup works once: only while no owner exists
}

async function registerOptions(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { setup?: string };
  const session = await sessionFor(env, cookie(req, SESSION_COOKIE));
  let userId = session?.userId ?? null;
  if (!userId) {
    if (!(await setupAllowed(env, body.setup))) return json({ error: "Not allowed" }, 403);
    userId = newId("u");
  }
  const opts = await generateRegistrationOptions({
    rpName: "AskWearables",
    rpID: env.RP_ID,
    userName: "owner",
    userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const id = await saveChallenge(env, opts.challenge, userId);
  return json(opts, 200, { "set-cookie": challengeCookie(id) });
}

async function registerVerify(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { setup?: string; response?: unknown };
  const ch = await takeChallenge(env, cookie(req, "__Host-aw_ch"));
  if (!ch?.user_id) return json({ ok: false, error: "Challenge expired" }, 400);
  const session = await sessionFor(env, cookie(req, SESSION_COOKIE));
  const isSetup = !session;
  if (isSetup && !(await setupAllowed(env, body.setup))) return json({ ok: false, error: "Not allowed" }, 403);
  if (session && session.userId !== ch.user_id) return json({ ok: false, error: "Session changed" }, 400);
  const v = await verifyRegistrationResponse({ response: body.response as never, expectedChallenge: ch.challenge, expectedOrigin: new URL(env.ISSUER).origin, expectedRPID: env.RP_ID, requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) return json({ ok: false, error: "Not verified" }, 400);
  const c = v.registrationInfo.credential;
  const now = new Date().toISOString();
  if (isSetup) await env.DB.prepare(`INSERT INTO users (id, tz, role, created_at) VALUES (?, 'UTC', 'owner', ?)`).bind(ch.user_id, now).run();
  await env.DB.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(c.id, ch.user_id, b64url(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), now).run();
  const headers = new Headers({ "content-type": "application/json" });
  if (isSetup) headers.append("set-cookie", await newSession(env, ch.user_id));
  return new Response(JSON.stringify({ ok: true }), { headers });
}

async function authOptions(env: Env): Promise<Response> {
  const opts = await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: "required" });
  const id = await saveChallenge(env, opts.challenge, null);
  return json(opts, 200, { "set-cookie": challengeCookie(id) });
}

async function authVerify(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { response?: { id?: string } };
  const ch = await takeChallenge(env, cookie(req, "__Host-aw_ch"));
  if (!ch) return json({ ok: false, error: "Challenge expired" }, 400);
  const credId = body.response?.id;
  if (typeof credId !== "string") return json({ ok: false, error: "Bad response" }, 400);
  const pk = await env.DB.prepare(`SELECT * FROM passkeys WHERE id = ?`).bind(credId).first<{ id: string; user_id: string; public_key: string; counter: number; transports: string | null }>();
  if (!pk) return json({ ok: false, error: "Unknown passkey" }, 400);
  const v = await verifyAuthenticationResponse({
    response: body.response as never, expectedChallenge: ch.challenge, expectedOrigin: new URL(env.ISSUER).origin, expectedRPID: env.RP_ID, requireUserVerification: true,
    credential: { id: pk.id, publicKey: unb64url(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined },
  });
  if (!v.verified) return json({ ok: false, error: "Not verified" }, 400);
  await env.DB.prepare(`UPDATE passkeys SET counter = ? WHERE id = ?`).bind(v.authenticationInfo.newCounter, pk.id).run();
  return json({ ok: true }, 200, { "set-cookie": await newSession(env, pk.user_id) });
}

// ---------- consent ----------

interface GrantForm { purpose: Purpose; metrics: MetricId[]; sensitive: MetricId[]; max_level: Level; max_window_days: number; daily_packet_budget: number; expires_at: string }

function readGrantForm(form: FormData): GrantForm {
  const expires = String(form.get("expires") ?? "");
  return {
    purpose: String(form.get("purpose")) as Purpose,
    metrics: [...new Set([...form.getAll("metric"), ...form.getAll("sensitive")].map(String))] as MetricId[],
    sensitive: form.getAll("sensitive").map(String) as MetricId[],
    max_level: Number(form.get("max_level")) as Level,
    max_window_days: Number(form.get("max_window_days")),
    daily_packet_budget: Number(form.get("daily_packet_budget")),
    expires_at: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? `${expires}T23:59:59Z` : "",
  };
}

async function userToday(env: Env, userId: string): Promise<string> {
  const tz = (await env.DB.prepare(`SELECT tz FROM users WHERE id = ?`).bind(userId).first<{ tz: string }>())?.tz ?? "UTC";
  return todayIn(tz, new Date());
}

async function upsertAgent(env: Env, agentId: string, name: string, registeredBy: string, domain: string | null) {
  await env.DB.prepare(`INSERT INTO agents (agent_id, name, registered_by, verified_domain, model_facing, created_at) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name, verified_domain = excluded.verified_domain`).bind(agentId, name.slice(0, 120), registeredBy, domain, new Date().toISOString()).run();
}

async function insertGrant(env: Env, g: Grant) {
  await env.DB.prepare(`INSERT INTO grants (grant_id, user_id, agent_id, purpose, metrics, sensitive, max_level, max_window_days, daily_packet_budget, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(g.grant_id, g.user_id, g.agent_id, g.purpose, JSON.stringify(g.metrics), JSON.stringify(g.sensitive ?? []), g.max_level, g.max_window_days, g.daily_packet_budget, g.expires_at, new Date().toISOString()).run();
}

async function authorize(req: Request, env: Env): Promise<Response> {
  const oauth = as(env).getOAuthApi(env);
  const session = await sessionFor(env, cookie(req, SESSION_COOKIE));
  const url = new URL(req.url);
  if (req.method === "GET") {
    let authReq: AuthRequest;
    try { authReq = await oauth.parseAuthRequest(req); } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      return new Response(messagePage("Cannot connect", e instanceof Error ? e.message : "Invalid request"), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (!session) return Response.redirect(`${env.ISSUER}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    const d = await oauth.describeConsent(authReq);
    const consent = await oauth.beginConsent(authReq);
    const n = nonce();
    const html = consentPage({
      agentName: d.clientName, agentDomain: d.clientDomain ?? null, registeredBy: d.clientDomain ? `the owner of ${d.clientDomain}` : "itself (dynamic registration)",
      redirectHost: d.redirectHost, redirectIsLoopback: d.redirectIsLoopback, handle: consent.handle, postTo: "/authorize", exampleUrl: "/consent-example", today: await userToday(env, session.userId),
    }, n);
    const headers = new Headers(consent.headers);
    for (const [k, v] of Object.entries(securityHeaders(n))) headers.set(k, v);
    return new Response(html, { headers });
  }
  if (req.method !== "POST" || !sameOrigin(req, env)) return new Response("Method not allowed", { status: 405 });
  if (!session) return new Response(messagePage("Signed out", "Sign in and start again."), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(req, handle, { scope: [SCOPE] });
  const d = await oauth.describeConsent(approved.request);
  const f = readGrantForm(form);
  const grant: Grant = { grant_id: newId("gr"), user_id: session.userId, agent_id: approved.request.clientId, ...f };
  const errs = validateGrant(grant, new Date());
  if (errs.length) return new Response(messagePage("Check the form", `Some choices were not valid: ${errs.join(", ")}. Go back and try again.`), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
  await upsertAgent(env, grant.agent_id, d.clientName, d.clientDomain ? "cimd" : "dcr", d.clientDomain ?? null);
  await insertGrant(env, grant);
  const props: AgentTokenProps = { userId: session.userId, agentId: grant.agent_id, grantId: grant.grant_id };
  const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: session.userId, metadata: { grant_id: grant.grant_id }, scope: approved.request.scope, props });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
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
      if (p === "/authorize") return await authorize(req, this.env);
      if (p === "/login" && req.method === "GET") {
        const n = nonce();
        const next = url.searchParams.get("next") ?? "/";
        const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
        return new Response(loginPage(safeNext === "/" ? this.env.CONSOLE_URL : safeNext, n), { headers: securityHeaders(n, "https://unpkg.com") });
      }
      if (p === "/setup" && req.method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        if (!(await setupAllowed(this.env, token))) return new Response(messagePage("Setup closed", "The owner account already exists, or the link is wrong."), { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
        const n = nonce();
        return new Response(loginPage(this.env.CONSOLE_URL, n, token), { headers: securityHeaders(n, "https://unpkg.com") });
      }
      if (req.method === "POST" && p.startsWith("/webauthn/")) {
        if (!sameOrigin(req, this.env)) return json({ error: "bad origin" }, 403);
        if (p === "/webauthn/register/options") return await registerOptions(req, this.env);
        if (p === "/webauthn/register/verify") return await registerVerify(req, this.env);
        if (p === "/webauthn/auth/options") return await authOptions(this.env);
        if (p === "/webauthn/auth/verify") return await authVerify(req, this.env);
      }
      if (p === "/logout" && req.method === "POST") {
        const v = cookie(req, SESSION_COOKIE);
        if (v) await this.env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sha256Hex(v)).run();
        const domain = this.env.COOKIE_DOMAIN !== "localhost" ? `; Domain=${this.env.COOKIE_DOMAIN}` : "";
        return new Response(null, { status: 303, headers: { location: `${this.env.ISSUER}/login`, "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0${domain}` } });
      }
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
    const oauth = as(this.env).getOAuthApi(this.env);
    let n = 0;
    let cursor: string | undefined;
    do {
      const page = await oauth.listUserGrants(userId, cursor ? { cursor } : {});
      for (const g of page.items) {
        if (clientId === null || g.clientId === clientId) {
          await oauth.revokeGrant(g.id, userId);
          n++;
        }
      }
      cursor = page.cursor;
    } while (cursor);
    return n;
  }

  async scheduled(): Promise<void> {
    await as(this.env).purgeExpiredData(this.env);
    await this.env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(new Date().toISOString()).run();
    await this.env.DB.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`).bind(new Date().toISOString()).run();
  }
}

export { PURPOSES };
