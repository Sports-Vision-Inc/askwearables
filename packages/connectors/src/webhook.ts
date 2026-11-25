// Webhook signature helpers on WebCrypto only (works in Workers and Node 20+).

const enc = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Promise<Uint8Array> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = typeof message === "string" ? enc.encode(message) : message;
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(msg)));
}

/** Constant-time comparison of two strings (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export interface HmacCheck {
  secret: string | Uint8Array;
  message: string | Uint8Array;
  /** Signature as sent by the provider. */
  signature: string | null | undefined;
  encoding: "hex" | "base64";
}

/** Verify an HMAC-SHA256 signature. Hex compares case-insensitively; base64 compares exactly. */
export async function verifyHmacSha256(c: HmacCheck): Promise<boolean> {
  if (!c.signature) return false;
  const mac = await hmacSha256(c.secret, c.message);
  if (c.encoding === "hex") return timingSafeEqual(toHex(mac), c.signature.trim().toLowerCase());
  return timingSafeEqual(toBase64(mac), c.signature.trim());
}

/** Reject timestamps outside a window around now. Providers sign the timestamp, so this blocks replays. */
export function withinTolerance(tsMs: number, now: Date, toleranceMs: number): boolean {
  return Number.isFinite(tsMs) && Math.abs(now.getTime() - tsMs) <= toleranceMs;
}

// ---------- ECDSA (Google Health API webhooks) ----------

/** DER ECDSA signature -> IEEE P1363 r||s, which WebCrypto verifies. */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("der_not_sequence");
  const len = der[i++]!;
  if (len & 0x80) i += len & 0x7f; // long-form length: skip
  const readInt = (): Uint8Array => {
    if (der[i++] !== 0x02) throw new Error("der_not_integer");
    const l = der[i++]!;
    let v = der.slice(i, i + l);
    i += l;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    if (v.length > size) throw new Error("der_int_too_long");
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return out;
}

/** IEEE P1363 r||s -> DER. Used by tests to produce Tink-style signatures. */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  const int = (b: Uint8Array) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) v = v.slice(1);
    if (v[0]! & 0x80) v = Uint8Array.of(0, ...v);
    return Uint8Array.of(0x02, v.length, ...v);
  };
  const r = int(sig.slice(0, half));
  const s = int(sig.slice(half));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}
