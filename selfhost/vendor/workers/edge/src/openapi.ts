// OpenAPI 3.1 description of the REST API. SDKs for Python and TypeScript are generated from this.
import { METRIC_IDS, OPERATIONS, PURPOSES, querySpecJsonSchema } from "@askwearables/core";

export function openapi(host: string) {
  const qs = querySpecJsonSchema().properties.spec;
  const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
  const ok = (schema: unknown, d = "OK") => ({ description: d, content: { "application/json": { schema } } });
  const userHeader = { name: "X-AskWearables-User", in: "header", required: false, schema: { type: "string" }, description: "Developer keys: your end user's external id." };
  const sigHeaders = ["Timestamp", "Nonce", "Signature"].map((n) => ({ name: `X-AskWearables-${n}`, in: "header", required: false, schema: { type: "string" } }));
  return {
    openapi: "3.1.0",
    info: {
      title: "AskWearables API",
      version: "1.0.0",
      description:
        "A broker between wearable data and AI agents. Ask a question; receive a small computed context packet at the level the user's grant allows. " +
        "Developer requests are signed: HMAC-SHA256 over `timestamp\\nnonce\\nMETHOD\\npath\\nsha256(body)` with your signing secret, a single-use nonce and a 300-second window.",
    },
    servers: [{ url: `https://${host}` }],
    security: [{ bearer: [] }],
    paths: {
      "/v1/ask": { post: { operationId: "ask", summary: "Ask a question in plain language", parameters: [userHeader, ...sigHeaders], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["question"], properties: { question: { type: "string", minLength: 3, maxLength: 500 }, purpose: { type: "string", description: "Recorded, never used: the purpose is fixed in the grant." } } } } } }, responses: { "200": ok(ref("AskResponse")), "403": ok(ref("AskResponse"), "Denied, with reasons") } } },
      "/v1/query": { post: { operationId: "query", summary: "Run a QuerySpec directly (agents: gated; owner keys: level 3)", parameters: [userHeader, ...sigHeaders], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["spec"], properties: { spec: ref("QuerySpec") } } } } }, responses: { "200": ok(ref("AskResponse")) } } },
      "/v1/capabilities": { get: { operationId: "capabilities", summary: "Metrics, operations, levels and this agent's grant", parameters: [userHeader, ...sigHeaders], responses: { "200": ok({ type: "object" }) } } },
      "/v1/packets/{packet_id}": { get: { operationId: "getPacket", summary: "A packet this agent received in the last 24 hours", parameters: [{ name: "packet_id", in: "path", required: true, schema: { type: "string" } }, userHeader, ...sigHeaders], responses: { "200": ok(ref("Packet")), "404": ok({ type: "object" }, "Not found") } } },
      "/v1/receipts": { get: { operationId: "receipts", summary: "Owner: receipts, newest first, with chain verification", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }, { name: "before", in: "query", schema: { type: "integer" } }], responses: { "200": ok({ type: "object" }) } } },
      "/v1/grants": { post: { operationId: "createGrantLink", summary: "Developer: a one-time link to the hosted consent screen for your user", parameters: [userHeader, ...sigHeaders], requestBody: { required: true, content: { "application/json": { schema: ref("GrantRequest") } } }, responses: { "200": ok({ type: "object", properties: { url: { type: "string" }, expires_in: { type: "integer" } } }) } } },
      "/v1/grants/{grant_id}": { delete: { operationId: "revokeGrant", summary: "Owner: revoke a grant", parameters: [{ name: "grant_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok({ type: "object" }) } } },
      "/v1/users": { post: { operationId: "createUser", summary: "Developer: register an end user by your own id", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["external_id"], properties: { external_id: { type: "string" }, tz: { type: "string" } } } } } }, responses: { "200": ok({ type: "object" }) } } },
      "/v1/ingest": { post: { operationId: "ingest", summary: "Push normalized records (sync keys, owner keys, developer keys)", parameters: [userHeader], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { source: { type: "object" }, records: { type: "array", maxItems: 2000, items: { type: "object" } } } } } } }, responses: { "200": ok({ type: "object" }) } } },
      "/v1/usage": { get: { operationId: "usage", summary: "Developer: calls, packets and denials per day", responses: { "200": ok({ type: "array" }) } } },
      "/v1/export": { get: { operationId: "export", summary: "Owner: export everything", responses: { "200": ok({ type: "object" }) } } },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An OAuth access token for an agent, or an API key: aw_own_ (owner), aw_dev_ (developer), aw_sync_ (device sync)." } },
      schemas: {
        QuerySpec: qs,
        GrantRequest: { type: "object", required: ["purpose", "metrics", "max_level", "max_window_days", "daily_packet_budget", "days"], properties: { purpose: { type: "string", enum: PURPOSES }, metrics: { type: "array", items: { type: "string", enum: METRIC_IDS } }, max_level: { type: "integer", enum: [0, 1, 2, 3] }, max_window_days: { type: "integer", minimum: 1, maximum: 365 }, daily_packet_budget: { type: "integer", minimum: 1 }, days: { type: "integer", minimum: 1, maximum: 90 }, return_url: { type: "string", format: "uri" } } },
        Finding: { type: "object", required: ["metric", "statement"], properties: { metric: { type: "string" }, statement: { type: "string" }, flag: { type: "string", enum: ["yes", "no", "unknown"] }, direction: { type: "string" }, magnitude: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, values: { type: "array", items: { type: "object" } }, unknown_reason: { type: "string" } } },
        Packet: { type: "object", required: ["packet_version", "packet_id", "level", "findings", "data_quality", "data_version", "not_medical_advice"], properties: { packet_version: { const: "1" }, packet_id: { type: "string" }, level: { type: "integer" }, operation: { type: "string", enum: OPERATIONS }, metrics: { type: "array", items: { type: "string" } }, window: { type: "object" }, findings: { type: "array", items: ref("Finding") }, data_quality: { type: "object", properties: { freshness_hours: { type: ["number", "null"] }, coverage: { type: ["number", "null"] }, sources: { type: "array", items: { type: "string" } }, baseline_days: { type: ["integer", "null"] }, caveats: { type: "array", items: { type: "string" } } } }, as_of: { type: "string" }, data_version: { type: "string" }, not_medical_advice: { const: true } } },
        AskResponse: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["ok", "denied", "unsupported"] }, packet: ref("Packet"), receipt_id: { type: "string" }, reasons: { type: "array", items: { type: "string" } }, supported: { type: "array", items: { type: "string" } } } },
      },
    },
  };
}
