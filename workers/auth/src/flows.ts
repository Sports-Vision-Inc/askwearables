// Owner sign-in (passkeys, sessions) and the agent consent flow. Shared by the hosted auth Worker and
// the self-host edition, which runs the same code inside one Worker. Nothing here knows the host name:
// the issuer, RP ID and cookie domain come from the caller's env.
import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type Grant, type Level, type MetricId, type Purpose, newId, sha256Hex, todayIn, validateGrant } from "@askwearables/core";
import { HOSTED_TERMS, type TermsCopy, consentPage, messagePage, securityHeaders } from "./pages.js";
import { type AgentTokenProps, SESSION_COOKIE } from "./rpc.js";
import type { GateRpc } from "../../gate/src/rpc.js";

export interface FlowEnv {
  DB: D1Database;
  GATE: Pick<GateRpc, "consentExample">;
  ISSUER: string; // origin of the sign-in pages, e.g. https://auth.askwearables.app
  RP_ID: string; // WebAuthn relying party id
  COOKIE_DOMAIN: string; // empty for a host-only cookie
  OWNER_SETUP_TOKEN: string;
  /** Legal copy on the setup and consent pages; HOSTED_TERMS when absent. */
  TERMS?: TermsCopy;
}

const SESSION_DAYS = 14;
export const SCOPE = "wearables:ask";

export const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function cookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") ?? "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function nonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function sameOrigin(req: Request, env: Pick<FlowEnv, "ISSUER">): boolean {
  const o = req.headers.get("origin");
  return !o || o === new URL(env.ISSUER).origin;
}

const domainAttr = (env: Pick<FlowEnv, "COOKIE_DOMAIN">) => (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== "localhost" ? `; Domain=${env.COOKIE_DOMAIN}` : "");

export async function sessionFor(env: Pick<FlowEnv, "DB">, value: string | null): Promise<{ userId: string; role: string } | null> {
  if (!value || value.length < 20) return null;
  const row = await env.DB.prepare(`SELECT s.user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL`)
    .bind(await sha256Hex(value), new Date().toISOString()).first<{ user_id: string; role: string }>();
  return row ? { userId: row.user_id, role: row.role } : null;
}

async function newSession(env: FlowEnv, userId: string): Promise<string> {
  const value = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const exp = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(await sha256Hex(value), userId, new Date().toISOString(), exp.toISOString()).run();
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${domainAttr(env)}`;
}

export async function logout(req: Request, env: FlowEnv): Promise<Response> {
  const v = cookie(req, SESSION_COOKIE);
  if (v) await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sha256Hex(v)).run();
  return new Response(null, { status: 303, headers: { location: `${env.ISSUER}/login`, "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0${domainAttr(env)}` } });
}

// ---------- passkeys ----------

async function saveChallenge(env: FlowEnv, challenge: string, userId: string | null): Promise<string> {
  const id = newId("ch");
  await env.DB.prepare(`INSERT INTO webauthn_challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)`).bind(id, challenge, userId, new Date(Date.now() + 300_000).toISOString()).run();
  return id;
}
async function takeChallenge(env: FlowEnv, id: string | null): Promise<{ challenge: string; user_id: string | null } | null> {
  if (!id) return null;
  const row = await env.DB.prepare(`SELECT challenge, user_id FROM webauthn_challenges WHERE id = ? AND expires_at > ?`).bind(id, new Date().toISOString()).first<{ challenge: string; user_id: string | null }>();
  await env.DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(id).run();
  return row;
}
const challengeCookie = (id: string) => `__Host-aw_ch=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`;

export async function setupAllowed(env: Pick<FlowEnv, "DB" | "OWNER_SETUP_TOKEN">, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !env.OWNER_SETUP_TOKEN || token.length !== env.OWNER_SETUP_TOKEN.length) return false;
  let d = 0;
  for (let i = 0; i < token.length; i++) d |= token.charCodeAt(i) ^ env.OWNER_SETUP_TOKEN.charCodeAt(i);
  if (d !== 0) return false;
  const owner = await env.DB.prepare(`SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL`).first();
  return !owner; // setup works once: only while no owner exists
}

export async function registerOptions(req: Request, env: FlowEnv): Promise<Response> {
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

export async function registerVerify(req: Request, env: FlowEnv): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { setup?: string; response?: unknown; accepted?: boolean };
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
  if (isSetup && body.accepted !== true) return json({ ok: false, error: "Accept the Terms and Privacy Policy to continue" }, 400);
  // Clickwrap record: the accepted terms version, the time, and the 18+ confirmation.
  if (isSetup) await env.DB.prepare(`INSERT INTO users (id, tz, role, created_at, terms_version, terms_accepted_at, age_confirmed) VALUES (?, 'UTC', 'owner', ?, ?, ?, 1)`).bind(ch.user_id, now, (env.TERMS ?? HOSTED_TERMS).version, now).run();
  await env.DB.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(c.id, ch.user_id, b64url(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), now).run();
  const headers = new Headers({ "content-type": "application/json" });
  if (isSetup) headers.append("set-cookie", await newSession(env, ch.user_id));
  return new Response(JSON.stringify({ ok: true }), { headers });
}

export async function authOptions(env: FlowEnv): Promise<Response> {
  const opts = await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: "required" });
  const id = await saveChallenge(env, opts.challenge, null);
  return json(opts, 200, { "set-cookie": challengeCookie(id) });
}

export async function authVerify(req: Request, env: FlowEnv): Promise<Response> {
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

export function readGrantForm(form: FormData): GrantForm {
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

export async function userToday(env: Pick<FlowEnv, "DB">, userId: string): Promise<string> {
  const tz = (await env.DB.prepare(`SELECT tz FROM users WHERE id = ?`).bind(userId).first<{ tz: string }>())?.tz ?? "UTC";
  return todayIn(tz, new Date());
}

async function upsertAgent(env: FlowEnv, agentId: string, name: string, registeredBy: string, domain: string | null) {
  await env.DB.prepare(`INSERT INTO agents (agent_id, name, registered_by, verified_domain, model_facing, created_at) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name, verified_domain = excluded.verified_domain`).bind(agentId, name.slice(0, 120), registeredBy, domain, new Date().toISOString()).run();
}

export async function insertGrant(env: Pick<FlowEnv, "DB">, g: Grant) {
  await env.DB.prepare(`INSERT INTO grants (grant_id, user_id, agent_id, purpose, metrics, sensitive, max_level, max_window_days, daily_packet_budget, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(g.grant_id, g.user_id, g.agent_id, g.purpose, JSON.stringify(g.metrics), JSON.stringify(g.sensitive ?? []), g.max_level, g.max_window_days, g.daily_packet_budget, g.expires_at, new Date().toISOString()).run();
}

/** GET shows the eight-item consent screen; POST records the grant and completes the OAuth authorization. */
export async function authorize(req: Request, env: FlowEnv, oauth: OAuthHelpers): Promise<Response> {
  const session = await sessionFor(env, cookie(req, SESSION_COOKIE));
  const url = new URL(req.url);
  if (req.method === "GET") {
    let authReq: AuthRequest;
    try { authReq = await oauth.parseAuthRequest(req); } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      return html(messagePage("Cannot connect", e instanceof Error ? e.message : "Invalid request"), 400);
    }
    if (!session) return Response.redirect(`${env.ISSUER}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    const d = await oauth.describeConsent(authReq);
    const consent = await oauth.beginConsent(authReq);
    const n = nonce();
    const page = consentPage({
      agentName: d.clientName, agentDomain: d.clientDomain ?? null, registeredBy: d.clientDomain ? `the owner of ${d.clientDomain}` : "itself (dynamic registration)",
      redirectHost: d.redirectHost, redirectIsLoopback: d.redirectIsLoopback, handle: consent.handle, postTo: "/authorize", exampleUrl: "/consent-example", today: await userToday(env, session.userId),
      ...(env.TERMS ? { terms: env.TERMS } : {}),
    }, n);
    const headers = new Headers(consent.headers);
    for (const [k, v] of Object.entries(securityHeaders(n))) headers.set(k, v);
    return new Response(page, { headers });
  }
  if (req.method !== "POST" || !sameOrigin(req, env)) return new Response("Method not allowed", { status: 405 });
  if (!session) return html(messagePage("Signed out", "Sign in and start again."), 401);
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
  if (errs.length) return html(messagePage("Check the form", `Some choices were not valid: ${errs.join(", ")}. Go back and try again.`), 400);
  await upsertAgent(env, grant.agent_id, d.clientName, d.clientDomain ? "cimd" : "dcr", d.clientDomain ?? null);
  await insertGrant(env, grant);
  const props: AgentTokenProps = { userId: session.userId, agentId: grant.agent_id, grantId: grant.grant_id };
  const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: session.userId, metadata: { grant_id: grant.grant_id }, scope: approved.request.scope, props });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

/** Revoke OAuth grants (and their tokens) for one agent, or all agents when clientId is null. */
export async function revokeAgentTokens(oauth: OAuthHelpers, userId: string, clientId: string | null): Promise<number> {
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
