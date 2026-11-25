// Renders workers/site/public/docs/api.html from the OpenAPI document. Called by scripts/gen-openapi.ts;
// workers/site/test/site.test.ts fails if the committed page is stale.

type Schema = Record<string, unknown>;
interface Op {
  operationId: string;
  summary?: string;
  parameters?: Schema[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, { description: string; content?: Record<string, { schema: Schema }> }>;
}
interface Doc {
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, Op>>;
  components: { securitySchemes: Record<string, Schema>; schemas: Record<string, Schema> };
}

/**
 * Which credential may call each operation, as the edge Worker routes them. The OpenAPI document has one
 * bearer scheme for all; this table adds who can use it. An operation missing here fails the build.
 */
const CALLERS: Record<string, string[]> = {
  ask: ["OAuth token", "aw_dev_ (signed)"],
  query: ["OAuth token", "aw_dev_ (signed)", "aw_own_ (level 3)"],
  capabilities: ["OAuth token", "aw_dev_ (signed)"],
  getPacket: ["OAuth token", "aw_dev_ (signed)"],
  receipts: ["aw_own_"],
  createGrantLink: ["aw_dev_"],
  revokeGrant: ["aw_own_"],
  createUser: ["aw_dev_"],
  ingest: ["aw_dev_", "aw_own_", "aw_sync_"],
  usage: ["aw_dev_"],
  export: ["aw_own_"],
};

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const code = (s: unknown) => `<code>${esc(s)}</code>`;
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const refName = (s: Schema) => (typeof s.$ref === "string" ? s.$ref.split("/").pop()! : null);

function typeOf(s: Schema | undefined): string {
  if (!s) return "any";
  const r = refName(s);
  if (r) return `<a href="#schema-${r}">${esc(r)}</a>`;
  if ("const" in s) return code(JSON.stringify(s.const));
  if (Array.isArray(s.type)) return esc(s.type.join(" | "));
  if (s.type === "array") return `${typeOf(s.items as Schema | undefined)}[]`;
  return esc(s.type ?? "any");
}

function constraints(s: Schema): string {
  const out: string[] = [];
  const items = (s.type === "array" ? (s.items as Schema | undefined) : undefined) ?? {};
  const en = (s.enum ?? items.enum) as unknown[] | undefined;
  if (en) out.push(`one of ${en.map((v) => code(typeof v === "string" ? v : JSON.stringify(v))).join(", ")}`);
  for (const [k, label] of [["minimum", "min"], ["maximum", "max"], ["minLength", "min length"], ["maxLength", "max length"], ["minItems", "min items"], ["maxItems", "max items"]] as const) {
    if (s[k] !== undefined) out.push(`${label} ${esc(s[k])}`);
  }
  if (typeof s.pattern === "string") out.push(`pattern ${code(s.pattern)}`);
  if (typeof s.format === "string") out.push(`format ${esc(s.format)}`);
  if (s.additionalProperties === false) out.push("no other keys");
  if (typeof s.description === "string") out.unshift(md(s.description));
  return out.join("; ");
}

/** Flatten an object schema into rows, descending into inline nested objects (params.comparator). */
function rows(s: Schema, prefix = ""): string[] {
  const props = (s.properties ?? {}) as Record<string, Schema>;
  const req = new Set((s.required as string[] | undefined) ?? []);
  const out: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    const name = prefix + k;
    out.push(`<tr><td>${code(name)}${req.has(k) ? ' <span class="req">required</span>' : ""}</td><td class="type">${typeOf(v)}</td><td class="wrap">${constraints(v)}</td></tr>`);
    if (!refName(v) && v.type === "object" && v.properties) out.push(...rows(v, `${name}.`));
  }
  return out;
}

function schemaTable(s: Schema): string {
  const r = rows(s);
  if (!r.length) return `<p class="type">${typeOf(s)}${s.type === "object" && !refName(s) ? " (free-form object)" : ""}</p>`;
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Notes</th></tr></thead><tbody>${r.join("")}</tbody></table></div>`;
}

function operation(path: string, method: string, op: Op): string {
  const callers = CALLERS[op.operationId];
  if (!callers) throw new Error(`render-api-docs: add ${op.operationId} to CALLERS`);
  const params = op.parameters ?? [];
  const signed = params.some((p) => p.name === "X-AskWearables-Signature");
  const visible = params.filter((p) => !/^X-AskWearables-(Timestamp|Nonce|Signature)$/.test(String(p.name)));
  const parts: string[] = [];
  parts.push(`<section class="op" id="op-${esc(op.operationId)}">`);
  parts.push(`<h3><span class="method ${esc(method)}">${esc(method.toUpperCase())}</span> ${esc(path)}</h3>`);
  if (op.summary) parts.push(`<p class="summary">${md(op.summary)}</p>`);
  parts.push(`<div class="tags"><span class="tag">operationId ${esc(op.operationId)}</span>${callers.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}${signed ? '<span class="tag signed">signed for developer keys</span>' : ""}</div>`);
  if (visible.length) {
    parts.push("<h4>Parameters</h4>");
    parts.push(`<div class="table-wrap"><table><thead><tr><th scope="col">Name</th><th scope="col">In</th><th scope="col">Type</th><th scope="col">Notes</th></tr></thead><tbody>${visible
      .map((p) => `<tr><td>${code(p.name)}${p.required ? ' <span class="req">required</span>' : ""}</td><td>${esc(p.in)}</td><td class="type">${typeOf(p.schema as Schema)}</td><td class="wrap">${p.description ? md(String(p.description)) : ""}</td></tr>`)
      .join("")}</tbody></table></div>`);
  }
  if (signed) parts.push(`<p class="muted"><small>With a developer key, also send <code>X-AskWearables-Timestamp</code>, <code>X-AskWearables-Nonce</code> and <code>X-AskWearables-Signature</code>; see <a href="/docs/quickstart#signing">signing</a>.</small></p>`);
  const body = op.requestBody?.content["application/json"]?.schema;
  if (body) {
    parts.push(`<h4>Request body${op.requestBody?.required ? ' <span class="req">required</span>' : ""}</h4>`);
    parts.push(refName(body) ? `<p>${typeOf(body)}</p>` : schemaTable(body));
  }
  parts.push("<h4>Responses</h4>");
  parts.push(`<div class="table-wrap"><table><thead><tr><th scope="col">Status</th><th scope="col">Description</th><th scope="col">Body</th></tr></thead><tbody>${Object.entries(op.responses)
    .map(([status, r]) => {
      const s = r.content?.["application/json"]?.schema;
      let shape = s ? typeOf(s) : "";
      if (s && !refName(s) && s.type === "object" && s.properties) shape = Object.keys(s.properties as object).map(code).join(", ");
      return `<tr><td>${esc(status)}</td><td>${esc(r.description)}</td><td class="type wrap">${shape}</td></tr>`;
    })
    .join("")}</tbody></table></div>`);
  parts.push("</section>");
  return parts.join("\n");
}

export function renderApiDocs(input: unknown): string {
  const doc = input as Doc;
  const ops: { path: string; method: string; op: Op }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(item)) ops.push({ path, method, op });
  const toc = ops.map(({ path, method, op }) => `<li><a href="#op-${esc(op.operationId)}"><span class="method ${esc(method)}">${esc(method.toUpperCase())}</span> ${esc(path)}</a></li>`).join("\n    ");
  const schemaToc = Object.keys(doc.components.schemas).map((n) => `<li><a href="#schema-${esc(n)}">${esc(n)}</a></li>`).join("\n    ");
  const bearer = doc.components.securitySchemes.bearer ?? {};

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API reference · AskWearables</title>
<meta name="description" content="Every REST endpoint of the AskWearables API, generated from its OpenAPI ${esc(doc.info.version)} document.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#f7f6f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121211" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<!-- Generated by scripts/gen-openapi.ts from the OpenAPI document. Do not edit by hand. -->
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="inner">
  <div class="lockup">
    <a class="brand" href="/"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect class="bm-tile" width="32" height="32" rx="8"/><path class="bm-glyph" d="M5.9 23.5 10.5 8.5l4.6 15 3.2-10.5 3.2 10.5 4.6-15" stroke-width="2.8" stroke-linejoin="bevel"/><path class="bm-glyph" d="M7.4 18.6h6.3" stroke-width="2.4"/></svg><span class="brand-name">AskWearables</span></a>
    <a class="parent" href="https://www.sportsvision.ai"><span class="parent-by">by</span><picture class="sv-logo"><source srcset="/assets/brand/sportsvision-logo-white.png" media="(prefers-color-scheme: dark)"><img src="/assets/brand/sportsvision-logo-black.png" alt="SportsVision" width="70" height="15"></picture></a>
  </div>
  <nav class="site-nav" aria-label="Main">
    <a href="/docs/">Docs</a>
    <a href="/docs/quickstart">Quickstart</a>
    <a href="/results">Results</a>
    <a href="/docs/api" aria-current="page">API</a>
    <a href="https://app.askwearables.app/">Console</a>
  </nav>
</div></header>

<div class="docs">
<nav class="docs-nav" aria-label="Documentation">
  <h2>Docs</h2>
  <ul>
    <li><a href="/docs/">Overview</a></li>
    <li><a href="/docs/quickstart">Quickstart</a></li>
    <li><a href="/docs/packets">Packets and levels</a></li>
    <li><a href="/docs/privacy">Privacy model</a></li>
    <li><a href="/docs/api" aria-current="page">API reference</a></li>
    <li><a href="/docs/self-hosting">Self-hosting</a></li>
    <li><a href="/results">Study results</a></li>
  </ul>
  <h2>Files</h2>
  <ul>
    <li><a href="/openapi.json">openapi.json</a></li>
    <li><a href="/privacy">Privacy policy (draft)</a></li>
    <li><a href="/terms">Terms of service (draft)</a></li>
  </ul>
</nav>

<main id="main">
<h1>API reference</h1>
<p>${md(doc.info.description)}</p>
<div class="table-wrap"><table><tbody>
  <tr><th scope="row">Base URL</th><td>${doc.servers.map((s) => code(s.url)).join(", ")}</td></tr>
  <tr><th scope="row">Version</th><td>${esc(doc.info.title)} ${esc(doc.info.version)}, OpenAPI ${esc((input as { openapi: string }).openapi)}</td></tr>
  <tr><th scope="row">Authentication</th><td>${md(String(bearer.description ?? "Bearer token"))}</td></tr>
  <tr><th scope="row">Machine-readable</th><td><a href="/openapi.json">openapi.json</a></td></tr>
</tbody></table></div>
<p>Each endpoint lists the credentials that can call it. Errors and gate decisions are described in the <a href="/docs/#errors">overview</a>, and the packet in <a href="/docs/packets">packets and levels</a>.</p>

<div class="toc">
  <strong>Endpoints</strong>
  <ul>
    ${toc}
  </ul>
  <strong>Schemas</strong>
  <ul>
    ${schemaToc}
  </ul>
</div>

<h2 id="endpoints">Endpoints</h2>
${ops.map(({ path, method, op }) => operation(path, method, op)).join("\n")}

<h2 id="schemas">Schemas</h2>
${Object.entries(doc.components.schemas).map(([name, s]) => `<section class="op" id="schema-${esc(name)}">\n<h3>${esc(name)}</h3>\n${schemaTable(s)}\n</section>`).join("\n")}

<div class="pager"><a href="/docs/privacy">← Privacy model</a><a href="/docs/self-hosting">Next: Self-hosting →</a></div>
</main>
</div>

<footer class="site-footer"><div class="inner">
  <div class="foot-brand">
    <a class="foot-parent" href="https://www.sportsvision.ai"><picture class="sv-logo"><source srcset="/assets/brand/sportsvision-logo-white.png" media="(prefers-color-scheme: dark)"><img src="/assets/brand/sportsvision-logo-black.png" alt="SportsVision" width="112" height="24"></picture></a>
    <p class="foot-line">AskWearables is a SportsVision product.</p>
    <p class="foot-legal"><span>© 2026 Sports Vision, Inc.</span> <a href="/terms">Terms of service</a> <a href="/privacy">Privacy policy</a> <a href="/privacy#consumer-health-data">Consumer health data</a> <a href="/credits">Open-source credits</a> <a href="https://www.sportsvision.ai">sportsvision.ai</a></p>
  </div>
  <span>AskWearables. Wellness information only; not medical advice.</span>
  <nav aria-label="Footer">
    <a href="/docs/">Docs</a>
    <a href="/results">Results</a>
    <a href="/docs/api">API reference</a>
    <a href="/openapi.json">OpenAPI</a>
  </nav>
</div></footer>
</body>
</html>
`;
}
