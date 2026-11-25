// The release path inside the user's Durable Object: re-check the budget atomically, compute, build the
// packet at the decided level, count it, and write the receipt. Also a local composition for tests.
import { compute } from "./compute.js";
import { decide, type GateInput } from "./gate.js";
import { canonicalJson } from "./hash.js";
import { buildPacket, packetHash } from "./packet.js";
import { appendReceipt, countRelease, releasedToday, type Cipher } from "./receipts.js";
import type { Sql } from "./sql.js";
import { getMeta, listSources } from "./store.js";
import type { AskResponse, GateDecision, Grant, MetricId, QuerySpec } from "./types.js";

export interface ReleaseInput {
  decision: GateDecision;
  grant: Grant | null;
  agent_id: string;
  today: string;
  now: Date;
}

/** Facts the gate needs from the store before deciding. No health values. */
export function gateFacts(sql: Sql, agentId: string, today: string) {
  const sources = listSources(sql).map((s) => ({
    id: s.id,
    provider: s.provider,
    terms_flags: s.terms_flags,
    metrics: sql.all<{ metric: string }>(`SELECT DISTINCT metric FROM daily_rollups WHERE source_id = ?`, s.id).map((r) => r.metric as MetricId),
  }));
  return { sources, releasedToday: releasedToday(sql, agentId, today), paused: getMeta(sql, "paused") === "1" };
}

export function recordDenial(sql: Sql, cipher: Cipher, input: ReleaseInput, decision: "denied" | "unsupported" = "denied"): Promise<AskResponse> {
  return serialized(sql, () => recordDenialUnlocked(sql, cipher, input, decision));
}

async function recordDenialUnlocked(sql: Sql, cipher: Cipher, input: ReleaseInput, decision: "denied" | "unsupported" = "denied"): Promise<AskResponse> {
  const d = input.decision;
  const r = await appendReceipt(sql, {
    time: input.now.toISOString(), agent_id: input.agent_id, grant_id: input.grant?.grant_id ?? null, purpose: input.grant?.purpose ?? null,
    decision, level: null, metrics: d.spec?.metrics ?? [], window: d.spec?.window ?? null, spec: d.spec ?? null, packet_hash: null, reasons: d.reasons,
  }, cipher);
  return { status: decision === "unsupported" ? "unsupported" : "denied", receipt_id: r.receipt_id, reasons: d.reasons };
}

// One release at a time per store. Inside a Durable Object, awaiting WebCrypto is not storage I/O, so another
// request can interleave between reading the receipt chain head (or the budget counter) and writing it.
const locks = new WeakMap<Sql, Promise<unknown>>();
export function serialized<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sql) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(sql, next.catch(() => undefined));
  return next;
}

export function release(sql: Sql, cipher: Cipher, input: ReleaseInput): Promise<AskResponse> {
  return serialized(sql, () => releaseUnlocked(sql, cipher, input));
}

async function releaseUnlocked(sql: Sql, cipher: Cipher, input: ReleaseInput): Promise<AskResponse> {
  const d = input.decision;
  if (!d.allow) return recordDenialUnlocked(sql, cipher, input);
  // Budget re-checked here, inside the serialized Durable Object, so concurrent requests cannot overspend.
  if (input.grant && releasedToday(sql, input.agent_id, input.today) >= input.grant.daily_packet_budget) {
    return recordDenialUnlocked(sql, cipher, { ...input, decision: { ...d, allow: false, reasons: [...d.reasons, "budget_exhausted"] } });
  }
  if (getMeta(sql, "paused") === "1") return recordDenialUnlocked(sql, cipher, { ...input, decision: { ...d, allow: false, reasons: ["paused"] } });
  const result = compute({ sql, spec: d.spec, now: input.now, excludedSources: d.excluded_sources, includeRaw: d.level === 3 });
  const packet = await buildPacket(result, d.level);
  const hash = await packetHash(packet);
  countRelease(sql, input.agent_id, input.today);
  // Keep the released packet for 24 hours so the same agent can fetch it again with get_packet.
  sql.run(`DELETE FROM packets WHERE created_at < ?`, new Date(input.now.getTime() - 86_400_000).toISOString());
  sql.run(`INSERT OR REPLACE INTO packets (packet_id, agent_id, created_at, packet_enc) VALUES (?, ?, ?, ?)`,
    packet.packet_id, input.agent_id, input.now.toISOString(), await cipher.encrypt(canonicalJson(packet)));
  const r = await appendReceipt(sql, {
    time: input.now.toISOString(), agent_id: input.agent_id, grant_id: input.grant?.grant_id ?? null, purpose: input.grant?.purpose ?? null,
    decision: "released", level: d.level, metrics: d.spec.metrics, window: d.spec.window, spec: d.spec, packet_hash: hash, reasons: d.reasons,
  }, cipher);
  return { status: "ok", packet, receipt_id: r.receipt_id, reasons: d.reasons };
}

/** Gate + release in one process. Used by tests and by self-hosted single-process mode. */
export async function answerSpec(
  sql: Sql,
  cipher: Cipher,
  args: Omit<GateInput, "sources" | "releasedToday" | "paused" | "spec"> & { spec: QuerySpec },
): Promise<AskResponse> {
  const agentId = args.agent?.agent_id ?? args.token.agent_id ?? "unknown";
  const facts = gateFacts(sql, agentId, args.today);
  const decision = decide({ ...args, ...facts });
  return release(sql, cipher, { decision, grant: args.grant, agent_id: agentId, today: args.today, now: args.now });
}

/** A packet this agent already received, within 24 hours. Not metered: nothing new is released. */
export async function getStoredPacket(sql: Sql, cipher: Cipher, agentId: string, packetId: string): Promise<unknown | null> {
  const row = sql.all<{ packet_enc: string }>(`SELECT packet_enc FROM packets WHERE packet_id = ? AND agent_id = ?`, packetId, agentId)[0];
  return row ? JSON.parse(await cipher.decrypt(row.packet_enc)) : null;
}
