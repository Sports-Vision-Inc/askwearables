// End-to-end check against a running system (local wrangler dev or production).
// Env: AW_BASE (REST base, e.g. http://localhost:8787 or https://api.askwearables.app), AW_OWNER_KEY.
// Optional: AW_GRANT_SQL_CMD for local runs, to approve the consent link without a browser.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const BASE = process.env.AW_BASE ?? "http://localhost:8787";
const OWNER = process.env.AW_OWNER_KEY;
if (!OWNER) throw new Error("AW_OWNER_KEY is required");
let failures = 0;
const EXT = `e2e-user-${randomBytes(4).toString("hex")}`;
process.env.AW_E2E_USER = EXT;
const step = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); if (!ok) failures++; };

async function call(method, path, key, body, extraHeaders = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extraHeaders }, body: raw || undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { text }; }
  return { status: res.status, json };
}

function signed(secret, method, path, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body === undefined ? "" : JSON.stringify(body)).digest("hex");
  const sig = createHmac("sha256", secret).update([ts, nonce, method, path, bodyHash].join("\n")).digest("hex");
  return { "x-askwearables-timestamp": ts, "x-askwearables-nonce": nonce, "x-askwearables-signature": sig };
}

// Synthetic owner data: 60 days of sleep and resting HR, no real person.
function synth(sourceId, days, startDay) {
  const recs = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(`${startDay}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    const sleep = 400 + ((i * 37) % 50) - (i >= days - 3 ? 90 : 0);
    const wake = `${d}T07:00:00.000Z`;
    recs.push({ kind: "session", session_kind: "sleep", start: new Date(Date.parse(wake) - (sleep + 20) * 60000).toISOString(), end: wake, source_id: sourceId, external_id: `sl-${d}`, tz_offset_min: 0, is_main: true, detail: { deep_min: Math.round(sleep * 0.2), rem_min: Math.round(sleep * 0.2), light_min: sleep - 2 * Math.round(sleep * 0.2), awake_min: 20, in_bed_min: sleep + 20 } });
    recs.push({ kind: "sample", metric: "resting_hr", start: `${d}T00:00:00.000Z`, end: `${d}T23:59:00.000Z`, value: 54 + (i % 5), unit: "bpm", source_id: sourceId, method: "vendor_daily", external_id: `rhr-${d}`, tz_offset_min: 0 });
    for (let h = 8; h < 21; h++) recs.push({ kind: "sample", metric: "steps", start: `${d}T${String(h).padStart(2, "0")}:00:00.000Z`, end: `${d}T${String(h).padStart(2, "0")}:59:00.000Z`, value: 500 + ((i * h) % 300), unit: "count", source_id: sourceId, method: "measured", external_id: `st-${d}-${h}`, tz_offset_min: 0 });
  }
  return recs;
}

const today = new Date().toISOString().slice(0, 10);
const start = new Date(Date.now() - 59 * 86400000).toISOString().slice(0, 10);

// 1. Owner ingests and queries at level 3.
const source = { id: "e2e_watch", provider: "e2e_synthetic", device_model: "Synthetic Watch", device_class: "watch", connected_at: `${start}T00:00:00Z`, earliest_readable: start, last_sync_at: null, terms_flags: {} };
const recs = synth("e2e_watch", 60, start);
let written = 0;
for (let i = 0; i < recs.length; i += 2000) {
  const r = await call("POST", "/v1/ingest", OWNER, { source, records: recs.slice(i, i + 2000) });
  if (r.status !== 200) { step("owner ingest", false, JSON.stringify(r.json)); break; }
  written += r.json.written;
}
step("owner ingest", written >= 0 && !failures, `${written} new records written`);
const again = await call("POST", "/v1/ingest", OWNER, { source, records: recs.slice(0, 2000) });
step("re-ingest is idempotent", again.json.written === 0, `written=${again.json.written}`);
const oq = await call("POST", "/v1/query", OWNER, { spec: { metrics: ["sleep_duration"], operation: "aggregate", window: { start: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10), end: today }, params: { statistic: "mean" } } });
step("owner query at level 3", oq.json.packet?.level === 3, oq.json.packet?.findings?.[0]?.statement ?? JSON.stringify(oq.json));

// 2. Developer flow.
const dev = await call("POST", "/v1/developer", OWNER, { org: "E2E org", agent: "E2E agent" });
step("developer key created", !!dev.json.api_key);
const DK = dev.json.api_key, SS = dev.json.signing_secret;
const u = await call("POST", "/v1/users", DK, { external_id: EXT });
step("developer creates user", u.status === 200, JSON.stringify(u.json));
const devSource = { ...source, id: "dev_watch", provider: "e2e_synthetic" };
const di = await call("POST", "/v1/ingest", DK, { source: devSource, records: synth("dev_watch", 60, start) .slice(0, 2000) }, { "x-askwearables-user": EXT });
step("developer ingests for user", di.status === 200, `written=${di.json.written}`);
const link = await call("POST", "/v1/grants", DK, { purpose: "sleep_coaching", metrics: ["sleep_duration", "resting_hr"], max_level: 1, max_window_days: 14, daily_packet_budget: 5, days: 30 }, { "x-askwearables-user": EXT });
step("consent link created", typeof link.json.url === "string", link.json.url ?? JSON.stringify(link.json));

// Unsigned or ungranted requests must not release anything.
const unsigned = await call("POST", "/v1/ask", DK, { question: "How did I sleep this week?" }, { "x-askwearables-user": EXT });
step("unsigned developer request is refused", unsigned.json.status === "denied", JSON.stringify(unsigned.json.reasons));
const beforeConsent = await call("POST", "/v1/ask", DK, { question: "How did I sleep this week?" }, { "x-askwearables-user": EXT, ...signed(SS, "POST", "/v1/ask", { question: "How did I sleep this week?" }) });
step("no grant yet: denied", beforeConsent.json.status === "denied", JSON.stringify(beforeConsent.json.reasons));

if (process.env.AW_APPROVE_CMD) {
  execSync(process.env.AW_APPROVE_CMD, { stdio: "inherit" });
} else {
  console.log(`Approve the grant in a browser, then press Enter: ${link.json.url}`);
  await new Promise((r) => process.stdin.once("data", r));
}

const q = { question: "Am I sleeping less than usual?" };
const ask = await call("POST", "/v1/ask", DK, q, { "x-askwearables-user": EXT, ...signed(SS, "POST", "/v1/ask", q) });
step("signed ask after consent releases a level-1 packet", ask.json.status === "ok" && ask.json.packet.level <= 1, ask.json.packet?.findings?.[0]?.statement ?? JSON.stringify(ask.json));
step("level-1 packet carries no values", !!ask.json.packet && ask.json.packet.findings.every((f) => f.value === undefined && f.values === undefined));
const h = signed(SS, "POST", "/v1/ask", q);
await call("POST", "/v1/ask", DK, q, { "x-askwearables-user": EXT, ...h });
const replay = await call("POST", "/v1/ask", DK, q, { "x-askwearables-user": EXT, ...h });
step("replayed nonce is refused", replay.json.status === "denied" && replay.json.reasons?.includes("nonce_replayed"), JSON.stringify(replay.json.reasons));
const wq = { question: "What is my weight?" };
const weight = await call("POST", "/v1/ask", DK, wq, { "x-askwearables-user": EXT, ...signed(SS, "POST", "/v1/ask", wq) });
step("ungranted metric is denied with a reason", weight.json.status === "denied" && weight.json.reasons?.some((r) => r.startsWith("metric_not_in_grant")), JSON.stringify(weight.json.reasons));
let budgetHit = false;
for (let i = 0; i < 6; i++) {
  const r = await call("POST", "/v1/ask", DK, q, { "x-askwearables-user": EXT, ...signed(SS, "POST", "/v1/ask", q) });
  if (r.json.reasons?.includes("budget_exhausted")) { budgetHit = true; break; }
}
step("daily budget stops further releases", budgetHit);

// 3. Receipts
const rc = await call("GET", "/v1/receipts?limit=5", OWNER);
step("owner receipts chain intact", rc.json.chain?.ok === true, `count=${rc.json.chain?.count}`);
const usage = await call("GET", "/v1/usage", DK);
step("developer usage metered", Array.isArray(usage.json) && usage.json.length > 0, JSON.stringify(usage.json[0] ?? {}));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
