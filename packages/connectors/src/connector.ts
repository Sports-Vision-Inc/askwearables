// The connector interface. Every provider is a plug-in behind this one shape (spec: "Connectors > Interface").
import type { CanonicalRecord, MetricId, TermsFlags } from "@askwearables/core";
import type { BackoffOptions } from "./http.js";

export type ProviderId = "oura" | "whoop" | "google-health" | "garmin" | "polar" | "strava" | "open-wearables";

export const PROVIDER_IDS: readonly ProviderId[] = ["oura", "whoop", "google-health", "garmin", "polar", "strava", "open-wearables"];

/** OAuth tokens (or an API key) for one user at one provider. Never logged, never put in fixtures. */
export interface Tokens {
  access_token: string;
  /** Absent for providers without refresh (Polar) or API-key access (Open Wearables). */
  refresh_token?: string;
  /** ISO UTC instant the access token stops working, computed from expires_in with the injected clock. */
  expires_at?: string;
  /** ISO UTC instant the refresh token stops working, when the provider says (Garmin). */
  refresh_expires_at?: string;
  scope?: string;
  /** The provider's id for the user: Oura user id, WHOOP user_id, Google healthUserId, Garmin userId, Polar x_user_id. */
  provider_user_id?: string;
}

/** One provider document exactly as fetched or pushed, before normalization. */
export interface RawRecord {
  provider: ProviderId;
  /** Provider data type, e.g. "sleep", "daily_activity", "dailies", "steps". */
  type: string;
  /** Our user id. */
  user_id: string;
  /** Source the canonical records will carry. */
  source_id: string;
  /** One provider document (one sleep, one daily summary, one data point). */
  payload: unknown;
  /** ISO UTC instant we received it. */
  received_at: string;
  /**
   * The user's local offset (minutes east of UTC), for documents that carry only a calendar date.
   * Taken from the user's profile or the nearest timed document. Defaults to 0 when unknown.
   */
  tz_offset_min?: number;
  /**
   * Related documents a provider splits across endpoints, needed to place this one in time
   * (e.g. a WHOOP recovery has no timestamps of its own; its sleep does).
   */
  context?: Record<string, unknown>;
}

/**
 * Work produced by a webhook. Webhook handlers verify, parse and return quickly; the queue does the fetching.
 * `dedupe_key` is stable for a given provider event so redelivered webhooks collapse into one job.
 */
export interface SyncJob {
  provider: ProviderId;
  /**
   * fetch: pull one object or window from the provider.
   * fetch_url: GET a provider-supplied callback URL (Garmin ping, Polar event url).
   * ingest: the payload is already in the webhook (Garmin push); normalize it directly.
   * delete: the provider deleted an object; delete by external id.
   * deregister: the user disconnected at the provider.
   */
  action: "fetch" | "fetch_url" | "ingest" | "delete" | "deregister";
  provider_user_id: string;
  data_type: string;
  object_id?: string;
  window?: { start: string; end: string };
  url?: string;
  payload?: unknown;
  dedupe_key: string;
}

export interface Capabilities {
  metrics: MetricId[];
  webhooks: boolean;
  backfill: boolean;
  /** How far back history can be read, in days; null when the provider documents no limit. */
  historyDays: number | null;
  termsFlags: TermsFlags;
}

export interface AuthStart {
  url: string;
  /** Opaque state to store against userId and check on the callback. */
  state: string;
  /** PKCE verifier, when the provider uses PKCE. Store it server-side until exchangeCode. */
  code_verifier?: string;
}

export interface ExchangeContext {
  redirectUri?: string;
  codeVerifier?: string;
}

export interface Connector {
  readonly provider: ProviderId;
  readonly capabilities: Capabilities;
  authUrl(userId: string, redirectUri: string): Promise<AuthStart>;
  exchangeCode(code: string, ctx?: ExchangeContext): Promise<Tokens>;
  refresh(tokens: Tokens): Promise<Tokens>;
  backfill(userId: string, since: string): AsyncIterable<RawRecord>;
  handleWebhook(request: Request): Promise<SyncJob[]>;
  normalize(raw: RawRecord): CanonicalRecord[];
  /** Answer a provider's endpoint-verification handshake (Oura, Strava, Google). Null when the request is not one. */
  challenge?(request: Request): Promise<Response | null>;
}

/** Everything a connector needs from its host. Tests inject fetch and clock so they never touch the network. */
export interface ConnectorOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  clock?: () => Date;
  /** Injected so 429 backoff can be tested without waiting. */
  sleep?: (ms: number) => Promise<void>;
  backoff?: BackoffOptions;
  /** Tokens for a user, for backfill. The host refreshes and persists; connectors never store tokens. */
  getTokens?: (userId: string) => Promise<Tokens>;
  /** Source id for a user's connection. Defaults to `${provider}:${userId}`. */
  sourceIdFor?: (userId: string) => string;
  /** Local offset for date-only documents when the payload carries none. */
  tzOffsetFor?: (userId: string) => number | undefined;
}

export class WebhookAuthError extends Error {
  readonly status = 401;
  constructor(reason: string) {
    super(`webhook_rejected:${reason}`);
  }
}

/** The provider cannot refresh; the user must go through authUrl again. */
export class ReauthRequired extends Error {
  constructor(provider: ProviderId, reason: string) {
    super(`reauth_required:${provider}:${reason}`);
  }
}

export class ProviderDisabled extends Error {
  constructor(provider: ProviderId, reason: string) {
    super(`provider_disabled:${provider}:${reason}`);
  }
}
