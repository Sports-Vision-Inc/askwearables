// The AskWearables client. Zero runtime dependencies: fetch and WebCrypto only.
import { OPERATIONS, type AskResponse, type GrantRequest, type OperationId, type Packet, type QuerySpec } from "./schema.js";
import { signRequest } from "./signing.js";
import type { Capabilities, CanonicalRecord, CreatedUser, GrantLink, IngestResult, QueryResult, SourceInput, UsageDay } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.askwearables.app";
/** The API accepts at most this many records per ingest call; the SDK splits larger batches. */
export const MAX_INGEST_BATCH = 2000;

export interface ClientOptions {
  /** aw_dev_ (developer), aw_own_ (owner), aw_sync_ (device sync), or an OAuth access token. */
  apiKey: string;
  /** Developer keys: the signing secret shown once with the key. When set, every request is signed. */
  signingSecret?: string;
  baseUrl?: string;
  /** Developer keys: the default end user (your own external id). Each call can override it. */
  user?: string;
  fetch?: typeof fetch;
  /** Retries after HTTP 429. Default 3. */
  maxRetries?: number;
  /** Longest Retry-After the client will wait before giving up, in ms. Default 120000. */
  maxRetryDelayMs?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: current time in ms. */
  now?: () => number;
  headers?: Record<string, string>;
}

export interface CallOptions { user?: string; signal?: AbortSignal }

export class AskWearablesError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly body: unknown,
    public readonly retryAfterMs?: number,
  ) {
    super(`AskWearables API error ${status}: ${code}`);
    this.name = "AskWearablesError";
  }
}

interface RequestSpec {
  op: OperationId;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  user?: string;
  signal?: AbortSignal;
  /** Statuses that return a body instead of throwing. */
  accept?: number[];
}

/** Parse Retry-After (delta seconds or an HTTP date) into ms, or undefined. */
export function parseRetryAfter(v: string | null, nowMs: number): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs);
}

export class AskWearables {
  readonly baseUrl: string;
  private readonly opts: ClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("fetch is not available: pass options.fetch");
    this.fetchImpl = f.bind(globalThis);
  }

  /** Ask one question in plain language. A denial is a normal result (status "denied", with reasons). */
  ask(question: string, o: CallOptions & { purpose?: string } = {}): Promise<AskResponse> {
    const body: Record<string, unknown> = { question };
    if (o.purpose !== undefined) body.purpose = o.purpose;
    return this.request<AskResponse>({ op: "ask", body, user: o.user, signal: o.signal, accept: [403] });
  }

  /** Run a QuerySpec directly. Agents are gated like ask; owner keys get level 3. */
  query(spec: QuerySpec, o: CallOptions = {}): Promise<QueryResult> {
    return this.request<QueryResult>({ op: "query", body: { spec }, user: o.user, signal: o.signal, accept: [403] });
  }

  /** Metrics, operations and levels, plus the grant this agent holds for the user (null if none). */
  capabilities(o: CallOptions = {}): Promise<Capabilities> {
    return this.request<Capabilities>({ op: "capabilities", user: o.user, signal: o.signal });
  }

  /** A packet this agent received in the last 24 hours, or null. */
  async getPacket(packetId: string, o: CallOptions = {}): Promise<Packet | null> {
    try {
      return await this.request<Packet>({ op: "getPacket", pathParams: { packet_id: packetId }, user: o.user, signal: o.signal });
    } catch (e) {
      if (e instanceof AskWearablesError && e.status === 404) return null;
      throw e;
    }
  }

  /** Register an end user by your own id. Idempotent: an existing user returns created: false. */
  createUser(externalId: string, o: { tz?: string; signal?: AbortSignal } = {}): Promise<CreatedUser> {
    return this.request<CreatedUser>({ op: "createUser", body: { external_id: externalId, tz: o.tz ?? "UTC" }, signal: o.signal });
  }

  /** A one-time link (valid one hour) to the hosted consent screen. The user can narrow the request, never widen it. */
  async createGrantLink(req: GrantRequest, o: CallOptions = {}): Promise<GrantLink> {
    const res = await this.request<GrantLink | { error: string; details?: string[] }>({ op: "createGrantLink", body: req, user: o.user, signal: o.signal });
    if ("error" in res) throw new AskWearablesError(200, res.error, res);
    return res;
  }

  /**
   * Push normalized records for one source. Larger batches are split into calls of 2000.
   * Records without a source_id are given the source's id.
   */
  async ingest(input: { source: SourceInput; records: CanonicalRecord[] }, o: CallOptions = {}): Promise<IngestResult> {
    const s = input.source;
    const source = {
      device_model: null, earliest_readable: null, last_sync_at: null, terms_flags: {},
      connected_at: new Date(this.now()).toISOString(), ...s,
    };
    const records = input.records.map((r) => (r.source_id ? r : { ...r, source_id: s.id }));
    const total: IngestResult = { written: 0, unchanged: 0, rejected: [], days_recomputed: 0, data_version: "" };
    for (let i = 0; i < Math.max(1, records.length); i += MAX_INGEST_BATCH) {
      const batch = records.slice(i, i + MAX_INGEST_BATCH);
      const r = await this.request<IngestResult>({ op: "ingest", body: { source, records: batch }, user: o.user, signal: o.signal });
      total.written += r.written ?? 0;
      total.unchanged += r.unchanged ?? 0;
      total.days_recomputed += r.days_recomputed ?? 0;
      for (const x of r.rejected ?? []) total.rejected.push({ index: x.index + i, reason: x.reason });
      total.data_version = r.data_version ?? total.data_version;
    }
    return total;
  }

  /** Calls, packets and denials per day for your organization, newest first (31 days). */
  usage(o: { signal?: AbortSignal } = {}): Promise<UsageDay[]> {
    return this.request<UsageDay[]>({ op: "usage", signal: o.signal });
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private sleep(ms: number) {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  /** Low-level call for any operation in the OpenAPI document. */
  async request<T>(r: RequestSpec): Promise<T> {
    const op = OPERATIONS[r.op];
    let path: string = op.path;
    for (const [k, v] of Object.entries(r.pathParams ?? {})) path = path.replace(`{${k}}`, encodeURIComponent(v));
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(r.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const body = r.body === undefined ? "" : JSON.stringify(r.body);
    const user = r.user ?? this.opts.user;
    const maxRetries = this.opts.maxRetries ?? 3;
    const maxDelay = this.opts.maxRetryDelayMs ?? 120_000;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        ...this.opts.headers,
      };
      if (body) headers["content-type"] = "application/json";
      if (user && op.userHeader) headers["X-AskWearables-User"] = user;
      // A fresh timestamp and single-use nonce for every attempt, so a retry is never a replay.
      if (this.opts.signingSecret) {
        Object.assign(headers, await signRequest({ secret: this.opts.signingSecret, method: op.method, path: url.pathname, body, timestamp: Math.floor(this.now() / 1000) }));
      }
      const init: RequestInit = { method: op.method, headers };
      if (body) init.body = body;
      if (r.signal) init.signal = r.signal;
      const res = await this.fetchImpl(url.toString(), init);
      const text = await res.text();
      let data: unknown = undefined;
      try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }

      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get("retry-after"), this.now()) ?? Math.min(maxDelay, 1000 * 2 ** attempt);
        if (attempt >= maxRetries || wait > maxDelay) throw new AskWearablesError(429, "rate_limited", data, wait);
        await this.sleep(wait);
        continue;
      }
      if (res.ok || r.accept?.includes(res.status)) return data as T;
      const code = typeof data === "object" && data && "error" in data && typeof (data as { error: unknown }).error === "string" ? (data as { error: string }).error : `http_${res.status}`;
      throw new AskWearablesError(res.status, code, data);
    }
  }
}
