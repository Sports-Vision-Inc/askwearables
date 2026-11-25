// The developer quickstart, end to end, against a running AskWearables API.
//
//   AW_API=https://api.askwearables.app AW_DEV_KEY=aw_dev_... AW_DEV_SIGNING_SECRET=awsig_... npx tsx scripts/quickstart.ts
//
// Optional:
//   AW_USER                       your end user's external id (default: quickstart-<random>)
//   AW_QUICKSTART_TIMEOUT         seconds to wait for consent approval (default 600)
//   AW_QUICKSTART_POLL            seconds between capability checks (default 5)
//   AW_QUICKSTART_SKIP_CONSENT=1  stop after printing the consent link
//
// Steps: create user -> check signing -> ingest synthetic records -> create consent link -> (user approves in a browser)
// -> poll /v1/capabilities until the grant appears (skipped if AW_USER already has one) -> ask -> query -> get packet -> usage.
// The records are synthetic, generated here; never put real health data in a test run.
import { AskWearables, AskWearablesError, type CanonicalRecord, type GrantRequest } from "../sdks/typescript/src/index.js";

const env = (k: string) => process.env[k]?.trim() || undefined;
let step = 0;
const log = (title: string) => console.log(`\n[${++step}] ${title}`);
const show = (v: unknown) => console.log(JSON.stringify(v, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
function fail(msg: string): never {
  console.error(`\nFAILED at step ${step}: ${msg}`);
  process.exit(1);
}

/** 35 days of synthetic sleep, resting heart rate and hourly steps for one watch, ending yesterday (UTC). */
function syntheticRecords(sourceId: string, now = new Date()): CanonicalRecord[] {
  const recs: CanonicalRecord[] = [];
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let seed = 7;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let d = 35; d >= 1; d--) {
    const dayStart = base - d * 86_400_000;
    const day = new Date(dayStart).toISOString().slice(0, 10);
    // The last three nights are shorter, so "compared to usual" has something to say.
    const sleepMin = Math.round((d <= 3 ? 380 : 450) + (rand() - 0.5) * 30);
    const wake = dayStart + 7 * 3_600_000;
    const bed = wake - (sleepMin + 20) * 60_000;
    recs.push({
      kind: "session", session_kind: "sleep", start: new Date(bed).toISOString(), end: new Date(wake).toISOString(), source_id: sourceId,
      external_id: `qs-sleep-${day}`, tz_offset_min: 0, is_main: true,
      detail: { deep_min: Math.round(sleepMin * 0.18), rem_min: Math.round(sleepMin * 0.22), light_min: sleepMin - Math.round(sleepMin * 0.18) - Math.round(sleepMin * 0.22), awake_min: 20, in_bed_min: sleepMin + 20 },
    });
    recs.push({
      kind: "sample", metric: "resting_hr", start: new Date(dayStart).toISOString(), end: new Date(dayStart + 86_399_000).toISOString(), value: 55 + Math.round((rand() - 0.5) * 4),
      unit: "bpm", source_id: sourceId, method: "vendor_daily", external_id: `qs-rhr-${day}`, tz_offset_min: 0,
    });
    for (let h = 0; h < 24; h++) {
      const steps = h < 7 || h > 22 ? 0 : Math.round(300 + rand() * 500);
      recs.push({
        kind: "sample", metric: "steps", start: new Date(dayStart + h * 3_600_000).toISOString(), end: new Date(dayStart + (h + 1) * 3_600_000).toISOString(), value: steps,
        unit: "count", source_id: sourceId, method: "measured", external_id: `qs-steps-${day}-${h}`, tz_offset_min: 0,
      });
    }
  }
  return recs;
}

async function main() {
  const baseUrl = env("AW_API") ?? fail("set AW_API to the API base URL, for example https://api.askwearables.app");
  const apiKey = env("AW_DEV_KEY") ?? fail("set AW_DEV_KEY to a developer key (aw_dev_...)");
  const signingSecret = env("AW_DEV_SIGNING_SECRET") ?? fail("set AW_DEV_SIGNING_SECRET to the key's signing secret");
  if (!apiKey.startsWith("aw_dev_")) fail("AW_DEV_KEY must be a developer key (aw_dev_...)");
  const user = env("AW_USER") ?? `quickstart-${crypto.randomUUID().slice(0, 8)}`;
  const timeoutS = Number(env("AW_QUICKSTART_TIMEOUT") ?? 600);
  const pollS = Number(env("AW_QUICKSTART_POLL") ?? 5);
  const skipConsent = env("AW_QUICKSTART_SKIP_CONSENT") === "1";
  if (!(timeoutS > 0) || !(pollS > 0)) fail("AW_QUICKSTART_TIMEOUT and AW_QUICKSTART_POLL must be positive numbers of seconds");

  const aw = new AskWearables({ baseUrl, apiKey, signingSecret, user });
  console.log(`AskWearables quickstart against ${aw.baseUrl} for user "${user}"`);

  log("Create the end user (POST /v1/users)");
  const created = await aw.createUser(user, { tz: "UTC" });
  show(created);
  if (created.user !== user) fail("the API returned a different user id");

  log("Check request signing (GET /v1/packets/{id} for a packet that does not exist)");
  // The gate verifies the signature before looking the packet up, so a bad secret fails here, not later.
  await aw.getPacket("pk_000000000000000000000000");
  console.log("    signature accepted");

  log("Push 35 days of synthetic records (POST /v1/ingest)");
  const records = syntheticRecords("quickstart:watch");
  const ing = await aw.ingest({ source: { id: "quickstart:watch", provider: "quickstart", device_class: "watch", device_model: "Synthetic watch" }, records });
  show({ sent: records.length, ...ing, rejected: ing.rejected.slice(0, 5) });
  if (ing.rejected.length) fail(`${ing.rejected.length} records were rejected`);
  if (ing.written + ing.unchanged !== records.length) fail("not every record was stored");

  let caps = await aw.capabilities();
  if (caps.grant) {
    log("This user already approved a grant for your agent: skipping the consent link");
  } else {
    log("Create a consent link (POST /v1/grants)");
    const request: GrantRequest = { purpose: "general_wellness", metrics: ["sleep_duration", "resting_hr", "steps"], max_level: 1, max_window_days: 30, daily_packet_budget: 20, days: 30 };
    show(request);
    const link = await aw.createGrantLink(request);
    console.log(`\n    Open this link in a browser and approve (it expires in ${Math.round(link.expires_in / 60)} minutes):\n\n    ${link.url}\n`);
    if (skipConsent) {
      console.log(`AW_QUICKSTART_SKIP_CONSENT=1: stopping after the consent link. Once approved, run again with AW_USER=${user} to continue.`);
      return;
    }

    log(`Wait for approval (polling GET /v1/capabilities every ${pollS}s, up to ${timeoutS}s)`);
    const deadline = Date.now() + timeoutS * 1000;
    while (!caps.grant) {
      if (Date.now() > deadline) fail(`no grant after ${timeoutS}s; approve the link above, or raise AW_QUICKSTART_TIMEOUT`);
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, pollS * 1000));
      caps = await aw.capabilities();
    }
    console.log();
  }
  const grant = caps.grant ?? fail("no grant");
  show(grant);

  log("Ask a question (POST /v1/ask, signed)");
  const question = "How did I sleep the last few nights compared to usual?";
  console.log(`    "${question}"`);
  const answer = await aw.ask(question);
  show(answer);
  if (answer.status !== "ok" || !answer.packet) fail(`expected status ok, got ${answer.status} ${JSON.stringify(answer.reasons ?? [])}`);
  if (answer.packet.not_medical_advice !== true) fail("packet is missing not_medical_advice");
  if (answer.packet.level > grant.max_level) fail("packet level is above the grant");

  log("Run a QuerySpec directly (POST /v1/query, signed)");
  const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
  const q = await aw.query({ metrics: ["resting_hr"], operation: "trend", window: { start, end } });
  show(q);
  if (q.status !== "ok") fail(`expected status ok, got ${q.status}`);

  log("Fetch the first packet again (GET /v1/packets/{id}, signed)");
  const again = await aw.getPacket(answer.packet.packet_id);
  if (!again || again.packet_id !== answer.packet.packet_id) fail("the packet could not be fetched again");
  console.log(`    ${again.packet_id} OK`);

  log("Check that a metric outside the grant is denied (POST /v1/query)");
  const denied = await aw.query({ metrics: ["hrv_rmssd"], operation: "trend", window: { start, end } });
  show(denied);
  if (denied.status !== "denied") fail("expected a denial for a metric outside the grant");

  log("Usage for your organization (GET /v1/usage)");
  show((await aw.usage()).slice(0, 3));

  console.log("\nQuickstart complete.");
}

main().catch((e) => {
  if (e instanceof AskWearablesError) fail(`${e.message} ${JSON.stringify(e.body)}`);
  fail(e instanceof Error ? e.message : String(e));
});
