// Canonical JSON and hashing. WebCrypto is available in both Workers and Node.

/** Deterministic JSON: object keys sorted, no whitespace, numbers as JS prints them. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Short, sortable-ish id with a prefix. Random; use for receipts, grants, agents. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = crypto.getRandomValues(new Uint8Array(10));
  return `${prefix}_${t}${[...r].map((b) => (b % 36).toString(36)).join("")}`;
}

/** Deterministic id derived from content. */
export async function contentId(prefix: string, value: unknown, len = 24): Promise<string> {
  return `${prefix}_${(await sha256Hex(canonicalJson(value))).slice(0, len)}`;
}

/** Rough token estimate used for the packet size limit: 1 token per 4 characters of JSON. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(canonicalJson(value).length / 4);
}
