// HTTP helpers shared by every connector: 429 backoff, form posts, OAuth state and PKCE.

export interface BackoffOptions {
  /** Retries after the first attempt. Default 5. */
  maxRetries?: number;
  /** First wait when no Retry-After is given. Default 1000 ms, doubled each retry. */
  baseMs?: number;
  /** Cap on any single wait, including a Retry-After. Default 60 s. */
  maxMs?: number;
  /** Also retry 502, 503 and 504. Default true. */
  retryServerErrors?: boolean;
}

export interface HttpDeps {
  fetch: typeof fetch;
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
  backoff?: BackoffOptions;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`http_${status}:${url.split("?")[0]}`);
  }
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse Retry-After: delta-seconds or an HTTP date. Returns milliseconds to wait, or null when absent/unparseable.
 */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now.getTime());
}

/** Wait before retry `attempt` (0-based): Retry-After when the server sent one, else base * 2^attempt. */
export function backoffDelay(attempt: number, retryAfterMs: number | null, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 60_000;
  const d = retryAfterMs ?? base * 2 ** attempt;
  return Math.min(max, Math.max(0, d));
}

/**
 * fetch with exponential backoff on 429 (and, by default, 502/503/504), honouring Retry-After.
 * The request is rebuilt each attempt, so pass the init rather than a consumed Request.
 */
export async function fetchWithBackoff(deps: HttpDeps, url: string, init: RequestInit = {}): Promise<Response> {
  const opts = deps.backoff ?? {};
  const maxRetries = opts.maxRetries ?? 5;
  const retryable = (s: number) => s === 429 || (opts.retryServerErrors !== false && (s === 502 || s === 503 || s === 504));
  for (let attempt = 0; ; attempt++) {
    const res = await deps.fetch(url, init);
    if (!retryable(res.status) || attempt >= maxRetries) return res;
    const wait = backoffDelay(attempt, parseRetryAfter(res.headers.get("retry-after"), deps.clock()), opts);
    // Release the body so the connection can be reused. Not awaited: cancel() on a tee'd stream can stay pending.
    res.body?.cancel().catch(() => undefined);
    await deps.sleep(wait);
  }
}

/** fetchWithBackoff, then throw HttpError on a non-2xx and parse JSON. */
export async function getJson<T = unknown>(deps: HttpDeps, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithBackoff(deps, url, init);
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ""));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function formBody(fields: Record<string, string | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return p;
}

export function basicAuth(id: string, secret: string): string {
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random URL-safe string from WebCrypto. */
export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 pair (RFC 7636). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

/** Standard OAuth token response, as most providers return it. */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  [k: string]: unknown;
}

export function tokensFromResponse(r: OAuthTokenResponse, now: Date) {
  const out: {
    access_token: string;
    refresh_token?: string;
    expires_at?: string;
    refresh_expires_at?: string;
    scope?: string;
  } = { access_token: r.access_token };
  if (r.refresh_token) out.refresh_token = r.refresh_token;
  if (typeof r.expires_in === "number") out.expires_at = new Date(now.getTime() + r.expires_in * 1000).toISOString();
  if (typeof r.refresh_token_expires_in === "number")
    out.refresh_expires_at = new Date(now.getTime() + r.refresh_token_expires_in * 1000).toISOString();
  if (r.scope) out.scope = r.scope;
  return out;
}
