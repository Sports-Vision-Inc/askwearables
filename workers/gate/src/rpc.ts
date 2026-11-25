// The RPC surface edge and console see through their GATE binding.
import type { AskResponse, CanonicalRecord, Grant, IngestResult, Level, MetricId, Packet, Purpose, Receipt, Source } from "@askwearables/core";
import type { VaultStatus } from "../../vault/src/rpc.js";

export interface SignedRequest { timestamp: string; nonce: string; signature: string; method: string; path: string; body_sha256: string }
export type AgentAuth =
  | { kind: "oauth"; resource: string; token: string }
  | { kind: "apikey"; key: string; user: string; signed?: SignedRequest };
export type OwnerCred = { session?: string; key?: string };

export interface GateRpc {
  tzFor(auth: AgentAuth): Promise<string>;
  ask(auth: AgentAuth, planned: { spec?: unknown; unsupported?: string }, purposeClaim?: string): Promise<AskResponse>;
  getPacket(auth: AgentAuth, packetId: string): Promise<Packet | null>;
  capabilities(auth: AgentAuth): Promise<Record<string, unknown>>;
  ownerQuery(cred: OwnerCred, spec: unknown): Promise<{ status: string; errors?: string[]; packet?: Packet; receipt_id?: string }>;
  ownerStatus(cred: OwnerCred): Promise<{ user: Record<string, unknown> | null; grants: (Grant & { agent_name: string; verified_domain: string | null })[]; vault: VaultStatus }>;
  ownerReceipts(cred: OwnerCred, limit?: number, beforeSeq?: number): Promise<{ receipts: Receipt[]; chain: { ok: boolean; broken_at: number | null; head: string; count: number } }>;
  ownerSetPaused(cred: OwnerCred, paused: boolean): Promise<{ paused: boolean }>;
  ownerRevokeGrant(cred: OwnerCred, grantId: string): Promise<{ revoked: boolean }>;
  ownerExport(cred: OwnerCred): Promise<Record<string, unknown>>;
  ownerDeleteEverything(cred: OwnerCred, confirm: string): Promise<{ deleted: boolean; reason?: string; receipts_kept?: number }>;
  ownerSetTz(cred: OwnerCred, tz: string): Promise<{ ok: boolean }>;
  ownerCreateKey(cred: OwnerCred, kind: "owner" | "sync", source?: Source): Promise<{ key: string; source_id: string | null }>;
  ownerIngest(cred: OwnerCred, source: Source, records: CanonicalRecord[]): Promise<IngestResult>;
  ownerCreateDeveloperKey(cred: OwnerCred, orgName: string, agentName: string, webhookUrl?: string): Promise<{ org_id: string; agent_id: string; api_key: string; signing_secret: string; webhook_secret: string | null }>;
  syncIngest(key: string, records: CanonicalRecord[]): Promise<IngestResult>;
  consentExample(userId: string, metric: MetricId, level: 0 | 1 | 2): Promise<string>;
  notifyOrg(agentId: string, event: Record<string, unknown>): Promise<void>;
  devCreateUser(key: string, externalId: string, tz?: string): Promise<{ user: string; created: boolean }>;
  devIngest(key: string, externalId: string, source: Source, records: CanonicalRecord[]): Promise<IngestResult>;
  devConsentLink(key: string, externalId: string, req: { purpose: Purpose; metrics: MetricId[]; max_level: Level; max_window_days: number; daily_packet_budget: number; days: number; return_url?: string }): Promise<{ url?: string; expires_in?: number; error?: string; details?: string[] }>;
  devUsage(key: string): Promise<Record<string, unknown>[]>;
}
