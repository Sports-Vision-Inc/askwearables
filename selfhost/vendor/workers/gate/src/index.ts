// gate: policy, budgets, receipts. No public route. Edge and console reach it by service binding.
// It re-checks every credential itself (agent token via auth, API keys and sessions via D1/auth),
// decides with the pure gate in @askwearables/core, and asks vault to release or record a denial.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type Agent,
  type AskResponse,
  type CanonicalRecord,
  type GateDecision,
  type Grant,
  type Level,
  type MetricId,
  type Packet,
  type Purpose,
  type QuerySpec,
  type Source,
  CATALOGUE,
  MIN_LEVEL,
  OPERATIONS,
  PUBLIC_METRIC_IDS,
  SUPPORTED_HELP,
  canonicalJson,
  decide,
  newId,
  sha256Hex,
  todayIn,
  validateGrant,
  validateQuerySpec,
} from "@askwearables/core";
import type { VaultRpc } from "../../vault/src/rpc.js";
import type { AuthRpc } from "../../auth/src/rpc.js";

export interface Env {
  DB: D1Database;
  VAULT: Fetcher & VaultRpc;
  AUTH: Fetcher & AuthRpc;
  GATE_SECRET: string; // encrypts developer signing secrets and org webhook secrets
}

import type { AgentAuth, GateRpc, SignedRequest } from "./rpc.js";
export type { AgentAuth };

interface Identity { userId: string; agentId: string; grantId: string | null; orgId: string | null }

class GateError extends Error {
  constructor(public code: string) { super(code); }
}

const SIGNATURE_WINDOW_S = 300;
const MAX_INGEST_RECORDS = 2000;

interface GrantRow { grant_id: string; user_id: string; agent_id: string; purpose: string; metrics: string; sensitive: string; max_level: number; max_window_days: number; daily_packet_budget: number; expires_at: string; revoked_at: string | null; created_at: string }

export function rowToGrant(r: GrantRow): Grant {
  return {
    grant_id: r.grant_id, user_id: r.user_id, agent_id: r.agent_id, purpose: r.purpose as Purpose, metrics: JSON.parse(r.metrics), sensitive: JSON.parse(r.sensitive),
    max_level: r.max_level as Level, max_window_days: r.max_window_days, daily_packet_budget: r.daily_packet_budget, expires_at: r.expires_at, revoked_at: r.revoked_at, created_at: r.created_at,
  };
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function secretBox(keyB64: string) {
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return {
    async seal(s: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(s)));
      return `${b64(iv)}.${b64(ct)}`;
    },
    async open(e: string) {
      const [iv, ct] = e.split(".");
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(iv!), (c) => c.charCodeAt(0)) }, key, Uint8Array.from(atob(ct!), (c) => c.charCodeAt(0)));
      return new TextDecoder().decode(pt);
    },
  };
}

export default class Gate extends WorkerEntrypoint<Env> implements GateRpc {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }

  // ---------- identity ----------

  private async identify(auth: AgentAuth, opts: { consumeNonce?: boolean } = {}): Promise<Identity> {
    if (auth.kind === "oauth") {
      // Checked again here: edge validated it too, but gate never trusts edge's word.
      const t = await this.env.AUTH.validateToken(auth.resource, auth.token);
      if (!t) throw new GateError("token_invalid");
      const p = t.props as { userId?: string; agentId?: string; grantId?: string };
      if (!p.userId || !p.agentId || !p.grantId || p.userId !== t.userId || p.agentId !== t.clientId) throw new GateError("token_invalid");
      return { userId: p.userId, agentId: p.agentId, grantId: p.grantId, orgId: null };
    }
    const key = await this.apiKey(auth.key, "developer");
    // The nonce is consumed once per request, by the call that releases or denies (ask, getPacket).
    if (opts.consumeNonce === false) { /* tz lookup only: no nonce consumed */ }
    else if (auth.signed) await this.verifySignature(key, auth.signed);
    else if (key.signing_secret_enc) throw new GateError("signature_required");
    const user = await this.env.DB.prepare(`SELECT id FROM users WHERE org_id = ? AND external_id = ? AND deleted_at IS NULL`).bind(key.org_id, auth.user).first<{ id: string }>();
    if (!user) throw new GateError("unknown_user");
    const g = await this.env.DB.prepare(`SELECT grant_id FROM grants WHERE user_id = ? AND agent_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`).bind(user.id, key.agent_id).first<{ grant_id: string }>();
    return { userId: user.id, agentId: key.agent_id!, grantId: g?.grant_id ?? null, orgId: key.org_id };
  }

  private async apiKey(raw: string, kind: "developer" | "owner" | "sync") {
    const hash = await sha256Hex(raw);
    const k = await this.env.DB.prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND kind = ? AND revoked_at IS NULL`).bind(hash, kind)
      .first<{ kind: string; user_id: string | null; org_id: string | null; agent_id: string | null; signing_secret_enc: string | null; source_id: string | null }>();
    if (!k) throw new GateError("token_invalid");
    return k;
  }

  private async verifySignature(key: { signing_secret_enc: string | null; org_id: string | null }, s: SignedRequest) {
    if (!key.signing_secret_enc) throw new GateError("signature_not_configured");
    const ts = Number(s.timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_S) throw new GateError("signature_expired");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(s.nonce)) throw new GateError("bad_nonce");
    const secret = await (await secretBox(this.env.GATE_SECRET)).open(key.signing_secret_enc);
    const expected = await hmacHex(secret, [s.timestamp, s.nonce, s.method.toUpperCase(), s.path, s.body_sha256].join("\n"));
    if (!timingSafeEqual(expected, s.signature.toLowerCase())) throw new GateError("bad_signature");
    // Single-use nonce: stored with its expiry; a replay within the window fails.
    const ins = await this.env.DB.prepare(`INSERT OR IGNORE INTO nonces (k, expires_at) VALUES (?, ?) RETURNING k`).bind(`${key.org_id}:${s.nonce}`, new Date((ts + SIGNATURE_WINDOW_S) * 1000).toISOString()).first<{ k: string }>();
    if (!ins) throw new GateError("nonce_replayed");
  }

  private async loadGrant(grantId: string | null): Promise<Grant | null> {
    if (!grantId) return null;
    const r = await this.env.DB.prepare(`SELECT * FROM grants WHERE grant_id = ?`).bind(grantId).first<GrantRow>();
    return r ? rowToGrant(r) : null;
  }
  private async loadAgent(agentId: string): Promise<Agent | null> {
    const r = await this.env.DB.prepare(`SELECT * FROM agents WHERE agent_id = ?`).bind(agentId).first<{ agent_id: string; name: string; registered_by: string; verified_domain: string | null; model_facing: number }>();
    return r ? { agent_id: r.agent_id, name: r.name, registered_by: r.registered_by, verified_domain: r.verified_domain, model_facing: r.model_facing === 1 } : null;
  }
  private async userTz(userId: string): Promise<string> {
    return (await this.env.DB.prepare(`SELECT tz FROM users WHERE id = ?`).bind(userId).first<{ tz: string }>())?.tz ?? "UTC";
  }

  private async meter(orgId: string | null, field: "calls" | "packets" | "denials") {
    if (!orgId) return;
    const day = new Date().toISOString().slice(0, 10);
    await this.env.DB.prepare(`INSERT INTO usage (org_id, day, ${field}) VALUES (?, ?, 1) ON CONFLICT(org_id, day) DO UPDATE SET ${field} = ${field} + 1`).bind(orgId, day).run();
  }

  // ---------- agent path ----------

  /** The user's time zone, so edge can pass it to the planner. No other user data. */
  async tzFor(auth: AgentAuth): Promise<string> {
    try { return await this.userTz((await this.identify(auth, { consumeNonce: false })).userId); } catch { return "UTC"; }
  }

  /** Answer a planned spec. `planned` is untrusted: it is validated here again. */
  async ask(auth: AgentAuth, planned: { spec?: unknown; unsupported?: string }, purposeClaim?: string): Promise<AskResponse> {
    let id: Identity;
    try { id = await this.identify(auth); } catch (e) { return { status: "denied", reasons: [e instanceof GateError ? e.code : "token_invalid"] }; }
    await this.meter(id.orgId, "calls");
    const now = new Date();
    const grant = await this.loadGrant(id.grantId);
    const agent = await this.loadAgent(id.agentId);
    const today = todayIn(await this.userTz(id.userId), now);
    const base = { grant, agent_id: id.agentId, today, now: now.toISOString() };

    if (planned.unsupported !== undefined || planned.spec === undefined) {
      const d: GateDecision = { allow: false, level: 0, spec: null as unknown as QuerySpec, denied_metrics: [], excluded_sources: [], reasons: [`unsupported:${planned.unsupported ?? "no_spec"}`] };
      const r = await this.env.VAULT.deny(id.userId, { ...base, decision: d }, "unsupported");
      return { ...r, status: "unsupported", supported: SUPPORTED_HELP };
    }
    const v = validateQuerySpec(planned.spec);
    if (!v.ok) {
      const d: GateDecision = { allow: false, level: 0, spec: null as unknown as QuerySpec, denied_metrics: [], excluded_sources: [], reasons: ["invalid_spec", ...v.errors.slice(0, 5)] };
      await this.meter(id.orgId, "denials");
      return this.env.VAULT.deny(id.userId, { ...base, decision: d });
    }
    const facts = await this.env.VAULT.facts(id.userId, id.agentId, today);
    const decision = decide({
      token: { valid: true, agent_id: id.agentId, user_id: id.userId, grant_id: id.grantId ?? undefined },
      grant, agent, spec: v.spec, now, today, ...facts,
    });
    // The purpose comes from the grant. A purpose restated in the request is recorded, never used.
    if (purposeClaim && grant && purposeClaim !== grant.purpose) decision.reasons.push("purpose_claim_ignored");
    if (!decision.allow) {
      await this.meter(id.orgId, "denials");
      return this.env.VAULT.deny(id.userId, { ...base, decision });
    }
    const res = await this.env.VAULT.release(id.userId, { ...base, decision });
    await this.meter(id.orgId, res.status === "ok" ? "packets" : "denials");
    return res;
  }

  async getPacket(auth: AgentAuth, packetId: string): Promise<Packet | null> {
    const id = await this.identify(auth);
    if (!/^pk_[0-9a-f]{24}$/.test(packetId)) return null;
    return this.env.VAULT.getPacket(id.userId, id.agentId, packetId);
  }

  async capabilities(auth: AgentAuth) {
    let grant: Grant | null = null;
    try { grant = await this.loadGrant((await this.identify(auth)).grantId); } catch { /* unauthenticated: catalogue only */ }
    return {
      operations: OPERATIONS.map((op) => ({ operation: op, lowest_level: MIN_LEVEL[op] })),
      metrics: PUBLIC_METRIC_IDS.map((m) => ({ id: m, label: CATALOGUE[m].label, unit: CATALOGUE[m].unit, granted: grant ? grant.metrics.includes(m) : null })),
      levels: [{ level: 0, name: "flag" }, { level: 1, name: "trend" }, { level: 2, name: "daily" }, { level: 3, name: "raw" }],
      grant: grant && !grant.revoked_at ? { purpose: grant.purpose, max_level: grant.max_level, max_window_days: grant.max_window_days, daily_packet_budget: grant.daily_packet_budget, expires_at: grant.expires_at } : null,
      examples: SUPPORTED_HELP,
    };
  }

  // ---------- owner path (console session or owner API key) ----------

  private async owner(cred: { session?: string; key?: string }): Promise<string> {
    if (cred.session) {
      const u = await this.env.AUTH.sessionUser(cred.session);
      if (u) return u.userId;
    }
    if (cred.key) return (await this.apiKey(cred.key, "owner")).user_id!;
    throw new GateError("unauthenticated");
  }

  async ownerQuery(cred: { session?: string; key?: string }, spec: unknown) {
    const userId = await this.owner(cred);
    const v = validateQuerySpec(spec);
    if (!v.ok) return { status: "invalid", errors: v.errors };
    return { status: "ok", ...(await this.env.VAULT.ownerQuery(userId, v.spec, new Date().toISOString())) };
  }

  async ownerStatus(cred: { session?: string; key?: string }) {
    const userId = await this.owner(cred);
    const user = await this.env.DB.prepare(`SELECT id, email, display_name, tz, role FROM users WHERE id = ?`).bind(userId).first();
    const grants = (await this.env.DB.prepare(`SELECT g.*, a.name AS agent_name, a.verified_domain FROM grants g JOIN agents a ON a.agent_id = g.agent_id WHERE g.user_id = ? ORDER BY g.created_at DESC`).bind(userId).all<GrantRow & { agent_name: string; verified_domain: string | null }>()).results
      .map((r) => ({ ...rowToGrant(r), agent_name: r.agent_name, verified_domain: r.verified_domain }));
    return { user, grants, vault: await this.env.VAULT.status(userId) };
  }

  async ownerReceipts(cred: { session?: string; key?: string }, limit = 100, beforeSeq?: number) {
    const userId = await this.owner(cred);
    return { receipts: await this.env.VAULT.receipts(userId, Math.min(limit, 1000), beforeSeq), chain: await this.env.VAULT.verify(userId) };
  }

  async ownerSetPaused(cred: { session?: string; key?: string }, paused: boolean) {
    await this.env.VAULT.setPaused(await this.owner(cred), paused);
    return { paused };
  }

  async ownerRevokeGrant(cred: { session?: string; key?: string }, grantId: string) {
    const userId = await this.owner(cred);
    const g = await this.env.DB.prepare(`SELECT agent_id FROM grants WHERE grant_id = ? AND user_id = ?`).bind(grantId, userId).first<{ agent_id: string }>();
    if (!g) return { revoked: false };
    await this.env.DB.prepare(`UPDATE grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`).bind(new Date().toISOString(), grantId).run();
    await this.env.AUTH.revokeAgentTokens(userId, g.agent_id);
    await this.notifyOrg(g.agent_id, { type: "grant.revoked", grant_id: grantId });
    return { revoked: true };
  }

  async ownerExport(cred: { session?: string; key?: string }) {
    return this.env.VAULT.exportAll(await this.owner(cred));
  }

  async ownerDeleteEverything(cred: { session?: string; key?: string }, confirm: string) {
    const userId = await this.owner(cred);
    if (confirm !== "delete everything") return { deleted: false, reason: "confirmation_text_mismatch" };
    const now = new Date().toISOString();
    await this.env.DB.prepare(`UPDATE grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now, userId).run();
    await this.env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now, userId).run();
    await this.env.AUTH.revokeAgentTokens(userId, null);
    return { deleted: true, ...(await this.env.VAULT.deleteEverything(userId)) };
  }

  async ownerSetTz(cred: { session?: string; key?: string }, tz: string) {
    const userId = await this.owner(cred);
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return { ok: false }; }
    await this.env.DB.prepare(`UPDATE users SET tz = ? WHERE id = ?`).bind(tz, userId).run();
    return { ok: true };
  }

  /** Create an owner API key or a device sync key. The key is returned once and stored only as a hash. */
  async ownerCreateKey(cred: { session?: string; key?: string }, kind: "owner" | "sync", source?: Source) {
    const userId = await this.owner(cred);
    const raw = `${kind === "owner" ? "aw_own" : "aw_sync"}_${newId("k").slice(2)}${crypto.randomUUID().replace(/-/g, "")}`;
    let sourceId: string | null = null;
    if (kind === "sync") {
      if (!source) throw new GateError("source_required");
      sourceId = `${source.provider}:${crypto.randomUUID().slice(0, 8)}`;
      await this.env.VAULT.registerSource(userId, { ...source, id: sourceId, connected_at: new Date().toISOString(), last_sync_at: null, terms_flags: source.terms_flags ?? {} });
    }
    await this.env.DB.prepare(`INSERT INTO api_keys (key_hash, prefix, kind, user_id, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(raw), raw.slice(0, 12), kind, userId, sourceId, new Date().toISOString()).run();
    return { key: raw, source_id: sourceId };
  }

  /** File import from the console: the browser parses the export and uploads normalized batches. */
  async ownerIngest(cred: { session?: string; key?: string }, source: Source, records: CanonicalRecord[]) {
    const userId = await this.owner(cred);
    if (!Array.isArray(records) || records.length > MAX_INGEST_RECORDS) throw new GateError("batch_too_large");
    await this.env.VAULT.registerSource(userId, { ...source, terms_flags: source.terms_flags ?? {} });
    for (const r of records) if (r.source_id !== source.id) throw new GateError("source_mismatch");
    return this.env.VAULT.ingest(userId, records, new Date().toISOString());
  }

  /** Device sync: a sync key may write only to its own source. */
  async syncIngest(key: string, records: CanonicalRecord[]) {
    const k = await this.apiKey(key, "sync");
    if (!Array.isArray(records) || records.length > MAX_INGEST_RECORDS) throw new GateError("batch_too_large");
    for (const r of records) (r as { source_id: string }).source_id = k.source_id!;
    return this.env.VAULT.ingest(k.user_id!, records, new Date().toISOString());
  }

  /** The consent screen's live example, built from the owner's own recent data. Owner only. */
  async consentExample(userId: string, metric: MetricId, level: 0 | 1 | 2): Promise<string> {
    if (!(metric in CATALOGUE)) return "";
    const tz = await this.userTz(userId);
    const today = todayIn(tz, new Date());
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
    const spec: QuerySpec = level === 0
      ? { metrics: [metric], operation: "compare_to_baseline", window: { start, end: today }, granularity: "day", params: {} }
      : level === 1 ? { metrics: [metric], operation: "compare_to_baseline", window: { start, end: today }, granularity: "day", params: {} }
      : { metrics: [metric], operation: "aggregate", window: { start, end: today }, granularity: "day", params: {} };
    try {
      const p = await this.env.VAULT.previewPacket(userId, spec, level, new Date().toISOString());
      return p.findings[0]?.statement ?? "";
    } catch { return ""; }
  }

  // ---------- developer platform ----------

  async devCreateUser(key: string, externalId: string, tz = "UTC") {
    const k = await this.apiKey(key, "developer");
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(externalId)) throw new GateError("bad_external_id");
    const existing = await this.env.DB.prepare(`SELECT id FROM users WHERE org_id = ? AND external_id = ?`).bind(k.org_id, externalId).first<{ id: string }>();
    if (existing) return { user: externalId, created: false };
    await this.env.DB.prepare(`INSERT INTO users (id, org_id, external_id, tz, role, created_at) VALUES (?, ?, ?, ?, 'user', ?)`)
      .bind(`u_${k.org_id}_${crypto.randomUUID().slice(0, 12)}`, k.org_id, externalId, tz, new Date().toISOString()).run();
    return { user: externalId, created: true };
  }

  async devIngest(key: string, externalId: string, source: Source, records: CanonicalRecord[]) {
    const k = await this.apiKey(key, "developer");
    const u = await this.env.DB.prepare(`SELECT id FROM users WHERE org_id = ? AND external_id = ?`).bind(k.org_id, externalId).first<{ id: string }>();
    if (!u) throw new GateError("unknown_user");
    if (!Array.isArray(records) || records.length > MAX_INGEST_RECORDS) throw new GateError("batch_too_large");
    await this.env.VAULT.registerSource(u.id, { ...source, terms_flags: source.terms_flags ?? {} });
    for (const r of records) if (r.source_id !== source.id) throw new GateError("source_mismatch");
    return this.env.VAULT.ingest(u.id, records, new Date().toISOString());
  }

  /** A one-time link to the hosted consent screen. The end user approves there; nothing is pre-approved. */
  async devConsentLink(key: string, externalId: string, req: { purpose: Purpose; metrics: MetricId[]; max_level: Level; max_window_days: number; daily_packet_budget: number; days: number; return_url?: string }) {
    const k = await this.apiKey(key, "developer");
    const u = await this.env.DB.prepare(`SELECT id FROM users WHERE org_id = ? AND external_id = ?`).bind(k.org_id, externalId).first<{ id: string }>();
    if (!u) throw new GateError("unknown_user");
    const probe: Grant = { grant_id: "probe", user_id: u.id, agent_id: k.agent_id!, purpose: req.purpose, metrics: req.metrics, sensitive: [], max_level: req.max_level, max_window_days: req.max_window_days, daily_packet_budget: req.daily_packet_budget, expires_at: new Date(Date.now() + Math.min(90, req.days) * 86_400_000).toISOString() };
    const errs = validateGrant(probe, new Date());
    if (errs.length) return { error: "invalid_request", details: errs };
    const token = `cl_${crypto.randomUUID().replace(/-/g, "")}`;
    await this.env.DB.prepare(`INSERT INTO consent_links (token_hash, org_id, user_id, agent_id, request, return_url, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), k.org_id, u.id, k.agent_id, canonicalJson(req), req.return_url ?? null, new Date(Date.now() + 3600_000).toISOString()).run();
    return { url: `https://auth.askwearables.app/consent/${token}`, expires_in: 3600 };
  }

  async devUsage(key: string) {
    const k = await this.apiKey(key, "developer");
    return (await this.env.DB.prepare(`SELECT day, calls, packets, denials FROM usage WHERE org_id = ? ORDER BY day DESC LIMIT 31`).bind(k.org_id).all()).results;
  }

  /** Signed webhook to the developer's server when a grant for one of their agents changes. */
  async notifyOrg(agentId: string, event: Record<string, unknown>) {
    const org = await this.env.DB.prepare(`SELECT o.id, o.webhook_url, o.webhook_secret_enc FROM agents a JOIN orgs o ON o.id = a.org_id WHERE a.agent_id = ?`).bind(agentId).first<{ id: string; webhook_url: string | null; webhook_secret_enc: string | null }>();
    if (!org?.webhook_url || !org.webhook_secret_enc) return;
    const body = JSON.stringify({ ...event, agent_id: agentId, at: new Date().toISOString() });
    const ts = Math.floor(Date.now() / 1000).toString();
    const secret = await (await secretBox(this.env.GATE_SECRET)).open(org.webhook_secret_enc);
    const sig = await hmacHex(secret, `${ts}.${body}`);
    this.ctx.waitUntil(fetch(org.webhook_url, { method: "POST", headers: { "content-type": "application/json", "x-askwearables-timestamp": ts, "x-askwearables-signature": `sha256=${sig}` }, body }).catch(() => undefined));
  }

  /** Owner creates an organization, a developer agent and a developer API key (with signing secret). */
  async ownerCreateDeveloperKey(cred: { session?: string; key?: string }, orgName: string, agentName: string, webhookUrl?: string) {
    const userId = await this.owner(cred);
    const box = await secretBox(this.env.GATE_SECRET);
    let org = await this.env.DB.prepare(`SELECT id FROM orgs WHERE owner_user_id = ? AND name = ?`).bind(userId, orgName).first<{ id: string }>();
    const now = new Date().toISOString();
    let webhookSecret: string | null = null;
    if (!org) {
      org = { id: newId("org") };
      webhookSecret = webhookUrl ? `whsec_${crypto.randomUUID().replace(/-/g, "")}` : null;
      await this.env.DB.prepare(`INSERT INTO orgs (id, name, owner_user_id, webhook_url, webhook_secret_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(org.id, orgName, userId, webhookUrl ?? null, webhookSecret ? await box.seal(webhookSecret) : null, now).run();
    }
    const agentId = newId("ag");
    await this.env.DB.prepare(`INSERT INTO agents (agent_id, name, registered_by, verified_domain, model_facing, org_id, created_at) VALUES (?, ?, ?, NULL, 1, ?, ?)`).bind(agentId, agentName, org.id, org.id, now).run();
    const raw = `aw_dev_${crypto.randomUUID().replace(/-/g, "")}`;
    const signing = `awsig_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    await this.env.DB.prepare(`INSERT INTO api_keys (key_hash, prefix, kind, org_id, agent_id, signing_secret_enc, created_at) VALUES (?, ?, 'developer', ?, ?, ?, ?)`)
      .bind(await sha256Hex(raw), raw.slice(0, 12), org.id, agentId, await box.seal(signing), now).run();
    return { org_id: org.id, agent_id: agentId, api_key: raw, signing_secret: signing, webhook_secret: webhookSecret };
  }

  // ---------- cron: anchor receipt chain heads in R2 ----------
  async scheduled(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const users = (await this.env.DB.prepare(`SELECT id FROM users WHERE deleted_at IS NULL`).all<{ id: string }>()).results;
    for (const u of users) {
      try { await this.env.VAULT.anchor(u.id, day); } catch { /* next run retries */ }
    }
    await this.env.DB.prepare(`DELETE FROM nonces WHERE expires_at < ?`).bind(new Date().toISOString()).run();
  }
}
