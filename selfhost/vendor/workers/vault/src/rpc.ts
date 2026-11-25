// The RPC surface gate sees through its VAULT binding. Explicit, so the binding exposes exactly this.
import type { AskResponse, CanonicalRecord, GateDecision, Grant, IngestResult, MetricId, Packet, QuerySpec, Receipt, Source, TermsFlags } from "@askwearables/core";

export interface ReleaseArgs { decision: GateDecision; grant: Grant | null; agent_id: string; today: string; now: string }

export interface VaultStatus {
  sources: (Source & { enabled: boolean; first_day: string | null; last_day: string | null; days: number; mean_coverage: number | null; metrics: string[] })[];
  data_version: string;
  paused: boolean;
  receipts: { seq: number; hash: string };
}

export interface VaultRpc {
  facts(userId: string, agentId: string, today: string): Promise<{ sources: { id: string; provider: string; terms_flags: TermsFlags; metrics: MetricId[] }[]; releasedToday: number; paused: boolean }>;
  release(userId: string, input: ReleaseArgs): Promise<AskResponse>;
  deny(userId: string, input: ReleaseArgs, kind?: "denied" | "unsupported"): Promise<AskResponse>;
  ownerQuery(userId: string, spec: QuerySpec, now: string): Promise<{ packet: Packet; receipt_id: string }>;
  getPacket(userId: string, agentId: string, packetId: string): Promise<Packet | null>;
  previewPacket(userId: string, spec: QuerySpec, level: 0 | 1 | 2, now: string): Promise<Packet>;
  registerSource(userId: string, source: Source): Promise<void>;
  ingest(userId: string, records: CanonicalRecord[], syncedAt?: string): Promise<IngestResult>;
  status(userId: string): Promise<VaultStatus>;
  putProviderTokens(userId: string, provider: string, tokens: Record<string, string | number | null>): Promise<void>;
  setPaused(userId: string, paused: boolean): Promise<void>;
  receipts(userId: string, limit?: number, beforeSeq?: number): Promise<Receipt[]>;
  verify(userId: string): Promise<{ ok: boolean; broken_at: number | null; head: string; count: number }>;
  exportAll(userId: string): Promise<Record<string, unknown>>;
  deleteEverything(userId: string): Promise<{ receipts_kept: number }>;
  anchor(userId: string, day: string): Promise<{ seq: number; hash: string }>;
}
