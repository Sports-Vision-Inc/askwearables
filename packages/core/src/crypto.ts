// Envelope encryption: a data key per user (AES-256-GCM), wrapped by a master key held as a Workers secret.
import type { Cipher } from "./receipts.js";

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function importAes(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

async function open(key: CryptoKey, enc: string): Promise<Uint8Array<ArrayBuffer>> {
  const [v, iv, ct] = enc.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("bad_ciphertext");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct)));
}

/** Parse the master key secret: 32 bytes, base64. */
export async function masterKey(secretB64: string): Promise<CryptoKey> {
  const raw = unb64(secretB64);
  if (raw.length !== 32) throw new Error("master_key_must_be_32_bytes");
  return importAes(raw);
}

export async function newWrappedDataKey(master: CryptoKey): Promise<string> {
  const k = new Uint8Array(32) as Uint8Array<ArrayBuffer>;
  crypto.getRandomValues(k);
  return seal(master, k);
}

export async function cipherFromWrapped(master: CryptoKey, wrapped: string): Promise<Cipher> {
  const key = await importAes(await open(master, wrapped));
  return {
    encrypt: (plain) => seal(key, new TextEncoder().encode(plain) as Uint8Array<ArrayBuffer>),
    decrypt: async (enc) => new TextDecoder().decode(await open(key, enc)),
  };
}

/** A pass-through cipher for tests only. */
export const plainCipher: Cipher = {
  encrypt: async (p) => `plain.${p}`,
  decrypt: async (e) => e.replace(/^plain\./, ""),
};
