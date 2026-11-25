// End-to-end check of the self-host edition against `wrangler dev`.
//
//   node scripts/e2e.mjs
//     Starts its own `wrangler dev` on a fresh, temporary local state (D1, KV, Durable Object) with random
//     secrets, runs every step, then stops it. Nothing is deployed.
//   AW_BASE=http://127.0.0.1:8787 AW_SETUP_TOKEN=... node scripts/e2e.mjs
//     Runs against a server you started yourself. Setup works once per instance, so use fresh state.
//
// Steps: discovery and the 401 challenge; owner setup with a software passkey (real WebAuthn registration
// and sign-in, verified by the same @simplewebauthn/server code as production); import of a synthetic Apple
// Health export.xml through the console's own streaming importer; owner REST with an owner key; an agent
// connecting over OAuth (dynamic registration, PKCE, the eight-item consent screen); asking over REST and
// over MCP; receipts and chain verification; revoke, pause, export and delete everything.
//
// The planner uses the AI binding. In `wrangler dev` that binding is always remote, so the two questions
// asked here are billed to the Cloudflare account wrangler is logged in to (a few cents at most). Logged
// out, the planner falls back to its keyword rules and the run still passes.
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const step = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
};
const must = (name, ok, detail) => { if (!step(name, ok, detail)) throw new Error(`stopped at: ${name}`); };

// ---------- server ----------

let BASE = process.env.AW_BASE;
let SETUP = process.env.AW_SETUP_TOKEN;
let server = null;
let stateDir = null;

async function startServer() {
  stateDir = mkdtempSync(join(tmpdir(), "aw-selfhost-e2e-"));
  SETUP = randomBytes(24).toString("hex");
  const envFile = join(stateDir, "e2e.env");
  writeFileSync(envFile, `MASTER_KEY=${randomBytes(32).toString("base64")}\nOWNER_SETUP_TOKEN=${SETUP}\n`);
  const port = 8800 + Math.floor(Math.random() * 100);
  BASE = `http://127.0.0.1:${port}`;
  const wrangler = join(root, "node_modules/.bin/wrangler");
  execFileSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", join(stateDir, "state")], { cwd: root, stdio: "ignore" });
  server = spawn(wrangler, ["dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(stateDir, "state"), "--env-file", envFile, "--show-interactive-dev-session=false"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`wrangler dev did not start:\n${log}`)), 90_000);
    const on = (b) => { log += b; if (/Ready on/.test(log)) { clearTimeout(t); ok(); } };
    server.stdout.on("data", on);
    server.stderr.on("data", on);
    server.on("exit", (c) => { clearTimeout(t); fail(new Error(`wrangler dev exited ${c}:\n${log}`)); });
  });
  server.removeAllListeners("exit");
}

function stopServer() {
  if (server) server.kill("SIGTERM");
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
}

// ---------- HTTP with a small cookie jar ----------

const jar = new Map();
async function http(method, path, { body, headers = {}, form, bearer, cookies = true, redirect = "manual" } = {}) {
  const h = { origin: BASE, ...headers };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (cookies && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  let payload;
  if (form) { payload = form instanceof URLSearchParams ? form : new URLSearchParams(form); h["content-type"] = "application/x-www-form-urlencoded"; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] ??= "application/json"; }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect });
  if (cookies) for (const c of res.headers.getSetCookie()) {
    const [kv, ...attrs] = c.split(";");
    const i = kv.indexOf("=");
    const name = kv.slice(0, i).trim(), value = kv.slice(i + 1).trim();
    if (attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "") jar.delete(name); else jar.set(name, value);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}
const api = (method, path, body) => http(method, `/api/${path}`, { body, headers: { "x-aw-csrf": "1" } });

// ---------- a software passkey (P-256, "none" attestation) ----------

const b64url = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  return cbor(new Map(Object.entries(v)));
}

function softAuthenticator(rpId) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  let counter = 0;
  const rpHash = sha256(rpId);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return {
    create(challenge, origin) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), u32(counter), Buffer.alloc(16), len, credId, cose]); // UP | UV | AT
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id: b64url(credId), rawId: b64url(credId), type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ["internal"] } };
    },
    get(challenge, origin) {
      counter++;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), u32(counter)]); // UP | UV
      const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), privateKey); // DER, as WebAuthn expects
      return { id: b64url(credId), rawId: b64url(credId), type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature) } };
    },
  };
}

// ---------- a synthetic Apple Health export (no real person) ----------

function syntheticExport(days) {
  const dev = "&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch7,1, software:11.0&gt;";
  const src = `sourceName="Synthetic Watch" sourceVersion="11.0" device="${dev}"`;
  const d = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " +0000";
  const rows = [];
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  for (let i = days; i >= 1; i--) {
    const day = today - i * 86_400_000;
    const bed = day - 90 * 60_000 + ((i * 7) % 40) * 60_000; // around 22:30 the evening before
    const asleepMin = 400 + ((i * 37) % 50) - (i <= 3 ? 80 : 0);
    const stages = [["AsleepCore", 0.45], ["AsleepDeep", 0.2], ["AsleepREM", 0.2], ["AsleepCore", 0.15]];
    let t = bed;
    for (const [stage, share] of stages) {
      const end = t + Math.round(asleepMin * share) * 60_000;
      rows.push(`<Record type="HKCategoryTypeIdentifierSleepAnalysis" ${src} creationDate="${d(end)}" startDate="${d(t)}" endDate="${d(end)}" value="HKCategoryValueSleepAnalysis${stage}"/>`);
      t = end;
    }
    rows.push(`<Record type="HKQuantityTypeIdentifierRestingHeartRate" ${src} unit="count/min" creationDate="${d(day + 20 * 3_600_000)}" startDate="${d(day + 60_000)}" endDate="${d(day + 20 * 3_600_000)}" value="${54 + (i % 5) + (i <= 3 ? 4 : 0)}"/>`);
    for (let h = 8; h < 21; h++) {
      const s = day + h * 3_600_000;
      rows.push(`<Record type="HKQuantityTypeIdentifierStepCount" ${src} unit="count" creationDate="${d(s + 3_600_000)}" startDate="${d(s)}" endDate="${d(s + 50 * 60_000)}" value="${500 + ((i * h) % 300)}"/>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n <ExportDate value="${d(Date.now())}"/>\n ${rows.join("\n ")}\n</HealthData>\n`;
}

/** The console's importer, bundled the same way as public/app.js, so this run parses the file as a browser would. */
async function loadImporter() {
  const out = await build({
    stdin: { contents: `export { importAppleHealth } from "@askwearables/importers";`, resolveDir: root, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "warning",
    alias: { "@askwearables/core": join(root, "vendor/core/src/index.ts"), "@askwearables/importers": join(root, "vendor/importers/src/index.ts") },
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

// ---------- MCP over streamable HTTP ----------

async function mcp(token, sessionId, id, method, params) {
  const headers = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const r = await http("POST", "/mcp", { bearer: token, cookies: false, headers, body: { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) } });
  let msg = r.json;
  if (!msg && r.text.includes("data:")) {
    const datas = r.text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    msg = datas.find((m) => m.id === id) ?? datas.at(-1);
  }
  return { status: r.status, msg, sessionId: r.headers.get("mcp-session-id") ?? sessionId, headers: r.headers };
}

// ---------- the run ----------

async function run() {
  const origin = BASE;
  const rpId = new URL(BASE).hostname;

  // 1. Discovery and the challenge an MCP client sees first.
  const un = await http("POST", "/mcp", { cookies: false, headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  const www = un.headers.get("www-authenticate") ?? "";
  step("unauthenticated /mcp is 401", un.status === 401, `status=${un.status}`);
  step("401 names the protected resource metadata", www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`) && www.includes('scope="wearables:ask"'), www);
  const prm = (await http("GET", "/.well-known/oauth-protected-resource", { cookies: false })).json;
  step("resource metadata: this origin, its own issuer", prm?.resource === `${BASE}/` && prm?.authorization_servers?.[0] === BASE, JSON.stringify(prm));
  const asm = (await http("GET", "/.well-known/oauth-authorization-server", { cookies: false })).json;
  step("authorization server metadata", asm?.issuer === BASE && asm?.authorization_endpoint === `${BASE}/authorize` && !!asm?.registration_endpoint && asm?.code_challenge_methods_supported?.includes("S256"));
  const unApi = await http("GET", "/v1/capabilities", { cookies: false });
  step("unauthenticated /v1 is 401 with the same challenge", unApi.status === 401 && (unApi.headers.get("www-authenticate") ?? "").includes("resource_metadata="));
  const home = await http("GET", "/", { cookies: false });
  step("before setup, / explains how to finish setup", home.status === 200 && home.text.includes("/setup?token="));

  // 2. Owner setup: the setup page, then a passkey.
  step("setup with a wrong token is refused", (await http("GET", "/setup?token=wrong", { cookies: false })).status === 403);
  const setupPage = await http("GET", `/setup?token=${SETUP}`, { cookies: false });
  step("setup page: operator notice and the LICENSE, not hosted terms",
    setupPage.status === 200 && setupPage.text.includes("You run this instance") && setupPage.text.includes("Sports Vision does not see it")
    && setupPage.text.includes("github.com/Sports-Vision-Inc/askwearables/blob/main/LICENSE") && !setupPage.text.includes("askwearables.app/terms"));
  step("setup page loads only the self-hosted WebAuthn bundle", /<script nonce="[^"]+" src="\/static\/webauthn-browser\.js"><\/script>/.test(setupPage.text) && !/src="https?:/.test(setupPage.text)
    && (setupPage.headers.get("content-security-policy") ?? "").includes("script-src 'nonce-"));
  const key = softAuthenticator(rpId);
  const regOpts = await http("POST", "/webauthn/register/options", { body: { setup: SETUP } });
  must("registration options", regOpts.status === 200 && regOpts.json?.rp?.id === rpId, `status=${regOpts.status}`);
  const noAccept = await http("POST", "/webauthn/register/verify", { body: { setup: SETUP, response: key.create(regOpts.json.challenge, origin), accepted: false } });
  step("registration without the clickwrap is refused", noAccept.status === 400);
  const regOpts2 = await http("POST", "/webauthn/register/options", { body: { setup: SETUP } });
  const reg = await http("POST", "/webauthn/register/verify", { body: { setup: SETUP, response: key.create(regOpts2.json.challenge, origin), accepted: true } });
  must("passkey registered; owner signed in", reg.status === 200 && reg.json?.ok === true && jar.has("__Secure-aw_session"), reg.text);
  step("setup closes once the owner exists", (await http("GET", `/setup?token=${SETUP}`, { cookies: false })).status === 403);
  jar.delete("__Secure-aw_session");
  const authOpts = await http("POST", "/webauthn/auth/options", {});
  const login = await http("POST", "/webauthn/auth/verify", { body: { response: key.get(authOpts.json.challenge, origin) } });
  must("sign in again with the passkey", login.status === 200 && login.json?.ok === true && jar.has("__Secure-aw_session"), login.text);

  // 3. Console: status, then import a synthetic export.xml exactly as the console does.
  const consolePage = await http("GET", "/");
  step("console page served, marked self-host, with the operator notice", consolePage.status === 200 && consolePage.text.includes('data-selfhost="1"') && consolePage.text.includes("You run this instance"));
  const st0 = await api("GET", "status");
  must("console status", st0.status === 200 && st0.json?.user?.role === "owner", st0.text.slice(0, 200));
  const csrf = await http("POST", "/api/pause", { body: { paused: true } });
  step("console refuses a state change without the CSRF header", csrf.status === 403);
  const { importAppleHealth } = await loadImporter();
  const xml = syntheticExport(45);
  const stream = new Blob([xml]).stream();
  const sources = new Map();
  let sent = 0, written = 0;
  for await (const batch of importAppleHealth(stream, { batchSize: 2000 })) {
    for (const s of batch.sources) sources.set(s.id, s);
    const bySource = new Map();
    for (const r of batch.records) (bySource.get(r.source_id) ?? bySource.set(r.source_id, []).get(r.source_id)).push(r);
    for (const [sid, recs] of bySource) {
      const r = await api("POST", "import", { source: sources.get(sid), records: recs });
      if (r.status !== 200) { step("import batch", false, r.text); break; }
      sent += recs.length; written += r.json.written ?? 0;
    }
  }
  must("synthetic export.xml imported through the streaming importer", sent > 0 && written > 0, `${sent} records sent, ${written} written`);
  const st1 = await api("GET", "status");
  const src = st1.json?.vault?.sources?.[0];
  step("status shows the source, its freshness and metrics", !!src && src.days >= 40 && src.metrics.includes("sleep_duration") && src.metrics.includes("resting_hr"),
    src ? `${src.provider}: ${src.days} days, ${src.first_day} to ${src.last_day}, metrics ${src.metrics.join(",")}` : "no source");

  // 4. Owner REST with an owner key.
  const ownerKey = (await api("POST", "keys", { kind: "owner" })).json?.key;
  must("owner API key created", typeof ownerKey === "string" && ownerKey.startsWith("aw_own_"));
  step("developer keys are not offered", (await api("POST", "developer", { org: "x", agent: "y" })).status === 404);
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const oq = await http("POST", "/v1/query", { bearer: ownerKey, cookies: false, body: { spec: { metrics: ["sleep_duration"], operation: "aggregate", window: { start: weekAgo, end: today }, params: { statistic: "mean" } } } });
  step("owner REST query (level 3)", oq.status === 200 && oq.json?.status === "ok" && oq.json?.packet?.level === 3, oq.json?.packet?.findings?.[0]?.statement ?? oq.text.slice(0, 200));
  const extra = [{ kind: "sample", metric: "resting_hr", start: `${today}T00:00:00.000Z`, end: `${today}T06:00:00.000Z`, value: 55, unit: "bpm", source_id: "e2e_rest", method: "vendor_daily", external_id: `rhr-${today}`, tz_offset_min: 0 }];
  const restSource = { id: "e2e_rest", provider: "e2e_synthetic", device_model: "Synthetic Ring", device_class: "ring", connected_at: new Date().toISOString(), earliest_readable: null, last_sync_at: null, terms_flags: {} };
  const ri1 = await http("POST", "/v1/ingest", { bearer: ownerKey, cookies: false, body: { source: restSource, records: extra } });
  const ri2 = await http("POST", "/v1/ingest", { bearer: ownerKey, cookies: false, body: { source: restSource, records: extra } });
  step("owner REST ingest, idempotent", ri1.status === 200 && ri1.json?.written === 1 && ri2.json?.written === 0, `first=${ri1.json?.written} again=${ri2.json?.written}`);
  step("developer-platform REST routes are off", (await http("GET", "/v1/usage", { bearer: ownerKey, cookies: false })).status === 404
    && (await http("POST", "/v1/ask", { bearer: "aw_dev_00000000000000000000000000000000", cookies: false, body: { question: "how did I sleep?" } })).status === 404);

  // 5. An agent connects: dynamic registration, PKCE, the consent screen.
  const redirectUri = "http://127.0.0.1:9/callback";
  const client = (await http("POST", "/oauth/register", { cookies: false, body: { client_name: "E2E Agent", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } })).json;
  must("client registered (DCR)", !!client?.client_id, JSON.stringify(client));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(sha256(verifier));
  const state = b64url(randomBytes(8));
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, scope: "wearables:ask", state, code_challenge: challenge, code_challenge_method: "S256", resource: `${BASE}/mcp` });
  const consent = await http("GET", `/authorize?${q}`);
  const items = ["1. Which agent", "2. For what purpose", "3. Which metrics", "4. How much detail", "5. How far back", "6. How often", "7. Until when", "8. What is not approved"];
  must("consent screen shows all eight items", consent.status === 200 && items.every((t) => consent.text.includes(t)), `status=${consent.status} ${consent.headers.get("location") ?? ""}`);
  step("consent screen: loopback warning, self-host footer, no hosted terms", consent.text.includes("app on your computer") && consent.text.includes("which you run") && !consent.text.includes("askwearables.app/terms"));
  const handle = /name="handle" value="([^"]+)"/.exec(consent.text)?.[1];
  const purpose = /<select name="purpose" required><option value="([^"]+)"/.exec(consent.text)?.[1];
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const form = new URLSearchParams({ handle, purpose, max_level: "2", max_window_days: "30", daily_packet_budget: "20", expires, decision: "approve" });
  for (const m of ["sleep_duration", "resting_hr", "steps"]) form.append("metric", m);
  const approved = await http("POST", "/authorize", { form });
  const loc = approved.headers.get("location");
  const code = loc ? new URL(loc).searchParams.get("code") : null;
  must("consent approved; redirected with a code and the state", !!code && new URL(loc).searchParams.get("state") === state, loc ?? "no redirect");
  const tok = await http("POST", "/oauth/token", { cookies: false, form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` } });
  const token = tok.json?.access_token;
  must("access token issued", tok.status === 200 && typeof token === "string", tok.text.slice(0, 200));

  // 6. Ask over REST and over MCP.
  const caps = await http("GET", "/v1/capabilities", { bearer: token, cookies: false });
  step("REST capabilities show the grant", caps.status === 200 && caps.json?.grant?.max_level === 2 && caps.json?.grant?.purpose === purpose);
  const ask = await http("POST", "/v1/ask", { bearer: token, cookies: false, body: { question: "How much did I sleep this week compared to usual?" } });
  step("REST ask returns a packet", ask.status === 200 && ask.json?.status === "ok" && !!ask.json?.packet?.packet_id && ask.json.packet.level <= 2,
    ask.json?.packet ? `level ${ask.json.packet.level}: ${ask.json.packet.findings?.[0]?.statement}` : ask.text.slice(0, 300));
  const denied = await http("POST", "/v1/query", { bearer: token, cookies: false, body: { spec: { metrics: ["hrv_rmssd"], operation: "aggregate", window: { start: weekAgo, end: today }, params: { statistic: "mean" } } } });
  step("a metric outside the grant is denied by gate", denied.status === 403 && denied.json?.status === "denied" && (denied.json?.reasons ?? []).some((r) => r.startsWith("metric_not_in_grant")), JSON.stringify(denied.json?.reasons ?? denied.text.slice(0, 120)));
  let m = await mcp(token, null, 1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "aw-e2e", version: "1.0.0" } });
  must("MCP initialize", m.status === 200 && m.msg?.result?.serverInfo?.name === "askwearables", `status=${m.status} ${JSON.stringify(m.msg).slice(0, 200)}`);
  const sid = m.sessionId;
  await mcp(token, sid, null, "notifications/initialized");
  m = await mcp(token, sid, 2, "tools/list");
  const tools = (m.msg?.result?.tools ?? []).map((t) => t.name).sort();
  step("MCP tools: ask, get_packet, list_capabilities", JSON.stringify(tools) === JSON.stringify(["ask", "get_packet", "list_capabilities"]), tools.join(","));
  m = await mcp(token, sid, 3, "tools/call", { name: "ask", arguments: { question: "Is my resting heart rate higher than usual?" } });
  const mres = m.msg?.result?.structuredContent;
  step("MCP ask returns a packet", m.msg?.result && !m.msg.result.isError && mres?.status === "ok", mres?.packet ? `level ${mres.packet.level}: ${mres.packet.findings?.[0]?.statement}` : JSON.stringify(m.msg).slice(0, 300));
  if (mres?.packet?.packet_id) {
    m = await mcp(token, sid, 4, "tools/call", { name: "get_packet", arguments: { packet_id: mres.packet.packet_id } });
    step("MCP get_packet returns the same packet", JSON.parse(m.msg?.result?.content?.[0]?.text ?? "{}").packet_id === mres.packet.packet_id);
  }

  // 7. Receipts, with chain verification, in the console and over REST.
  const rc = await api("GET", "receipts?limit=100");
  const agentReceipts = (rc.json?.receipts ?? []).filter((r) => r.agent_id === client.client_id);
  step("receipts chain verifies", rc.json?.chain?.ok === true && rc.json.chain.count >= 4, `count=${rc.json?.chain?.count}`);
  step("every agent answer and denial has a receipt", agentReceipts.filter((r) => r.decision === "released").length >= 2 && agentReceipts.some((r) => r.decision === "denied"),
    agentReceipts.map((r) => r.decision).join(","));
  const rr = await http("GET", "/v1/receipts?limit=2", { bearer: ownerKey, cookies: false });
  step("owner REST receipts, paged, with the chain", rr.status === 200 && rr.json?.chain?.ok === true && rr.json.receipts.length === 2 && rr.json.chain.count === rc.json?.chain?.count);

  // 8. Controls: pause, revoke, export, delete everything.
  await api("POST", "pause", { paused: true });
  const paused = await http("POST", "/v1/ask", { bearer: token, cookies: false, body: { question: "How many steps did I take yesterday?" } });
  step("pause stops releases", paused.json?.status !== "ok", `status=${paused.json?.status} ${JSON.stringify(paused.json?.reasons ?? [])}`);
  await api("POST", "pause", { paused: false });
  const grants = (await api("GET", "status")).json?.grants ?? [];
  const g = grants.find((x) => x.agent_id === client.client_id && !x.revoked_at);
  step("grant listed in the console", !!g && g.agent_name === "E2E Agent");
  const rv = await api("POST", "revoke", { grant_id: g?.grant_id });
  const afterRevoke = await http("POST", "/v1/ask", { bearer: token, cookies: false, body: { question: "How did I sleep last night?" } });
  step("revoke ends the agent's access", rv.json?.revoked === true && afterRevoke.status === 401, `ask after revoke: ${afterRevoke.status}`);
  const ex = await http("GET", "/api/export");
  step("export everything", ex.status === 200 && (ex.headers.get("content-disposition") ?? "").includes("attachment") && ex.json?.samples?.length > 0 && Array.isArray(ex.json?.receipts));
  step("delete needs the confirmation text", (await api("POST", "delete", { confirm: "yes" })).json?.deleted === false);
  const del = await api("POST", "delete", { confirm: "delete everything" });
  const st2 = await api("GET", "status");
  step("delete everything", del.json?.deleted === true && (st2.json?.vault?.sources ?? []).every((s) => s.days === 0), `receipts kept: ${del.json?.receipts_kept}`);
  const gone = await http("POST", "/v1/query", { bearer: ownerKey, cookies: false, body: { spec: { metrics: ["sleep_duration"], operation: "aggregate", window: { start: weekAgo, end: today }, params: { statistic: "mean" } } } });
  step("owner keys are revoked by delete", gone.status === 400 || gone.status === 401, `status=${gone.status}`);
  const lo = await http("POST", "/logout", {});
  step("sign out", lo.status === 303 && !jar.has("__Secure-aw_session"));
}

try {
  if (!BASE) await startServer();
  if (!SETUP) throw new Error("AW_SETUP_TOKEN is required with AW_BASE");
  console.log(`self-host e2e against ${BASE}`);
  await run();
} catch (e) {
  failures++;
  console.error(e instanceof Error ? e.message : e);
} finally {
  stopServer();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
