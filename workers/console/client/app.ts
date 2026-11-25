// Console client: sources and freshness, agents and grants, receipts, ask (owner, level 3), keys,
// and controls (pause, export, delete). Apple Health export.xml is parsed here, in the browser, as a
// stream; only normalized batches are uploaded. The raw file never leaves this page.
import { importAppleHealth } from "@askwearables/importers";
import { type CanonicalRecord, type Source, planWithRules, todayIn } from "@askwearables/core";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function call<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-aw-csrf": "1" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && j.login) { location.href = j.login; throw new Error("signed out"); }
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

function hoursAgo(iso: string | null): string {
  if (!iso) return "never";
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? "under an hour ago" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

async function render() {
  const s = await call("status");
  const tz = s.user?.tz ?? "UTC";
  $("#app").innerHTML = `
<section id="sources"><h2>Sources</h2>
 <p class="muted">Data version <code>${esc(String(s.vault.data_version).slice(0, 19))}</code>. Freshness and coverage per source.</p>
 <div class="scroll"><table><thead><tr><th>Source</th><th>Device</th><th>Last sync</th><th>Days</th><th>Coverage</th><th>Metrics</th></tr></thead><tbody>
 ${s.vault.sources.map((x: any) => `<tr><td>${esc(x.provider)}${x.terms_flags?.no_ai ? ' <span class="pill bad">no AI</span>' : ""}</td><td>${esc(x.device_model ?? x.device_class)}</td><td>${esc(hoursAgo(x.last_sync_at))}</td><td>${x.days} ${x.first_day ? `<span class="muted">${esc(x.first_day)} to ${esc(x.last_day)}</span>` : ""}</td><td>${x.mean_coverage === null ? "–" : Math.round(x.mean_coverage * 100) + "%"}</td><td>${esc(x.metrics.join(", "))}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No sources yet. Import a file below.</td></tr>`}
 </tbody></table></div>
 <h3>Import Apple Health</h3>
 <p class="muted">Health app → profile → Export All Health Data. Unzip it and choose <code>export.xml</code>. It is read on this device; only computed records are uploaded.</p>
 <div class="row"><input type="file" id="file" accept=".xml"><button class="primary" id="import">Import</button></div><p id="importmsg" class="muted"></p>
 <div class="row">Time zone <input id="tz" value="${esc(tz)}" size="24"><button id="savetz">Save</button></div>
</section>

<section id="grants"><h2>Agents with access</h2>
 <div class="scroll"><table><thead><tr><th>Agent</th><th>Purpose</th><th>Metrics</th><th>Level</th><th>Window</th><th>Per day</th><th>Expires</th><th></th></tr></thead><tbody>
 ${s.grants.map((g: any) => `<tr><td>${esc(g.agent_name)}${g.verified_domain ? `<br><span class="muted">${esc(g.verified_domain)}</span>` : ""}</td><td>${esc(g.purpose)}</td><td>${esc(g.metrics.join(", "))}</td><td>${g.max_level}</td><td>${g.max_window_days} d</td><td>${g.daily_packet_budget}</td><td>${esc(g.expires_at.slice(0, 10))}</td>
   <td>${g.revoked_at ? '<span class="muted">revoked</span>' : `<button class="danger" data-revoke="${esc(g.grant_id)}">Revoke</button>`}</td></tr>`).join("") || `<tr><td colspan="8" class="muted">No agents yet. Connect one with the MCP URL <code>https://mcp.askwearables.app/mcp</code>.</td></tr>`}
 </tbody></table></div>
</section>

<section id="receipts"><h2>Receipts</h2><p id="chain" class="muted"></p>
 <div class="scroll"><table><thead><tr><th>Time</th><th>Agent</th><th>Decision</th><th>Level</th><th>Metrics</th><th>Window</th><th>Reasons</th></tr></thead><tbody id="rtbody"></tbody></table></div>
 <div class="row"><button id="more">Older</button><a href="/api/export" download>Export everything</a></div>
</section>

<section id="ask"><h2>Ask (your own view, level 3)</h2>
 <div class="row"><input id="q" size="50" placeholder="How much did I sleep this week?"><button class="primary" id="askbtn">Ask</button></div><pre id="answer" class="muted">Questions are planned by fixed rules here; agents use the full planner.</pre>
</section>

<section id="keys"><h2>Keys</h2>
 <div class="row"><button id="ownerkey">New owner API key</button><button id="synckey">New phone sync key</button></div>
 <div class="row"><input id="org" placeholder="Organization"><input id="agentname" placeholder="Agent name"><input id="webhook" placeholder="Webhook URL (optional)" size="30"><button id="devkey">New developer key</button></div>
 <pre id="keyout" class="muted">Keys are shown once. Store them in a secrets manager.</pre>
</section>

<section id="controls"><h2>Controls</h2>
 <div class="row">Releases are <strong class="${s.vault.paused ? "bad" : "ok"}">${s.vault.paused ? "paused" : "on"}</strong>
  <button id="pause">${s.vault.paused ? "Resume releases" : "Pause all releases"}</button></div>
 <div class="row"><input id="confirm" placeholder="type: delete everything" size="24"><button class="danger" id="delete">Delete everything</button></div>
 <form method="post" action="https://auth.askwearables.app/logout"><button>Sign out</button></form>
</section>`;

  let before: number | undefined;
  const loadReceipts = async () => {
    const r = await call(`receipts?limit=50${before ? `&before=${before}` : ""}`);
    $("#chain").textContent = r.chain.ok ? `Hash chain intact: ${r.chain.count} receipts.` : `Hash chain broken at receipt ${r.chain.broken_at}.`;
    $("#rtbody").insertAdjacentHTML("beforeend", r.receipts.map((x: any) => `<tr><td>${esc(x.time.replace("T", " ").slice(0, 19))}</td><td>${esc(x.agent_id)}</td><td class="${x.decision === "released" ? "ok" : "bad"}">${esc(x.decision)}</td><td>${x.level ?? "–"}</td><td>${esc(x.metrics.join(", "))}</td><td>${x.window ? esc(`${x.window.start} to ${x.window.end}`) : ""}</td><td class="muted">${esc(x.reasons.join(", "))}</td></tr>`).join(""));
    before = r.receipts.at(-1)?.seq;
    ($("#more") as HTMLButtonElement).disabled = !before || before <= 1;
  };
  await loadReceipts();
  $("#more").onclick = loadReceipts;

  document.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Revoke this agent's access now?")) return;
    await call("revoke", { grant_id: b.dataset.revoke });
    render();
  }));
  $("#savetz").onclick = async () => { await call("tz", { tz: ($("#tz") as HTMLInputElement).value }); render(); };
  $("#pause").onclick = async () => { await call("pause", { paused: !s.vault.paused }); render(); };
  $("#delete").onclick = async () => {
    const c = ($("#confirm") as HTMLInputElement).value;
    if (c !== "delete everything") return alert('Type "delete everything" to confirm.');
    const r = await call("delete", { confirm: c });
    alert(r.deleted ? "Deleted. Receipt rows are kept without their contents." : r.reason);
    render();
  };
  $("#askbtn").onclick = async () => {
    const q = ($("#q") as HTMLInputElement).value;
    const plan = planWithRules(q, todayIn(tz, new Date()));
    if (!plan || plan.status !== "ok") { $("#answer").textContent = "That question is not covered by the console's rules. Try: how much did I sleep this week?"; return; }
    const r = await call("query", { spec: plan.spec });
    $("#answer").textContent = JSON.stringify({ ...r.packet, findings: r.packet.findings.map((f: any) => ({ ...f, raw: f.raw ? `[${Array.isArray(f.raw) ? f.raw.length : 1} raw items]` : undefined })) }, null, 2);
  };
  $("#ownerkey").onclick = async () => { const r = await call("keys", { kind: "owner" }); $("#keyout").textContent = `Owner API key (shown once):\n${r.key}`; };
  $("#synckey").onclick = async () => {
    const provider = prompt("Phone platform: apple_health or health_connect", "apple_health");
    if (!provider) return;
    const r = await call("keys", { kind: "sync", source: { provider, device_model: provider === "apple_health" ? "iPhone" : "Android", device_class: "phone", earliest_readable: null } });
    $("#keyout").textContent = `Sync key for ${provider} (shown once; paste into the phone app):\n${r.key}`;
  };
  $("#devkey").onclick = async () => {
    const r = await call("developer", { org: ($("#org") as HTMLInputElement).value || "My organization", agent: ($("#agentname") as HTMLInputElement).value || "My agent", webhook_url: ($("#webhook") as HTMLInputElement).value || undefined });
    $("#keyout").textContent = `Developer API key:\n${r.api_key}\nSigning secret:\n${r.signing_secret}${r.webhook_secret ? `\nWebhook secret:\n${r.webhook_secret}` : ""}\nAgent id: ${r.agent_id}\n(shown once)`;
  };
  $("#import").onclick = async () => {
    const f = ($("#file") as HTMLInputElement).files?.[0];
    if (!f) return;
    const msg = $("#importmsg");
    const sources = new Map<string, Source>();
    let sent = 0;
    try {
      for await (const batch of importAppleHealth(f.stream(), { batchSize: 2000 })) {
        for (const s of batch.sources) sources.set(s.id, s);
        const bySource = new Map<string, CanonicalRecord[]>();
        for (const r of batch.records) (bySource.get(r.source_id) ?? bySource.set(r.source_id, []).get(r.source_id)!).push(r);
        for (const [sid, recs] of bySource) {
          await call("import", { source: sources.get(sid), records: recs });
          sent += recs.length;
          msg.textContent = `Uploaded ${sent.toLocaleString()} records…`;
        }
      }
      msg.textContent = `Done: ${sent.toLocaleString()} records.`;
      render();
    } catch (e) {
      msg.textContent = `Stopped: ${(e as Error).message}`;
    }
  };
}

render().catch((e) => { $("#app").innerHTML = `<section><p class="bad">${esc(e.message)}</p></section>`; });
