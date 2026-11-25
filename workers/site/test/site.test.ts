import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openapi } from "../../edge/src/openapi.js";
import { renderApiDocs } from "../../../scripts/render-api-docs.js";
import site, { SECURITY_HEADERS } from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = (status = 200, body = "<!doctype html>") => ({ ASSETS: { fetch: async () => new Response(body, { status, headers: { "content-type": "text/html" } }) } as unknown as Fetcher });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

describe("site worker", () => {
  it("serves assets with the security headers, including on 404", async () => {
    for (const status of [200, 404]) {
      const res = await site.fetch(new Request("https://askwearables.app/docs/"), env(status));
      expect(res.status).toBe(status);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k)).toBe(v);
    }
    const res = await site.fetch(new Request("https://askwearables.app/"), env());
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(res.headers.get("content-security-policy")).not.toMatch(/unsafe-(inline|eval)/);
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
  });

  it("refuses writes and lets tools read openapi.json cross-origin", async () => {
    expect((await site.fetch(new Request("https://askwearables.app/", { method: "POST" }), env())).status).toBe(405);
    const o = await site.fetch(new Request("https://askwearables.app/openapi.json"), env());
    expect(o.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("has no bindings besides static assets", () => {
    const cfg = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
    for (const k of ["d1_databases", "kv_namespaces", "r2_buckets", "durable_objects", "services", "queues", "ai", "vars", "secrets_store_secrets"]) expect(cfg[k], k).toBeUndefined();
    expect(cfg.assets.binding).toBe("ASSETS");
  });

  it("pages load no inline or third-party scripts and nothing from other origins", () => {
    const html = walk(join(root, "public")).filter((f) => f.endsWith(".html"));
    expect(html.length).toBeGreaterThanOrEqual(10);
    for (const f of html) {
      const s = readFileSync(f, "utf8");
      // The only script form allowed: an empty element loading a same-origin file under /js/.
      for (const m of s.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)) expect(m[0], f).toMatch(/^<script src="\/js\/[a-z0-9-]+\.js" defer><\/script>$/);
      expect(s.replace(/<script src="\/js\/[a-z0-9-]+\.js" defer><\/script>/g, ""), f).not.toMatch(/<script/i);
      for (const m of s.matchAll(/<script src="(\/js\/[^"]+)"/g)) expect(statSync(join(root, "public", m[1]!)).isFile(), m[1]).toBe(true);
      expect(s, f).not.toMatch(/\son[a-z]+=/i);
      expect(s, f).not.toMatch(/style="/i);
      expect(s, f).not.toMatch(/<(link|img|iframe)[^>]+(href|src)="https?:/i);
      expect(s, f).toMatch(/<meta name="viewport"/);
    }
  });

  it("scripts build the DOM safely and only read this origin's data", () => {
    const js = walk(join(root, "public")).filter((f) => f.endsWith(".js"));
    expect(js.length).toBeGreaterThan(0);
    for (const f of js) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b|new Function|setAttribute\(\s*["']style/);
      for (const m of s.matchAll(/fetch\(\s*["'`]([^"'`]+)/g)) expect(m[1], f).toMatch(/^\/data\//);
    }
  });

  it("ships the study results the explorer reads, with no hard-coded numbers to drift", () => {
    const d = JSON.parse(readFileSync(join(root, "public/data/results.json"), "utf8"));
    for (const k of ["conditions", "accuracy", "by_trap", "by_question", "privacy", "efficiency", "examples"]) expect(d[k], k).toBeDefined();
    expect(Object.keys(d.conditions)).toEqual(["A_raw", "B_tools", "C_broker"]);
    expect(d.accuracy.length).toBeGreaterThan(0);
    for (const a of d.accuracy) {
      expect(a.correct).toBeLessThanOrEqual(a.n);
      expect(a.ci[0]).toBeLessThanOrEqual(a.rate);
      expect(a.ci[1]).toBeGreaterThanOrEqual(a.rate - 1e-9);
    }
    // Charts are filled from the JSON: the results page itself holds no result percentages.
    const page = readFileSync(join(root, "public/results.html"), "utf8");
    const charts = page.slice(page.indexOf('id="tiles"'), page.indexOf('id="methodology"'));
    expect(charts.replace(/95% (intervals?|CI)/g, "")).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("plays curated real examples on the landing page, with nothing hard-coded", () => {
    const d = JSON.parse(readFileSync(join(root, "public/data/results.json"), "utf8"));
    const f = JSON.parse(readFileSync(join(root, "public/data/featured.json"), "utf8"));
    const byId = new Map(d.examples.map((x: { id: string }) => [x.id, x]));
    expect(byId.size).toBe(d.examples.length); // ids are unique
    expect(f.examples.length).toBeGreaterThanOrEqual(4);
    expect(f.examples.length).toBeLessThanOrEqual(6);
    const traps = new Set<string>(), questions = new Set<string>();
    for (const it of f.examples) {
      const x = byId.get(it.id) as { trap: string; question: string; runs: Record<string, { correct: boolean; asked?: string[] }> } | undefined;
      expect(x, it.id).toBeDefined();
      // Each pick shows AskWearables right where another route was wrong, and the question the agent sent.
      expect(x!.runs.C_broker!.correct, it.id).toBe(true);
      expect(!x!.runs.A_raw!.correct || !x!.runs.B_tools!.correct, it.id).toBe(true);
      expect(x!.runs.C_broker!.asked?.length, it.id).toBeGreaterThan(0);
      expect(statSync(join(root, "public/assets/emoji/twemoji", `${it.emoji}.svg`)).isFile(), it.emoji).toBe(true);
      // The framing copy carries no numbers, so it cannot drift from the data.
      expect(`${it.title} ${it.why}`, it.id).not.toMatch(/\d/);
      traps.add(x!.trap);
      questions.add(x!.question);
    }
    for (const t of ["two_step_sources", "missing_days", "stale_sync", "device_switch"]) expect(traps.has(t), t).toBe(true);
    expect(questions.has("hrv_trend_28d")).toBe(true);
    // The hero and the context-size section are filled from JSON: their markup holds no digits.
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    for (const [a, b] of [['id="walk"', "</figure>"], ['id="sees-box"', "</section>"]] as const) {
      const i = page.indexOf(a);
      expect(i, a).toBeGreaterThan(0);
      expect(page.slice(i, page.indexOf(b, i)).replace(/<[^>]+>/g, " "), a).not.toMatch(/\d/);
    }
    expect(page).toContain('data-chart="accuracy-cost"');
    expect(readFileSync(join(root, "public/results.html"), "utf8")).toContain('data-chart="accuracy-cost"');
  });

  it("ships the exposure, export sample, model groups and costs the landing charts read", () => {
    const d = JSON.parse(readFileSync(join(root, "public/data/results.json"), "utf8"));
    for (const c of ["A_raw", "B_tools", "C_broker"]) expect(d.exposure_median_chars[c], c).toBeGreaterThan(0);
    expect(d.exposure_median_chars.A_raw).toBeGreaterThan(d.exposure_median_chars.C_broker);
    expect(d.export_sample.lines.length).toBeGreaterThan(20);
    expect(d.export_sample.lines[0]).toMatch(/^date,/);
    const groups = new Set(Object.values(d.models).map((m) => (m as { group: string }).group));
    for (const g of ["open", "frontier"]) expect(groups.has(g), g).toBe(true);
    for (const e of d.efficiency) {
      expect(d.models[e.model], e.model).toBeDefined();
      if (d.models[e.model].group !== "free") expect(e.cost_per_correct_usd, `${e.model} ${e.condition}`).toBeGreaterThan(0);
    }
  });

  it("self-hosts open-source icons and emoji with their licences and credits them", () => {
    const assets = join(root, "public/assets");
    expect(readFileSync(join(assets, "icons/lucide/LICENSE.txt"), "utf8")).toMatch(/ISC License/);
    expect(readFileSync(join(assets, "emoji/twemoji/LICENSE.txt"), "utf8")).toMatch(/Attribution 4\.0 International/);
    for (const f of walk(assets).filter((x) => x.endsWith(".svg"))) {
      const svg = readFileSync(f, "utf8");
      expect(svg, f).toMatch(/^<svg/);
      expect(svg, f).not.toMatch(/<script|\son[a-z]+=|href=|https?:\/\/(?!www\.w3\.org)/i);
    }
    const css = readFileSync(join(root, "public/style.css"), "utf8");
    for (const m of css.matchAll(/url\("?([^")]+)"?\)/g)) {
      expect(m[1], "no third-party CSS assets").toMatch(/^\//);
      expect(statSync(join(root, "public", m[1]!)).isFile(), m[1]).toBe(true);
    }
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    for (const m of page.matchAll(/src="(\/assets\/[^"]+)"/g)) expect(statSync(join(root, "public", m[1]!)).isFile(), m[1]).toBe(true);
    expect(page).toMatch(/Lucide[\s\S]*ISC[\s\S]*Twemoji[\s\S]*CC-BY 4\.0/);
  });

  it("gives every animation a reduced-motion fallback", () => {
    const css = readFileSync(join(root, "public/style.css"), "utf8");
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n?\}\s*(?=\n|$)/g)].map((m) => m[1]).join("\n");
    // Each keyframes animation is used only by elements a reduced-motion rule switches off.
    const users = [...css.matchAll(/([^{}]+)\{[^}]*\banimation:\s*([a-z-]+)/g)].map((m) => ({ sel: m[1]!.trim(), name: m[2]! })).filter((u) => u.name !== "none");
    expect(users.length).toBeGreaterThan(0);
    // The landing animations live inside .walk and .sees, which one reduced-motion rule stills; anything else is named.
    const blanket = /\.walk \*[\s\S]*\.sees \*[\s\S]*animation: none !important/.test(reduced);
    const LANDING = /^\.(ws|walk|wall|sees|size|strip|meter|pk|wc)/;
    for (const u of users) expect((blanket && LANDING.test(u.sel)) || reduced.includes(u.sel), `${u.sel} (${u.name})`).toBe(true);
    // Animations and transitions move only transform and opacity (plus colour fades), never layout.
    for (const m of css.matchAll(/transition:\s*([^;}]+)/g)) {
      for (const part of m[1]!.replace(/\([^)]*\)/g, "()").split(",")) expect(part.trim().split(/\s+/)[0], m[0]).toMatch(/^(opacity|transform|background-color|border-color|color|none)$/);
    }
    for (const m of css.matchAll(/@keyframes [a-z-]+ \{([\s\S]*?\})\s*\}/g)) expect(m[1], m[0]).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
    const js = readFileSync(join(root, "public/js/home.js"), "utf8");
    expect(js).toMatch(/prefers-reduced-motion: reduce/);
  });

  it("uses wellness wording and claims no certification", () => {
    for (const f of walk(join(root, "public")).filter((x) => x.endsWith(".html"))) {
      const s = readFileSync(f, "utf8").replace(/<[^>]+>/g, " ").toLowerCase();
      expect(s, f).not.toMatch(/\b(hipaa[- ]compliant|soc ?2 (certified|compliant|type)|gdpr[- ]compliant|iso ?27001|fda[- ](approved|cleared)|medical device|clinically (proven|validated)|medical[- ]grade)\b/);
    }
    const policy = readFileSync(join(root, "public/privacy.html"), "utf8");
    expect(policy).toMatch(/DRAFT/);
  });

  it("openapi.json and the API reference are generated from the edge Worker's OpenAPI (run npx tsx scripts/gen-openapi.ts)", () => {
    const spec = JSON.parse(JSON.stringify(openapi("api.askwearables.app")));
    expect(JSON.parse(readFileSync(join(root, "public/openapi.json"), "utf8"))).toEqual(spec);
    expect(readFileSync(join(root, "public/docs/api.html"), "utf8")).toBe(renderApiDocs(spec));
  });

  it("internal links point at pages that exist", () => {
    const pages = walk(join(root, "public")).filter((f) => f.endsWith(".html"));
    for (const f of pages) {
      for (const m of readFileSync(f, "utf8").matchAll(/href="(\/[^"#]*)(#[^"]*)?"/g)) {
        const p = m[1]!;
        const candidates = p.endsWith("/") ? [`${p}index.html`] : [p, `${p}.html`];
        expect(candidates.some((c) => { try { return statSync(join(root, "public", c)).isFile(); } catch { return false; } }), `${f}: ${p}`).toBe(true);
      }
    }
  });
});
