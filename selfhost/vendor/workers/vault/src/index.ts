// vault: owns one Durable Object per user (SQLite). Health data, compute, receipts, budgets and
// provider tokens live here. Nothing public calls it: only gate, over a service binding.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  type AskResponse,
  type CanonicalRecord,
  type Cipher,
  type ComputeResult,
  type GateDecision,
  type Grant,
  type Packet,
  type QuerySpec,
  type Source,
  buildPacket,
  chainHead,
  cipherFromWrapped,
  compute,
  deleteAllHealthData,
  doSql,
  gateFacts,
  getDataVersion,
  getMeta,
  getStoredPacket,
  ingest,
  listReceipts,
  listSources,
  masterKey,
  migrate,
  newWrappedDataKey,
  recordDenial,
  release,
  setMeta,
  sha256Hex,
  upsertSource,
  verifyChain,
} from "@askwearables/core";
import type { VaultRpc } from "./rpc.js";

export interface Env {
  USER_VAULT: DurableObjectNamespace<UserVault>;
  ANCHORS: R2Bucket;
  MASTER_KEY: string;
}

export class UserVault extends DurableObject<Env> {
  private sql = doSql(this.ctx.storage);
  private cipherP: Promise<Cipher> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(this.sql));
  }

  private cipher(): Promise<Cipher> {
    if (!this.cipherP) {
      this.cipherP = (async () => {
        const mk = await masterKey(this.env.MASTER_KEY);
        let wrapped = this.sql.all<{ v: string }>(`SELECT v FROM secrets WHERE k = 'data_key'`)[0]?.v;
        if (!wrapped) {
          wrapped = await newWrappedDataKey(mk);
          this.sql.run(`INSERT INTO secrets (k, v) VALUES ('data_key', ?)`, wrapped);
        }
        return cipherFromWrapped(mk, wrapped);
      })();
      this.cipherP.catch(() => (this.cipherP = null));
    }
    return this.cipherP;
  }

  setUser(userId: string): void {
    if (!getMeta(this.sql, "user_id")) setMeta(this.sql, "user_id", userId);
  }
  private userId(): string {
    return getMeta(this.sql, "user_id") ?? "unknown";
  }

  // ----- gate path -----
  facts(agentId: string, today: string) {
    return gateFacts(this.sql, agentId, today);
  }

  async release(input: { decision: GateDecision; grant: Grant | null; agent_id: string; today: string; now: string }): Promise<AskResponse> {
    return release(this.sql, await this.cipher(), { ...input, now: new Date(input.now) });
  }

  async deny(input: { decision: GateDecision; grant: Grant | null; agent_id: string; today: string; now: string }, kind: "denied" | "unsupported" = "denied"): Promise<AskResponse> {
    return recordDenial(this.sql, await this.cipher(), { ...input, now: new Date(input.now) }, kind);
  }

  /** The owner's own view: level 3, still receipted. */
  async ownerQuery(spec: QuerySpec, now: string): Promise<{ packet: Packet; receipt_id: string }> {
    const decision: GateDecision = { allow: true, level: 3, spec, denied_metrics: [], excluded_sources: [], reasons: ["owner", "level:3"] };
    const today = now.slice(0, 10);
    const r = await release(this.sql, await this.cipher(), { decision, grant: null, agent_id: "owner", today, now: new Date(now) });
    return { packet: r.packet!, receipt_id: r.receipt_id! };
  }

  /** Compute without releasing: used only to build the consent screen's live example for the owner. */
  previewCompute(spec: QuerySpec, now: string): ComputeResult {
    return compute({ sql: this.sql, spec, now: new Date(now) });
  }
  async previewPacket(spec: QuerySpec, level: 0 | 1 | 2, now: string): Promise<Packet> {
    return buildPacket(compute({ sql: this.sql, spec, now: new Date(now) }), level);
  }

  async getPacket(agentId: string, packetId: string) {
    return getStoredPacket(this.sql, await this.cipher(), agentId, packetId);
  }

  // ----- ingestion -----
  registerSource(source: Source): void {
    upsertSource(this.sql, this.userId(), source);
  }

  async ingest(records: CanonicalRecord[], syncedAt?: string) {
    if (getMeta(this.sql, "deleted") === "1") throw new Error("user_deleted");
    return ingest(this.sql, this.userId(), records, syncedAt ? { syncedAt } : {});
  }

  status() {
    const sources = listSources(this.sql).map((s) => {
      const r = this.sql.all<{ first: string | null; last: string | null; days: number; cov: number | null }>(
        `SELECT MIN(day) AS first, MAX(day) AS last, COUNT(DISTINCT day) AS days, AVG(coverage) AS cov FROM daily_rollups WHERE source_id = ?`, s.id)[0]!;
      const metrics = this.sql.all<{ metric: string }>(`SELECT DISTINCT metric FROM daily_rollups WHERE source_id = ? ORDER BY metric`, s.id).map((x) => x.metric);
      return { ...s, first_day: r.first, last_day: r.last, days: r.days, mean_coverage: r.cov === null ? null : Math.round(r.cov * 100) / 100, metrics };
    });
    return { sources, data_version: getDataVersion(this.sql), paused: getMeta(this.sql, "paused") === "1", receipts: chainHead(this.sql) };
  }

  // ----- provider tokens: encrypted, never returned to any other Worker -----
  async putProviderTokens(provider: string, tokens: unknown): Promise<void> {
    const enc = await (await this.cipher()).encrypt(JSON.stringify(tokens));
    this.sql.run(`INSERT INTO secrets (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, `token:${provider}`, enc);
  }
  /** Used only inside vault by ingestion. Refresh is serialized because the DO is single-threaded. */
  async withProviderTokens<T>(provider: string, fn: (tokens: unknown) => Promise<{ result: T; tokens?: unknown }>): Promise<T> {
    const row = this.sql.all<{ v: string }>(`SELECT v FROM secrets WHERE k = ?`, `token:${provider}`)[0];
    if (!row) throw new Error("not_connected");
    const c = await this.cipher();
    const out = await fn(JSON.parse(await c.decrypt(row.v)));
    if (out.tokens) await this.putProviderTokens(provider, out.tokens);
    return out.result;
  }

  // ----- user controls -----
  setPaused(paused: boolean): void {
    setMeta(this.sql, "paused", paused ? "1" : "0");
  }

  async receipts(limit = 100, beforeSeq?: number) {
    return listReceipts(this.sql, await this.cipher(), limit, beforeSeq);
  }
  verify() {
    return verifyChain(this.sql);
  }

  async exportAll() {
    const t = (name: string) => this.sql.all(`SELECT * FROM ${name}`);
    return {
      exported_at: new Date().toISOString(),
      data_version: getDataVersion(this.sql),
      sources: listSources(this.sql),
      samples: t("samples"),
      sessions: t("sessions"),
      daily_rollups: t("daily_rollups"),
      baselines: t("baselines"),
      vendor_scores: t("vendor_scores"),
      receipts: await this.receipts(100000),
    };
  }

  /** Delete everything: health data, tokens and the data key. Receipt rows stay; their payloads become unreadable. */
  async deleteEverything(): Promise<{ receipts_kept: number }> {
    deleteAllHealthData(this.sql);
    setMeta(this.sql, "deleted", "1");
    this.cipherP = null;
    return { receipts_kept: chainHead(this.sql).seq };
  }

  /** Write today's receipt chain head to R2 so tampering with the chain is detectable from outside. */
  async anchor(day: string): Promise<{ seq: number; hash: string }> {
    const head = chainHead(this.sql);
    // The anchor names the user only by a hash, so the integrity store holds no user id.
    const userHash = (await sha256Hex(`anchor:${this.userId()}`)).slice(0, 32);
    await this.env.ANCHORS.put(`anchors/${day}/${userHash}.json`, JSON.stringify({ user: userHash, day, ...head, written_at: new Date().toISOString() }));
    return head;
  }
}

/** RPC surface for gate. Every call names the user; the DO for that user is the only one touched. */
export default class VaultService extends WorkerEntrypoint<Env> implements VaultRpc {
  private stub(userId: string) {
    if (!/^[A-Za-z0-9_:.-]{3,128}$/.test(userId)) throw new Error("bad_user_id");
    // Typed as the class itself: the deep generic RPC stub type is too heavy for the checker.
    return this.env.USER_VAULT.get(this.env.USER_VAULT.idFromName(userId)) as unknown as UserVault;
  }
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
  async facts(userId: string, agentId: string, today: string) { return this.stub(userId).facts(agentId, today); }
  async release(userId: string, input: Parameters<UserVault["release"]>[0]) { return this.stub(userId).release(input); }
  async deny(userId: string, input: Parameters<UserVault["deny"]>[0], kind?: "denied" | "unsupported") { return this.stub(userId).deny(input, kind); }
  async ownerQuery(userId: string, spec: QuerySpec, now: string) { return this.stub(userId).ownerQuery(spec, now); }
  async getPacket(userId: string, agentId: string, packetId: string) { return (await this.stub(userId).getPacket(agentId, packetId)) as Packet | null; }
  async previewPacket(userId: string, spec: QuerySpec, level: 0 | 1 | 2, now: string) { return this.stub(userId).previewPacket(spec, level, now); }
  async registerSource(userId: string, source: Source) { const s = this.stub(userId); await s.setUser(userId); return s.registerSource(source); }
  async ingest(userId: string, records: CanonicalRecord[], syncedAt?: string) { const s = this.stub(userId); await s.setUser(userId); return s.ingest(records, syncedAt); }
  async status(userId: string) { return this.stub(userId).status(); }
  async putProviderTokens(userId: string, provider: string, tokens: unknown) { return this.stub(userId).putProviderTokens(provider, tokens); }
  async setPaused(userId: string, paused: boolean) { return this.stub(userId).setPaused(paused); }
  async receipts(userId: string, limit?: number, beforeSeq?: number) { return this.stub(userId).receipts(limit, beforeSeq); }
  async verify(userId: string) { return this.stub(userId).verify(); }
  async exportAll(userId: string): Promise<Record<string, unknown>> { return (await this.stub(userId).exportAll()) as unknown as Record<string, unknown>; }
  async deleteEverything(userId: string) { return this.stub(userId).deleteEverything(); }
  async anchor(userId: string, day: string) { return this.stub(userId).anchor(day); }
}
