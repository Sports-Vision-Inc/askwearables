// Generated from sdks/openapi.json by codegen/run.ts. Do not edit by hand: run `npm run generate`.
/* eslint-disable */

export interface QuerySpec {
  metrics: Array<"steps" | "active_energy" | "resting_hr" | "heart_rate" | "hrv_rmssd" | "hrv_sdnn" | "sleep_duration" | "sleep_efficiency" | "sleep_stages" | "spo2" | "respiratory_rate" | "skin_temp_deviation" | "vo2max" | "weight" | "workout">;
  operation: "latest" | "aggregate" | "trend" | "compare_to_baseline" | "compare_periods" | "threshold_check" | "correlate" | "list_sessions";
  window: {
    start: string;
    end: string;
  };
  granularity?: "day" | "week";
  params?: {
    comparator?: "<" | "<=" | ">" | ">=";
    threshold?: number;
    threshold_unit?: string;
    mode?: "any" | "all" | "count";
    compare_window?: {
      start: string;
      end: string;
    };
    lag_days?: 0 | 1;
    session_kind?: "workout" | "sleep";
    statistic?: "total" | "mean" | "min" | "max";
  };
}

export interface GrantRequest {
  purpose: "scheduling" | "training_advice" | "sleep_coaching" | "general_wellness" | "personal_research";
  metrics: Array<"steps" | "active_energy" | "resting_hr" | "heart_rate" | "hrv_rmssd" | "hrv_sdnn" | "sleep_duration" | "sleep_efficiency" | "sleep_stages" | "spo2" | "respiratory_rate" | "skin_temp_deviation" | "vo2max" | "weight" | "workout" | "blood_glucose" | "menstrual_cycle" | "ecg_classification" | "breathing_disturbances">;
  max_level: 0 | 1 | 2 | 3;
  max_window_days: number;
  daily_packet_budget: number;
  days: number;
  return_url?: string;
}

export interface Finding {
  metric: string;
  statement: string;
  flag?: "yes" | "no" | "unknown";
  direction?: string;
  magnitude?: string;
  value?: number;
  unit?: string;
  values?: Record<string, unknown>[];
  unknown_reason?: string;
}

export interface Packet {
  packet_version: "1";
  packet_id: string;
  level: number;
  operation?: "latest" | "aggregate" | "trend" | "compare_to_baseline" | "compare_periods" | "threshold_check" | "correlate" | "list_sessions";
  metrics?: string[];
  window?: Record<string, unknown>;
  findings: Finding[];
  data_quality: {
    freshness_hours?: number | null;
    coverage?: number | null;
    sources?: string[];
    baseline_days?: number | null;
    caveats?: string[];
  };
  as_of?: string;
  data_version: string;
  not_medical_advice: true;
}

export interface AskResponse {
  status: "ok" | "denied" | "unsupported";
  packet?: Packet;
  receipt_id?: string;
  reasons?: string[];
  supported?: string[];
}

export interface AskRequestBody {
  question: string;
  /** Recorded, never used: the purpose is fixed in the grant. */
  purpose?: string;
}

export type AskResponseBody = AskResponse;

export interface QueryRequestBody {
  spec: QuerySpec;
}

export type QueryResponseBody = AskResponse;

export type CapabilitiesResponseBody = Record<string, unknown>;

export type GetPacketResponseBody = Packet;

export type ReceiptsResponseBody = Record<string, unknown>;

export type CreateGrantLinkRequestBody = GrantRequest;

export interface CreateGrantLinkResponseBody {
  url?: string;
  expires_in?: number;
}

export type RevokeGrantResponseBody = Record<string, unknown>;

export interface CreateUserRequestBody {
  external_id: string;
  tz?: string;
}

export type CreateUserResponseBody = Record<string, unknown>;

export interface IngestRequestBody {
  source?: Record<string, unknown>;
  records?: Record<string, unknown>[];
}

export type IngestResponseBody = Record<string, unknown>;

export type UsageResponseBody = unknown[];

export type ExportResponseBody = Record<string, unknown>;

/** Every operation in the OpenAPI document: method, path template, and whether it takes a signature and user header. */
export const OPERATIONS = {
  ask: { method: "POST", path: "/v1/ask", signed: true, userHeader: true, body: true },
  query: { method: "POST", path: "/v1/query", signed: true, userHeader: true, body: true },
  capabilities: { method: "GET", path: "/v1/capabilities", signed: true, userHeader: true, body: false },
  getPacket: { method: "GET", path: "/v1/packets/{packet_id}", signed: true, userHeader: true, body: false },
  receipts: { method: "GET", path: "/v1/receipts", signed: false, userHeader: false, body: false },
  createGrantLink: { method: "POST", path: "/v1/grants", signed: true, userHeader: true, body: true },
  revokeGrant: { method: "DELETE", path: "/v1/grants/{grant_id}", signed: false, userHeader: false, body: false },
  createUser: { method: "POST", path: "/v1/users", signed: false, userHeader: false, body: true },
  ingest: { method: "POST", path: "/v1/ingest", signed: false, userHeader: true, body: true },
  usage: { method: "GET", path: "/v1/usage", signed: false, userHeader: false, body: false },
  export: { method: "GET", path: "/v1/export", signed: false, userHeader: false, body: false },
} as const;

export type OperationId = keyof typeof OPERATIONS;
