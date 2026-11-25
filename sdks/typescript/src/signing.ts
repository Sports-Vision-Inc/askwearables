// Request signing for developer keys, using WebCrypto only.
// signature = hex(HMAC-SHA256(secret, `${timestamp}\n${nonce}\n${METHOD}\n${path}\n${sha256hex(body)}`))
// path is the URL path without the query string; body is the exact bytes sent ("" for GET).

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto (globalThis.crypto.subtle) is required: use Node 20+, Deno, Bun, a browser or Workers");
  return c.subtle;
}

export async function sha256Hex(data: string): Promise<string> {
  return hex(await subtle().digest("SHA-256", enc.encode(data)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await subtle().importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await subtle().sign("HMAC", key, enc.encode(message)));
}

/** 24 URL-safe characters from 18 random bytes; the API accepts [A-Za-z0-9_-]{16,64}. */
export function newNonce(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function canonicalString(p: { timestamp: string; nonce: string; method: string; path: string; bodySha256: string }): string {
  return [p.timestamp, p.nonce, p.method.toUpperCase(), p.path, p.bodySha256].join("\n");
}

export interface SignInput {
  secret: string;
  method: string;
  /** URL path only, for example "/v1/ask". */
  path: string;
  body: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
  nonce?: string;
}

export async function signRequest(i: SignInput): Promise<Record<string, string>> {
  const timestamp = String(i.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = i.nonce ?? newNonce();
  const signature = await hmacSha256Hex(i.secret, canonicalString({ timestamp, nonce, method: i.method, path: i.path, bodySha256: await sha256Hex(i.body) }));
  return { "X-AskWearables-Timestamp": timestamp, "X-AskWearables-Nonce": nonce, "X-AskWearables-Signature": signature };
}

/**
 * Verify a grant webhook from AskWearables (grant.created, grant.revoked).
 * Signature header: `sha256=hex(HMAC-SHA256(webhook_secret, `${timestamp}.${rawBody}`))`.
 */
export async function verifyWebhook(secret: string, p: { timestamp: string | null; signature: string | null; body: string; toleranceSeconds?: number; now?: number }): Promise<boolean> {
  if (!p.timestamp || !p.signature) return false;
  const ts = Number(p.timestamp);
  const now = p.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (p.toleranceSeconds ?? 300)) return false;
  const expected = `sha256=${await hmacSha256Hex(secret, `${p.timestamp}.${p.body}`)}`;
  if (expected.length !== p.signature.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i++) d |= expected.charCodeAt(i) ^ p.signature.charCodeAt(i);
  return d === 0;
}
