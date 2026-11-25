// Receipts: an append-only, hash-chained record of every release and denial, per user.
// Payloads are encrypted with the user's data key; deleting the key erases them but keeps the chain.
import { canonicalJson, newId, sha256Hex } from "./hash.js";
import type { Sql } from "./sql.js";
import type { DateWindow, Level, MetricId, QuerySpec, Receipt } from "./types.js";

export const GENESIS = "sha256:genesis";

export interface ReceiptInput {
  time: string;
  agent_id: string;
  grant_id: string | null;
  purpose: string | null;
  decision: Receipt["decision"];
  level: Level | null;
  metrics: MetricId[];
  window: DateWindow | null;
  spec: QuerySpec | null;
  packet_hash: string | null;
  reasons: string[];
}

export interface Cipher {
  encrypt(plain: string): Promise<string>;
  decrypt(enc: string): Promise<string>;
}

interface Row {
  seq: number; receipt_id: string; time: string; agent_id: string; grant_id: string | null; decision: string;
  level: number | null; packet_hash: string | null; payload_hash: string; payload_enc: string | null; prev_hash: string; hash: string;
}

function chainHash(prev: string, r: Omit<Row, "hash" | "payload_enc" | "prev_hash">): Promise<string> {
  return sha256Hex(canonicalJson([prev, r.seq, r.receipt_id, r.time, r.agent_id, r.grant_id, r.decision, r.level, r.packet_hash, r.payload_hash])).then((h) => `sha256:${h}`);
}

export async function appendReceipt(sql: Sql, input: ReceiptInput, cipher: Cipher): Promise<Receipt> {
  const payload = { purpose: input.purpose, metrics: input.metrics, window: input.window, spec: input.spec, reasons: input.reasons };
  const payloadJson = canonicalJson(payload);
  const payload_hash = `sha256:${await sha256Hex(payloadJson)}`;
  const payload_enc = await cipher.encrypt(payloadJson);
  const receipt_id = newId("rc");
  // Single-threaded inside a Durable Object, so read-then-write of the chain head is safe.
  const head = sql.all<{ seq: number; hash: string }>(`SELECT seq, hash FROM receipts ORDER BY seq DESC LIMIT 1`)[0];
  const seq = (head?.seq ?? 0) + 1;
  const prev_hash = head?.hash ?? GENESIS;
  const core = { seq, receipt_id, time: input.time, agent_id: input.agent_id, grant_id: input.grant_id, decision: input.decision, level: input.level, packet_hash: input.packet_hash, payload_hash };
  const hash = await chainHash(prev_hash, core);
  sql.run(
    `INSERT INTO receipts (seq, receipt_id, time, agent_id, grant_id, decision, level, packet_hash, payload_hash, payload_enc, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seq, receipt_id, input.time, input.agent_id, input.grant_id, input.decision, input.level, input.packet_hash, payload_hash, payload_enc, prev_hash, hash);
  return { ...input, receipt_id, seq, prev_hash, hash };
}

/** Newest first. Payloads that were crypto-erased come back with empty metrics and reasons ["erased"]. */
export async function listReceipts(sql: Sql, cipher: Cipher, limit = 100, beforeSeq?: number): Promise<Receipt[]> {
  const rows = beforeSeq
    ? sql.all<Row>(`SELECT * FROM receipts WHERE seq < ? ORDER BY seq DESC LIMIT ?`, beforeSeq, limit)
    : sql.all<Row>(`SELECT * FROM receipts ORDER BY seq DESC LIMIT ?`, limit);
  const out: Receipt[] = [];
  for (const r of rows) {
    let p: { purpose: string | null; metrics: MetricId[]; window: DateWindow | null; spec: QuerySpec | null; reasons: string[] } = { purpose: null, metrics: [], window: null, spec: null, reasons: ["erased"] };
    if (r.payload_enc) {
      try { p = JSON.parse(await cipher.decrypt(r.payload_enc)); } catch { p.reasons = ["undecryptable"]; }
    }
    out.push({
      receipt_id: r.receipt_id, seq: r.seq, time: r.time, agent_id: r.agent_id, grant_id: r.grant_id, purpose: p.purpose,
      decision: r.decision as Receipt["decision"], level: r.level as Level | null, metrics: p.metrics, window: p.window, spec: p.spec,
      packet_hash: r.packet_hash, reasons: p.reasons, prev_hash: r.prev_hash, hash: r.hash,
    });
  }
  return out;
}

/** Verify the whole chain. Returns the first broken seq, or null if intact. */
export async function verifyChain(sql: Sql): Promise<{ ok: boolean; broken_at: number | null; head: string; count: number }> {
  const rows = sql.all<Row>(`SELECT * FROM receipts ORDER BY seq ASC`);
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, broken_at: r.seq, head: prev, count: rows.length };
    const h = await chainHash(prev, r);
    if (h !== r.hash) return { ok: false, broken_at: r.seq, head: prev, count: rows.length };
    prev = r.hash;
  }
  return { ok: true, broken_at: null, head: prev, count: rows.length };
}

export function chainHead(sql: Sql): { seq: number; hash: string } {
  return sql.all<{ seq: number; hash: string }>(`SELECT seq, hash FROM receipts ORDER BY seq DESC LIMIT 1`)[0] ?? { seq: 0, hash: GENESIS };
}

// ---------- counters (budgets) ----------

export function releasedToday(sql: Sql, agentId: string, today: string): number {
  return sql.all<{ n: number }>(`SELECT n FROM counters WHERE k = ?`, `released:${agentId}:${today}`)[0]?.n ?? 0;
}

export function countRelease(sql: Sql, agentId: string, today: string): number {
  const k = `released:${agentId}:${today}`;
  sql.run(`INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1`, k);
  return releasedToday(sql, agentId, today);
}
