// Object types are aliases, not interfaces, so they stay assignable to the generated Record types.
// Types the OpenAPI document leaves as plain objects, written to match what the API returns.
// test/types.test.ts checks each one is assignable to its generated counterpart in schema.ts.
import type { AskResponse, GrantRequest, QuerySpec } from "./schema.js";

export type MetricId = GrantRequest["metrics"][number];
/** Metrics an agent can ask about. Sensitive categories are grantable only when named one by one. */
export type PublicMetricId = QuerySpec["metrics"][number];
export type Operation = QuerySpec["operation"];
export type Purpose = GrantRequest["purpose"];
export type Level = GrantRequest["max_level"];

export type Capabilities = {
  operations: { operation: Operation; lowest_level: Level }[];
  metrics: { id: PublicMetricId; label: string; unit: string; granted: boolean | null }[];
  levels: { level: Level; name: "flag" | "trend" | "daily" | "raw" }[];
  /** The grant this agent holds for this user, or null if there is none (yet). */
  grant: { purpose: Purpose; max_level: Level; max_window_days: number; daily_packet_budget: number; expires_at: string } | null;
  examples: string[];
};

export type CreatedUser = { user: string; created: boolean };

export interface GrantLink {
  /** A one-time link to the hosted consent screen. Send your user there. */
  url: string;
  expires_in: number;
}

export type DeviceClass = "watch" | "ring" | "band" | "phone" | "scale" | "cgm" | "other";

export interface TermsFlags { no_ai?: boolean; no_intermediary?: boolean; display_to_user_only?: boolean }

export interface Source {
  id: string;
  provider: string;
  device_model: string | null;
  device_class: DeviceClass;
  connected_at: string;
  earliest_readable: string | null;
  last_sync_at: string | null;
  terms_flags: TermsFlags;
}

/** What you pass to ingest: id, provider and device_class are required; the rest get safe defaults. */
export type SourceInput = Pick<Source, "id" | "provider" | "device_class"> & Partial<Omit<Source, "id" | "provider" | "device_class">>;

export interface SampleRecord {
  kind: "sample";
  metric: MetricId;
  start: string;
  end: string;
  value: number;
  unit: string;
  source_id: string;
  method: "measured" | "vendor_daily" | "derived" | "manual";
  external_id?: string;
  /** Minutes east of UTC on the user's clock at the time of the sample. */
  tz_offset_min: number;
}

export interface SessionRecord {
  kind: "session";
  session_kind: "sleep" | "workout";
  start: string;
  end: string;
  source_id: string;
  external_id?: string;
  tz_offset_min: number;
  is_main?: boolean;
  detail: Record<string, unknown>;
}

export interface VendorScoreRecord {
  kind: "vendor_score";
  provider: string;
  name: string;
  value: number;
  day: string;
  source_id: string;
  external_id?: string;
}

export type CanonicalRecord = SampleRecord | SessionRecord | VendorScoreRecord;

export type IngestResult = {
  written: number;
  unchanged: number;
  rejected: { index: number; reason: string }[];
  days_recomputed: number;
  data_version: string;
};

export type UsageDay = { day: string; calls: number; packets: number; denials: number };

/** Owner keys get `{ status: "invalid", errors }` for a spec that does not validate. */
export type QueryResult = AskResponse | { status: "invalid"; errors: string[] };
