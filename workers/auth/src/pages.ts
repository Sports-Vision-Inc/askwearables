// HTML for sign-in and the consent screen. Everything that came from a client is escaped.
import { CATALOGUE, PUBLIC_METRIC_IDS, PURPOSE_POLICY, PURPOSES, SENSITIVE_METRIC_IDS } from "@askwearables/core";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#f7f7f5;--fg:#1b1d1f;--muted:#5d6168;--card:#fff;--line:#dfe1e4;--accent:#2457d6;--warn:#9a3b00;--ok:#1f7a3a}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#ececec;--muted:#a3a7ad;--card:#1b1d20;--line:#2d3035;--accent:#7aa2ff;--warn:#ffb37a;--ok:#7ad29a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.5rem;margin:.2em 0 .6em}h2{font-size:1.05rem;margin:1.6em 0 .4em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}
.muted{color:var(--muted)}.warn{color:var(--warn)}label{display:block;margin:.25em 0}fieldset{border:0;padding:0;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:2px 16px}
input[type=number],input[type=date],select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;padding:10px 18px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.example{font-style:italic;padding:8px 12px;border-left:3px solid var(--accent);margin:6px 0;min-height:1.5em}
ul.no li{margin:.2em 0}code{font-size:.9em}`;

export function page(title: string, body: string, opts: { nonce?: string; scripts?: string[] } = {}): string {
  const scripts = (opts.scripts ?? []).map((s) => `<script nonce="${opts.nonce ?? ""}">${s}</script>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>${scripts}</body></html>`;
}

export function securityHeaders(nonce: string, extraScriptSrc = ""): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${extraScriptSrc}; connect-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'`,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

/** Served by this Worker (vendored), so no third-party CDN sees sign-in traffic. */
export const WEBAUTHN_BROWSER = "/static/webauthn-browser.js";

/** The version of the Terms and Privacy Policy shown at sign-up. Bump when either changes materially. */
export const TERMS_VERSION = "2026-11-25";

export function loginPage(next: string, nonce: string, setupToken?: string): string {
  const setup = !!setupToken;
  const body = `<h1>${setup ? "Set up AskWearables" : "Sign in to AskWearables"}</h1>
<div class="card"><p>${setup ? "Create the owner account with a passkey on this device." : "Use your passkey."}</p>
${setup ? `<label class="row"><input type="checkbox" id="accept"> <span>I am 18 or older, and I accept the <a href="https://askwearables.app/terms" target="_blank" rel="noopener">Terms of Service</a> and the <a href="https://askwearables.app/privacy" target="_blank" rel="noopener">Privacy Policy</a> (version ${TERMS_VERSION}).</span></label>` : ""}
<p class="row"><button class="primary" id="go">${setup ? "Create passkey" : "Sign in with a passkey"}</button></p>
<p id="msg" class="muted"></p></div>`;
  const script = `
const next=${JSON.stringify(next)};const setup=${JSON.stringify(setupToken ?? null)};
const msg=t=>document.getElementById('msg').textContent=t;
document.getElementById('go').onclick=async()=>{try{
 const W=window.SimpleWebAuthnBrowser;
 if(setup&&!document.getElementById('accept').checked)return msg('Please confirm you are 18 or older and accept the Terms and Privacy Policy.');
 if(setup){const o=await (await fetch('/webauthn/register/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setup})})).json();
  if(o.error)return msg(o.error);const r=await W.startRegistration({optionsJSON:o});
  const v=await (await fetch('/webauthn/register/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setup,response:r,accepted:true})})).json();
  if(!v.ok)return msg(v.error||'Registration failed');location.href=next;}
 else{const o=await (await fetch('/webauthn/auth/options',{method:'POST'})).json();const r=await W.startAuthentication({optionsJSON:o});
  const v=await (await fetch('/webauthn/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({response:r})})).json();
  if(!v.ok)return msg(v.error||'Sign-in failed');location.href=next;}
}catch(e){msg(String(e&&e.message||e))}};`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><style>${CSS}</style><script nonce="${nonce}" src="${WEBAUTHN_BROWSER}"></script></head><body><main>${body}</main><script nonce="${nonce}">${script}</script></body></html>`;
}

export interface ConsentView {
  agentName: string;
  agentDomain: string | null;
  registeredBy: string;
  redirectHost: string | null;
  redirectIsLoopback: boolean;
  handle: string;
  postTo: string;
  exampleUrl: string;
  /** Developer consent links: what the developer asked for. The user can only narrow it. */
  requested?: { purpose: string; metrics: string[]; max_level: number; max_window_days: number; daily_packet_budget: number; days: number };
  today: string;
}

/** The consent screen: one grant, all eight items, in plain words. Nothing is pre-ticked. */
export function consentPage(v: ConsentView, nonce: string): string {
  const r = v.requested;
  const maxExpiry = new Date(Date.parse(`${v.today}T00:00:00Z`) + 90 * 86_400_000).toISOString().slice(0, 10);
  const defExpiry = new Date(Date.parse(`${v.today}T00:00:00Z`) + (r ? Math.min(90, r.days) : 30) * 86_400_000).toISOString().slice(0, 10);
  const metricList = r ? PUBLIC_METRIC_IDS.filter((m) => r.metrics.includes(m)) : PUBLIC_METRIC_IDS;
  const purposes = r ? PURPOSES.filter((p) => p === r.purpose) : PURPOSES;
  const levels = [
    [0, "Flag only", "yes, no or unknown"],
    [1, "Trend", "direction and size against your usual range, no numbers"],
    [2, "Daily values", "one number per day, with units"],
    [3, "Raw", "individual samples and session detail"],
  ] as const;
  const maxLevel = r ? r.max_level : 3;
  const body = `
<h1>Allow ${esc(v.agentName)} to ask about your wearable data?</h1>
<form method="post" action="${esc(v.postTo)}">
<input type="hidden" name="handle" value="${esc(v.handle)}">

<div class="card"><h2>1. Which agent</h2>
<p><strong>${esc(v.agentName)}</strong>. ${v.agentDomain ? `Verified domain: <strong>${esc(v.agentDomain)}</strong>.` : `<span class="warn">This agent registered itself; its name is not verified.</span>`}
Registered by: ${esc(v.registeredBy)}.</p>
${v.redirectHost ? `<p>Access will be sent to <strong>${esc(v.redirectHost)}</strong>.</p>` : ""}
${v.redirectIsLoopback ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>` : ""}
</div>

<div class="card"><h2>2. For what purpose</h2>
<select name="purpose" required>${purposes.map((p) => `<option value="${p}">${esc(PURPOSE_POLICY[p].label)}</option>`).join("")}</select>
<p class="muted">The purpose is fixed here. The agent cannot change it later in a request.</p></div>

<div class="card"><h2>3. Which metrics</h2><p class="muted">Tick each one you allow. Nothing is ticked for you.</p>
<fieldset class="grid">${metricList.map((m) => `<label><input type="checkbox" name="metric" value="${m}" data-metric> ${esc(CATALOGUE[m].label)}</label>`).join("")}</fieldset>
${r ? "" : `<details><summary>Sensitive categories</summary><p class="muted">Excluded unless you name each one here.</p>
<fieldset class="grid">${SENSITIVE_METRIC_IDS.map((m) => `<label><input type="checkbox" name="sensitive" value="${m}"> ${esc(CATALOGUE[m].label)}</label>`).join("")}</fieldset></details>`}
</div>

<div class="card"><h2>4. How much detail</h2>
<fieldset>${levels.filter(([l]) => l <= maxLevel).map(([l, name, what]) => `<label><input type="radio" name="max_level" value="${l}" ${l === Math.min(1, maxLevel) ? "checked" : ""} data-level> <strong>${name}</strong>: ${what}</label>`).join("")}</fieldset>
<p class="muted">Example from your own recent data at this level:</p><div class="example" id="example">Tick a metric to see an example.</div></div>

<div class="card"><h2>5. How far back</h2>
<label><input type="number" name="max_window_days" min="1" max="${r ? r.max_window_days : 365}" value="${r ? r.max_window_days : 14}" required> days</label></div>

<div class="card"><h2>6. How often</h2>
<label><input type="number" name="daily_packet_budget" min="1" max="${r ? r.daily_packet_budget : 200}" value="${r ? r.daily_packet_budget : 20}" required> answers per day at most</label>
<p class="muted">Only released answers count. This stops many small questions from rebuilding your daily data.</p></div>

<div class="card"><h2>7. Until when</h2>
<label><input type="date" name="expires" min="${v.today}" max="${maxExpiry}" value="${defExpiry}" required> (90 days at most)</label></div>

<div class="card"><h2>8. What is not approved</h2>
<ul class="no"><li>Raw data, unless you chose Raw above</li><li>Any metric you did not tick</li><li>Sensitive categories you did not name</li>
<li>Any change to your data: this is read-only</li><li>Passing your data to another agent</li><li>Anything older than the window above</li></ul>
<p class="muted">You approve the boundary, not each question. Every answer released is recorded in your receipt log, where you can revoke this agent at any time.
Once an answer is released, what ${esc(v.agentName)}'s provider stores is outside AskWearables.</p></div>

<p class="muted">By allowing, you agree that AskWearables shares data with this agent as described above, under the <a href="https://askwearables.app/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="https://askwearables.app/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>
<p class="row"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>
</form>`;
  const script = `
const ex=document.getElementById('example');const url=${JSON.stringify(v.exampleUrl)};
async function upd(){const m=[...document.querySelectorAll('[data-metric]:checked')].map(x=>x.value)[0];
 const l=(document.querySelector('[data-level]:checked')||{}).value||'1';
 if(!m){ex.textContent='Tick a metric to see an example.';return;}
 if(l==='3'){ex.textContent='Raw: individual samples, for example every heart-rate reading in a workout.';return;}
 try{const r=await fetch(url+'?metric='+encodeURIComponent(m)+'&level='+l);const j=await r.json();ex.textContent=j.example||'Not enough recent data for an example yet.';}catch{ex.textContent='';}}
document.querySelectorAll('[data-metric],[data-level]').forEach(e=>e.addEventListener('change',upd));`;
  return page(`Allow ${v.agentName}?`, body, { nonce, scripts: [script] });
}

export function messagePage(title: string, text: string): string {
  return page(title, `<h1>${esc(title)}</h1><div class="card"><p>${esc(text)}</p></div>`);
}
