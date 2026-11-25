import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalString, hmacSha256Hex, newNonce, sha256Hex, signRequest, verifyWebhook } from "../src/index.js";
import { VECTOR } from "./vectors.js";

describe("signing", () => {
  it("hashes the body with SHA-256 hex", async () => {
    expect(await sha256Hex(VECTOR.post.body)).toBe(VECTOR.post.bodySha256);
    expect(await sha256Hex("")).toBe(VECTOR.get.bodySha256);
  });

  it("builds the canonical string the gate verifies", () => {
    expect(canonicalString({ timestamp: "1", nonce: "n", method: "post", path: "/v1/ask", bodySha256: "h" })).toBe("1\nn\nPOST\n/v1/ask\nh");
  });

  for (const k of ["post", "get"] as const) {
    it(`matches the shared vector (${k})`, async () => {
      const v = VECTOR[k];
      const h = await signRequest({ secret: VECTOR.secret, method: v.method, path: v.path, body: v.body, timestamp: VECTOR.timestamp, nonce: VECTOR.nonce });
      expect(h).toEqual({ "X-AskWearables-Timestamp": String(VECTOR.timestamp), "X-AskWearables-Nonce": VECTOR.nonce, "X-AskWearables-Signature": v.signature });
    });
  }

  it("agrees with an independent node:crypto implementation", async () => {
    const body = JSON.stringify({ spec: { metrics: ["steps"], operation: "trend", window: { start: "2026-11-01", end: "2026-11-20" } } });
    const h = await signRequest({ secret: "s3cret", method: "POST", path: "/v1/query", body, timestamp: 1700000000, nonce: "abcdefghijklmnop" });
    const msg = ["1700000000", "abcdefghijklmnop", "POST", "/v1/query", createHash("sha256").update(body).digest("hex")].join("\n");
    expect(h["X-AskWearables-Signature"]).toBe(createHmac("sha256", "s3cret").update(msg).digest("hex"));
    expect(await hmacSha256Hex("k", "m")).toBe(createHmac("sha256", "k").update("m").digest("hex"));
  });

  it("makes nonces the API accepts, and never repeats them", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = newNonce();
      expect(n).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });

  it("verifies grant webhooks", async () => {
    const body = '{"type":"grant.created","grant_id":"gr_1"}';
    const sig = `sha256=${createHmac("sha256", "whsec_x").update(`1700000000.${body}`).digest("hex")}`;
    expect(await verifyWebhook("whsec_x", { timestamp: "1700000000", signature: sig, body, now: 1700000100 })).toBe(true);
    expect(await verifyWebhook("whsec_x", { timestamp: "1700000000", signature: sig, body: body + " ", now: 1700000100 })).toBe(false);
    expect(await verifyWebhook("whsec_x", { timestamp: "1700000000", signature: sig, body, now: 1700001000 })).toBe(false);
    expect(await verifyWebhook("whsec_x", { timestamp: null, signature: sig, body })).toBe(false);
  });
});
