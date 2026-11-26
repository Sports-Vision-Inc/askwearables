import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
    type Run = { correct: boolean; asked?: string[]; packets?: unknown[] };
    const byId = new Map(d.examples.map((x: { id: string }) => [x.id, x]));
    expect(byId.size).toBe(d.examples.length); // ids are unique
    // The hero story: everyday questions, each with AskWearables right and another route plainly wrong.
    expect(f.examples.length).toBeGreaterThanOrEqual(3);
    expect(f.examples.length).toBeLessThanOrEqual(6);
    const traps = new Set<string>();
    for (const it of f.examples) {
      const x = byId.get(it.id) as { trap: string; question: string; runs: Record<string, Run> } | undefined;
      expect(x, it.id).toBeDefined();
      expect(x!.runs.C_broker!.correct, it.id).toBe(true);
      expect(!x!.runs.A_raw!.correct || !x!.runs.B_tools!.correct, it.id).toBe(true);
      expect(x!.runs.C_broker!.asked?.length, it.id).toBeGreaterThan(0);
      expect((it as { emoji?: string }).emoji, "no emoji on the landing page").toBeUndefined();
      // Tabs are labelled by the question a person would ask, not by trap names.
      expect(it.title, it.id).toMatch(/\?$/);
      expect(it.title, it.id).not.toMatch(/_/);
      // One plain sentence per route; the framing carries no numbers, so it cannot drift from the data.
      for (const c of ["A_raw", "B_tools", "C_broker"]) expect(typeof it.why[c], `${it.id} ${c}`).toBe("string");
      expect(`${it.title} ${Object.values(it.why).join(" ")} ${it.face_note ?? ""}`, it.id).not.toMatch(/\d/);
      traps.add(x!.trap);
    }
    expect(f.examples[0].id).toMatch(/steps_yesterday$/); // the lead: phone + watch double counting
    for (const t of ["two_step_sources", "missing_days", "stale_sync"]) expect(traps.has(t), t).toBe(true);
    // The pipeline walkthrough in How it works plays runs whose packet was stored.
    for (const it of f.pipeline) {
      const x = byId.get(it.id) as { runs: Record<string, Run> } | undefined;
      expect(x, it.id).toBeDefined();
      expect(x!.runs.C_broker!.correct, it.id).toBe(true);
      expect(`${it.title} ${it.why}`, it.id).not.toMatch(/\d/);
    }
    expect(f.pipeline.some((it: { id: string }) => ((byId.get(it.id) as { runs: Record<string, Run> }).runs.C_broker!.packets ?? []).length > 0)).toBe(true);
    // The hero, the comparison and the context-size section are filled from JSON: their markup holds no digits.
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    for (const [a, b] of [['id="story"', "</figure>"], ['id="walk"', "</figure>"], ['id="stage"', 'id="usecases"'], ['id="cmp"', 'id="cmp-takeaway"'], ['id="leak-chart"', "</section>"], ['id="sees-box"', "</section>"]] as const) {
      const i = page.indexOf(a);
      expect(i, a).toBeGreaterThan(0);
      expect(page.slice(i, page.indexOf(b, i)).replace(/<[^>]+>/g, " ").replace(/95% intervals?/g, ""), a).not.toMatch(/\d/);
    }
    // The hero holds the device and the four real requests; then the story card, the comparison and the charts.
    const order = ['id="stage"', 'id="usecases"', 'class="fine hero-fine"', 'id="story"', 'id="compare"', 'data-chart="accuracy-cost"', 'id="leak-chart"', 'id="walk"'].map((k) => page.indexOf(k));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(page.indexOf('id="walk"')).toBeGreaterThan(page.indexOf('aria-labelledby="how"'));
    expect(page).toContain('href="/results">See per-model results</a>');
    expect(readFileSync(join(root, "public/results.html"), "utf8")).toContain('data-chart="accuracy-cost"');
  });

  it("compares A, B and C from results.json only, and waits for the corrected leak detector", () => {
    const js = readFileSync(join(root, "public/js/compare.js"), "utf8");
    // Pooled figures and intervals are computed from the results file; the privacy rate needs the corrected detector.
    expect(js).toMatch(/window\.awResults/);
    expect(js).toMatch(/privacy_detector === "corrected"/);
    expect(js).toMatch(/measuring/);
    // No figure is typed into the script: the only numbers are scale constants and formatting.
    const numbers = [...js.replace(/\/\/.*$/gm, "").replace(/"[^"\n]*"/g, '""').matchAll(/(?<![\w.$#-])\d+(\.\d+)?(?![\w%])/g)].map((m) => Number(m[0]));
    for (const n of numbers) expect([0, 1, 2, 4, 6, 10, 20, 100, 130, 0.1, 0.9, 0.95, 0.995, 0.15, 1.959964].includes(n), `literal ${n} in compare.js`).toBe(true);
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    for (const name of ["Paste the whole export", "Give it open data tools", "AskWearables"]) expect(page).toContain(`<p class="cmp-name">${name}</p>`);
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

  it("self-hosts open-source icons with their licences and credits them, and uses no emoji", () => {
    const assets = join(root, "public/assets");
    expect(readFileSync(join(assets, "icons/lucide/LICENSE.txt"), "utf8")).toMatch(/ISC License/);
    expect(existsSync(join(assets, "emoji")), "no emoji assets").toBe(false);
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
    const credits = readFileSync(join(root, "public/credits.html"), "utf8");
    expect(credits).toMatch(/Lucide[\s\S]*ISC/);
    expect(credits).not.toMatch(/Twemoji/);
  });

  it("gives every animation a reduced-motion fallback", () => {
    const css = readFileSync(join(root, "public/style.css"), "utf8");
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n?\}\s*(?=\n|$)/g)].map((m) => m[1]).join("\n");
    // Each keyframes animation is used only by elements a reduced-motion rule switches off.
    const users = [...css.matchAll(/([^{}]+)\{[^}]*\banimation:\s*([a-z-]+)/g)].map((m) => ({ sel: m[1]!.trim(), name: m[2]! })).filter((u) => u.name !== "none");
    expect(users.length).toBeGreaterThan(0);
    // The landing animations live inside .walk, .sees, .stage and .story, which reduced-motion rules still; anything else is named.
    const blanket = /\.walk \*[\s\S]*\.sees \*[\s\S]*animation: none !important/.test(reduced);
    const stageBlanket = /\.stage \*[\s\S]*animation: none !important/.test(reduced) && /\.story \*[\s\S]*animation: none !important/.test(reduced);
    const LANDING = /^\.(ws|walk|wall|sees|size|strip|meter|pk|wc)/;
    const STAGE = /^\.(dev|face|rail|stage)/;
    for (const u of users) expect((blanket && LANDING.test(u.sel)) || (stageBlanket && STAGE.test(u.sel)) || reduced.includes(u.sel), `${u.sel} (${u.name})`).toBe(true);
    // Every autoplaying piece has a pause control.
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    for (const id of ["story-toggle", "walk-toggle"]) expect(page).toContain(`id="${id}"`);
    // Animations and transitions move only transform and opacity (plus colour fades), never layout.
    for (const m of css.matchAll(/transition:\s*([^;}]+)/g)) {
      for (const part of m[1]!.replace(/\([^)]*\)/g, "()").split(",")) expect(part.trim().split(/\s+/)[0], m[0]).toMatch(/^(opacity|transform|background-color|border-color|color|none)$/);
    }
    for (const m of css.matchAll(/@keyframes [a-z-]+ \{([\s\S]*?\})\s*\}/g)) expect(m[1], m[0]).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
    const js = readFileSync(join(root, "public/js/home.js"), "utf8");
    expect(js).toMatch(/prefers-reduced-motion: reduce/);
  });

  it("cannot scroll sideways: no 100vw, no wide fixed containers, no zoom-on-focus controls, and a clip guard", () => {
    const css = readFileSync(join(root, "public/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/100vw/);
    // A fixed width or min-width over 360px on any box would overflow a phone. The architecture SVG sits inside its own
    // labelled scroll box (.diagram-scroll) and is the one exception.
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1]!.trim();
      for (const d of m[2]!.matchAll(/(?:^|;)\s*((?:min-)?width)\s*:\s*(\d+(?:\.\d+)?)px/g)) {
        if (Number(d[2]) > 360) expect(sel, `${sel} { ${d[1]}: ${d[2]}px }`).toBe(".diagram svg");
      }
      // Grid tracks must be able to shrink below their minimum on a narrow screen.
      for (const g of m[2]!.matchAll(/minmax\((\d+)px/g)) expect(Number(g[1]), `${sel}: minmax(${g[1]}px, ...) needs min(100%, ...)`).toBeLessThanOrEqual(140);
    }
    // iOS Safari zooms the page when a form control under 16px takes focus; a zoomed page scrolls sideways.
    expect(css).toMatch(/\.ctl select \{[^}]*font-size: max\(16px, 1rem\)/);
    // The defensive guard, after the real causes were fixed.
    expect(css).toMatch(/html, body \{ overflow-x: clip; \}/);
    // The check script exists and covers every width the owner tests.
    const script = readFileSync(join(root, "../../scripts/check-viewport.mjs"), "utf8");
    expect(script).toMatch(/320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1440/);
  });

  it("uses the AW monogram, the SportsVision parent brand, and ships every icon size", () => {
    const pub = join(root, "public");
    const png = (f: string) => { const b = readFileSync(join(pub, f)); expect(b.subarray(1, 4).toString(), f).toBe("PNG"); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    expect(png("favicon-32.png")).toEqual([32, 32]);
    expect(png("apple-touch-icon.png")).toEqual([180, 180]);
    expect(png("icon-192.png")).toEqual([192, 192]);
    expect(png("icon-512.png")).toEqual([512, 512]);
    expect(png("icon-maskable-512.png")).toEqual([512, 512]);
    const fav = readFileSync(join(pub, "favicon.svg"), "utf8");
    expect(fav).toMatch(/prefers-color-scheme:dark/);
    expect(fav).not.toMatch(/<script|href=/);
    for (const f of ["aw-mark-light.svg", "aw-mark-dark.svg", "aw-icon-square.svg"]) expect(statSync(join(pub, "assets/logo", f)).isFile(), f).toBe(true);
    const manifest = JSON.parse(readFileSync(join(pub, "site.webmanifest"), "utf8"));
    expect(manifest.name).toBe("AskWearables");
    for (const i of manifest.icons) expect(statSync(join(pub, i.src)).isFile(), i.src).toBe(true);
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    // The SportsVision artwork is used as supplied: 1600 x 343, shown at that aspect ratio.
    for (const f of ["sportsvision-logo-black.png", "sportsvision-logo-white.png"]) expect(png(`assets/brand/${f}`)).toEqual([1600, 343]);
    for (const f of walk(pub).filter((x) => x.endsWith(".html"))) {
      const s = readFileSync(f, "utf8");
      if (!s.includes('<header class="site-header">')) continue;
      for (const k of ['rel="manifest" href="/site.webmanifest"', 'rel="apple-touch-icon" href="/apple-touch-icon.png"', 'class="brand-mark" viewBox="0 0 32 32"']) expect(s, `${f}: ${k}`).toContain(k);
      const header = s.slice(s.indexOf('<header class="site-header">'), s.indexOf("</header>"));
      expect(header, f).toMatch(/<span class="parent-by">by<\/span><picture class="sv-logo"><source srcset="\/assets\/brand\/sportsvision-logo-white\.png" media="\(prefers-color-scheme: dark\)"><img src="\/assets\/brand\/sportsvision-logo-black\.png" alt="SportsVision"/);
      const footer = s.includes('<footer class="site-footer">') ? s.slice(s.indexOf('<footer class="site-footer">')) : null;
      if (footer) for (const k of ["AskWearables is a SportsVision product.", "© 2026 Sports Vision, Inc.", 'href="https://www.sportsvision.ai"', 'alt="SportsVision"']) expect(footer, `${f}: ${k}`).toContain(k);
      for (const m of s.matchAll(/<img src="\/assets\/brand\/sportsvision-logo-[a-z]+\.png" alt="SportsVision" width="(\d+)" height="(\d+)">/g)) {
        expect(Math.abs(Number(m[1]) / Number(m[2]) - 1600 / 343), `${f}: logo aspect`).toBeLessThan(0.02);
      }
    }
    // The wearable illustrations are original, generic and unbranded, with their provenance stored beside them.
    const lic = readFileSync(join(pub, "assets/wearables/LICENSE.txt"), "utf8");
    expect(lic).toMatch(/Original artwork/);
    for (const f of ["watch-square.svg", "watch-round.svg", "band.svg", "ring.svg"]) {
      const svg = readFileSync(join(pub, "assets/wearables", f), "utf8");
      expect(svg, f).not.toMatch(/apple|samsung|garmin|oura|whoop|fitbit|polar|<text/i);
    }
  });

  it("builds the use-case packets with the real engine, and the cards add no figures of their own", async () => {
    const { buildUsecases, USECASE_TODAY } = await import("../../../scripts/build-usecases.js");
    const fresh = await buildUsecases(USECASE_TODAY);
    const stored = JSON.parse(readFileSync(join(root, "public/data/usecases.json"), "utf8"));
    // Receipt ids are random per release; everything else must match a fresh run of the engine exactly.
    const strip = (o: unknown) => JSON.parse(JSON.stringify(o, (k, v) => (k === "receipt_id" ? "rc" : v)));
    expect(strip(stored)).toEqual(strip(fresh));
    type Ask = { spec: { operation: string; metrics: string[] }; response: { status: string; reasons?: string[]; packet?: { level: number; findings: { statement: string; value?: number; values?: unknown[] }[] } } };
    const cases = stored.cases as Record<string, { grant: { purpose: string; max_level: number; metrics: string[] }; asks: Ask[] }>;
    const m = cases.meeting!;
    expect(m.grant).toMatchObject({ purpose: "scheduling", max_level: 1, metrics: ["sleep_duration"] });
    expect(m.asks[0]!.response.packet!.level).toBe(1);
    expect(m.asks[0]!.response.packet!.findings[0]!.statement).toMatch(/below usual range on 3 of the last 3 nights/);
    const v = cases.video!;
    expect(v.asks.map((a) => a.spec.operation)).toEqual(["trend", "compare_to_baseline", "compare_periods"]);
    expect(v.asks.map((a) => a.spec.metrics[0])).toEqual(["hrv_rmssd", "resting_hr", "workout"]);
    const st = cases.stress!;
    expect(st.asks.every((a) => a.spec.operation === "compare_to_baseline" && ["resting_hr", "hrv_rmssd"].includes(a.spec.metrics[0]!))).toBe(true);
    // No released packet below the level that answers: no values reach the calendar, coach or journal agents.
    for (const c of [m, v, st]) for (const a of c.asks) {
      expect(a.response.status).toBe("ok");
      expect(a.response.packet!.level).toBeLessThanOrEqual(1);
      for (const f of a.response.packet!.findings) { expect(f.value).toBeUndefined(); expect(f.values).toBeUndefined(); }
    }
    const ins = cases.insurer!;
    expect(ins.asks[0]!.response.status).toBe("denied");
    expect(ins.asks[0]!.response.reasons).toContain("metric_not_in_grant:weight");
    expect(ins.asks[0]!.response.packet).toBeUndefined();
    // Stress is never claimed: the catalogue has no such metric, and the page says so.
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    const sec = page.slice(page.indexOf('id="usecases"'), page.indexOf("</section>", page.indexOf('id="usecases"')));
    expect(sec).toMatch(/no stress metric in the catalogue/);
    expect(sec.replace(/<[^>]+>/g, " ").replace(/6 am/g, "")).not.toMatch(/\d/);
    expect(readFileSync(join(root, "public/js/usecases.js"), "utf8")).toMatch(/\/data\/usecases\.json/);
  });

  it("drives the hero device from one well-synced person, with every signal present and no empty dashes", () => {
    const d = JSON.parse(readFileSync(join(root, "public/data/usecases.json"), "utf8"));
    const dev = d.device;
    // Never the stale-sync or missing-days people: "unknown" belongs in the story cards, not on the watch.
    expect(dev.trap).toBe("clean");
    for (const m of ["steps", "sleep_duration", "resting_hr", "hrv_rmssd", "workout"]) {
      const sig = dev.signals[m];
      expect(sig, m).toBeDefined();
      expect(typeof sig.value, m).toBe("number");
      expect(sig.week.length, m).toBe(7);
      for (const w of sig.week) expect(typeof w.value, `${m} ${w.day}`).toBe("number");
      if (m !== "workout") expect(["within", "above", "below"], m).toContain(sig.usual.direction);
    }
    const st = dev.signals.sleep_duration.stages;
    for (const k of ["deep_min", "rem_min", "light_min", "awake_min"]) expect(st[k], k).toBeGreaterThan(0);
    // Signals the cohort lacks are named as absent, never shown as a value.
    for (const m of dev.not_in_cohort) expect(["spo2", "respiratory_rate", "skin_temp_deviation"]).toContain(m);
    for (const m of dev.not_in_cohort) expect(dev.signals[m], m).toBeUndefined();
    // Empty states use a neutral "no data" badge, never a dash placeholder.
    for (const f of ["usecases.js", "home.js", "compare.js"]) expect(readFileSync(join(root, "public/js", f), "utf8"), f).not.toMatch(/– –|"--"/);
    expect(readFileSync(join(root, "public/js/usecases.js"), "utf8")).toMatch(/no data/);
    // Each request card names the signals it touched and the release level.
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    expect(page.match(/data-f="chips"/g)?.length).toBe(4);
    expect(page).toContain('id="stage-toggle"');
  });

  it("credits third-party work on /credits, linked from every footer, not in the footer text", () => {
    const credits = readFileSync(join(root, "public/credits.html"), "utf8");
    for (const k of ["Lucide", "ISC License", "/assets/icons/lucide/LICENSE.txt", 
      "© 2026 Sports Vision, Inc.", "Trademark of Sports Vision, Inc.", "@simplewebauthn/browser", "MIT License", "/assets/wearables/LICENSE.txt"]) expect(credits, k).toContain(k);
    for (const f of walk(join(root, "public")).filter((x) => x.endsWith(".html"))) {
      const s = readFileSync(f, "utf8");
      if (!s.includes('<footer class="site-footer">')) continue;
      const footer = s.slice(s.indexOf('<footer class="site-footer">'));
      expect(footer, f).toContain('<a href="/credits">Open-source credits</a>');
      expect(footer.replace(/<[^>]+>/g, " "), f).not.toMatch(/Lucide|Twemoji|CC-BY/);
    }
  });

  it("uses wellness wording and claims no certification", () => {
    for (const f of walk(join(root, "public")).filter((x) => x.endsWith(".html"))) {
      const s = readFileSync(f, "utf8").replace(/<[^>]+>/g, " ").toLowerCase();
      expect(s, f).not.toMatch(/\b(hipaa[- ]compliant|soc ?2 (certified|compliant|type)|gdpr[- ]compliant|iso ?27001|fda[- ](approved|cleared)|medical device|clinically (proven|validated)|medical[- ]grade)\b/);
    }
  });

  it("publishes the privacy policy and terms, linked from every footer", () => {
    for (const [page, heading] of [["privacy", "Privacy Policy"], ["terms", "Terms of Service"]] as const) {
      const s = readFileSync(join(root, `public/${page}.html`), "utf8");
      expect(s, page).toContain(`<h1>AskWearables ${heading}</h1>`);
      // Published: no draft banner, no "(draft)" title, indexable, and dated.
      expect(s, page).not.toMatch(/DRAFT|\(draft\)/);
      expect(s, page).not.toMatch(/<meta name="robots"[^>]*noindex/i);
      expect(s, page).toContain('<p class="muted">Effective date: 25 November 2026. Last updated: 25 November 2026.</p>');
      // The company named, and the promises that must not drift.
      expect(s, page).toContain("Sports Vision, Inc.");
      expect(s, page).toContain("contact@sportsvision.ai");
      expect(s, page).toMatch(/not medical advice/i);
    }
    const privacy = readFileSync(join(root, "public/privacy.html"), "utf8");
    expect(privacy).toMatch(/do not use your Health Data[^.]*to train/i);
    expect(privacy).toContain('<h2 id="consumer-health-data">');
    expect(privacy).toContain("AskWearables is not offered in the EU or UK yet.");
    expect(readFileSync(join(root, "public/terms.html"), "utf8")).toContain('id="developer-terms"');
    expect(privacy).toMatch(/We do <strong>not<\/strong> use your Health Data to train AI models/);
    // No bracketed placeholders reach the published pages.
    for (const page of ["privacy", "terms"]) {
      const text = readFileSync(join(root, `public/${page}.html`), "utf8").replace(/<[^>]+>/g, " ");
      expect(text, page).not.toMatch(/\[[^\]]+\]/);
    }
    // Every page with a footer links to both documents, and to the consumer health data section, from it.
    for (const f of walk(join(root, "public")).filter((x) => x.endsWith(".html"))) {
      const s = readFileSync(f, "utf8");
      const footer = s.slice(s.indexOf('<footer class="site-footer">'));
      if (!s.includes('<footer class="site-footer">')) continue;
      expect(footer, f).toContain('<a href="/privacy">Privacy policy</a>');
      expect(footer, f).toContain('<a href="/terms">Terms of service</a>');
      expect(footer, f).toContain('<a href="/privacy#consumer-health-data">Consumer health data</a>');
    }
  });

  it("openapi.json and the API reference are generated from the edge Worker's OpenAPI (run npx tsx scripts/gen-openapi.ts)", () => {
    const spec = JSON.parse(JSON.stringify(openapi("api.askwearables.app")));
    expect(JSON.parse(readFileSync(join(root, "public/openapi.json"), "utf8"))).toEqual(spec);
    expect(readFileSync(join(root, "public/docs/api.html"), "utf8")).toBe(renderApiDocs(spec));
  });

  it("folds the main navigation into an accessible disclosure menu on a phone", () => {
    const pages = walk(join(root, "public")).filter((f) => f.endsWith(".html"));
    for (const f of pages) {
      const s = readFileSync(f, "utf8");
      if (!s.includes('<header class="site-header">')) continue;
      const header = s.slice(s.indexOf('<header class="site-header">'), s.indexOf("</header>"));
      // A real button, collapsed by default, pointing at the nav it controls; hidden until the script enables it.
      expect(header, f).toMatch(/<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" hidden>/);
      expect(header, f).toContain('<nav class="site-nav" id="site-nav" aria-label="Main">');
      expect(header.indexOf("nav-toggle"), `${f}: the button comes before the links in focus order`).toBeLessThan(header.indexOf('id="site-nav"'));
      expect(s, f).toContain('<script src="/js/nav.js" defer></script>');
    }
    const js = readFileSync(join(root, "public/js/nav.js"), "utf8");
    expect(js).toMatch(/setAttribute\("aria-expanded"/);
    expect(js).toMatch(/ev\.key === "Escape"/);
    expect(js).toMatch(/btn\.hidden = false/);
    expect(js).toMatch(/btn\.focus\(\)/); // Escape returns focus to the button
    // The generators keep the same header, so regenerated pages keep the menu.
    for (const g of ["../../scripts/render-api-docs.ts", "../../scripts/md2site.py"]) {
      const t = readFileSync(join(root, g), "utf8");
      expect(t, g).toContain('aria-controls="site-nav"');
      expect(t, g).toContain("/js/nav.js");
    }
    const css = readFileSync(join(root, "public/style.css"), "utf8");
    // Without the script, or on a wide screen, the links show; the menu applies only once the script has run.
    expect(css).toMatch(/\.nav-toggle \{ display: none; \}/);
    expect(css).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.has-menu \.site-nav \{ display: none;[\s\S]*?\.has-menu\.menu-open \.site-nav \{ display: flex; \}/);
  });

  it("gives every control a touch target of at least 44 x 44 CSS px on a phone", () => {
    const css = readFileSync(join(root, "public/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/:root \{ --tap: 44px; \}/);
    const block = (q: string) => {
      const i = css.indexOf(q);
      expect(i, q).toBeGreaterThan(0);
      let depth = 0, j = css.indexOf("{", i);
      for (let k = j; k < css.length; k++) { if (css[k] === "{") depth++; else if (css[k] === "}" && --depth === 0) return css.slice(j, k); }
      return "";
    };
    const touch = block("@media (max-width: 720px), (pointer: coarse) {");
    const hasMin = (sel: string, src: string) => [...src.matchAll(/([^{}]+)\{([^}]*)\}/g)].some((m) => m[1]!.split(",").map((x) => x.trim()).includes(sel) && /min-height: var\(--tap\)|height: var\(--tap\)/.test(m[2]!));
    for (const sel of [".btn", ".toggle", ".ctl select", ".walk-toggle", ".story-toggle", ".stage-toggle", ".walk-step", ".story-tab", ".walk-tab", ".signal", ".jump a", ".docs-nav a", ".toc a", ".deploy-btn"]) expect(hasMin(sel, touch), sel).toBe(true);
    // Header, footer and the menu's own links, at every width.
    for (const sel of [".brand", ".parent", ".site-nav a", ".site-footer nav a", ".foot-legal a"]) expect(hasMin(sel, css), sel).toBe(true);
    expect(block("@media (max-width: 720px) {")).toMatch(/\.has-menu \.nav-toggle \{[^}]*min-width: var\(--tap\); min-height: var\(--tap\)/);
    expect(block("@media (max-width: 720px) {")).toMatch(/\.has-menu \.site-nav a \{[^}]*min-height: 48px/);
    // 8px between neighbouring targets.
    expect(touch).toMatch(/\.story-tabs, \.walk-tabs, \.actions, \.ex-nav, \.walk-ctrls, \.uc-chips, \.credit-meta \{ gap: 8px; \}/);
    // Safari ignores the height of a native select, so the selects draw their own chevron.
    expect(css).toMatch(/\.ctl select \{ -webkit-appearance: none; appearance: none;/);
    // Chart rows are taller on touch screens; a tap shows the tooltip (pointerleave fires after every tap).
    const rjs = readFileSync(join(root, "public/js/results.js"), "utf8");
    expect(rjs).toMatch(/\(pointer: coarse\)"\)\.matches \? 24 : 17/);
    expect(rjs).toMatch(/addEventListener\("pointerup"/);
    expect(rjs).toMatch(/pointerType !== "touch"\) hideTip/);
  });

  it("keeps phone text at readable sizes: 16px running text, nothing under 12px", () => {
    const css = readFileSync(join(root, "public/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const px = (v: string) => (v.endsWith("rem") ? parseFloat(v) * 16 : v.endsWith("px") ? parseFloat(v) : NaN);
    // The phone blocks of the mobile pass, where the floors are set.
    const start = css.indexOf("--tap: 44px");
    const phone = [...css.slice(start).matchAll(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    const raised = new Map<string, number>();
    for (const m of phone.matchAll(/([^{}]+)\{([^}]*font-size:\s*([\d.]+(?:rem|px))[^}]*)\}/g)) for (const sel of m[1]!.split(",")) raised.set(sel.trim(), px(m[3]!));
    // Every rule elsewhere that sets type under 12px is raised to at least 12px on a phone. The watch face (sized in
    // container units) and SVG text (drawn at the chart's own scale) are outside this rule.
    const EXEMPT = /^(\.face|\.fs-|\.fbadge|\.fs-key|svg|\.arch|\.flowsvg|\.legend \.sw)|\.(face|fs)-/;
    for (const m of css.slice(0, start).matchAll(/([^{}@]+)\{([^}]*)\}/g)) {
      const decl = m[2]!.match(/font(?:-size)?:\s*(?:\d{3}\s+)?([\d.]+(?:rem|px))/);
      if (!decl || !(px(decl[1]!) < 12)) continue;
      for (const sel of m[1]!.split(",").map((x) => x.trim())) {
        if (EXEMPT.test(sel) || sel.includes("::before") && sel.includes("data-label")) continue;
        expect(raised.get(sel) ?? 0, `${sel} is ${decl[1]} and needs a phone floor of 12px`).toBeGreaterThanOrEqual(12);
      }
    }
    // Running text in the hero cards and charts reads at 16px on a phone.
    for (const sel of [".msg", ".uc-safe", ".uc-note", ".sc-why", ".merge-side", ".walk-why", ".chart-sub", ".pk-finding"]) expect(raised.get(sel), sel).toBe(16);
    // Body copy is 16px everywhere, and form controls never drop under 16px (iOS zoom).
    expect(css).toMatch(/body \{[^}]*font: 16px\/1\.6/);
    // Tables never squeeze a column to one letter per line.
    expect(css).not.toMatch(/\.table-wrap th, \.table-wrap td \{[^}]*overflow-wrap: anywhere/);
  });

  it("stacks every document table with a header row into labelled cards on a phone", () => {
    const pages = ["privacy.html", "terms.html", ...readdirSync(join(root, "public/docs")).map((f) => `docs/${f}`)];
    let n = 0;
    for (const f of pages) {
      const s = readFileSync(join(root, "public", f), "utf8");
      for (const m of s.matchAll(/<table([^>]*)>([\s\S]*?)<\/table>/g)) {
        if (!m[2]!.includes("<thead>")) continue;
        n++;
        expect(m[1], f).toBe(' class="stack doc-table"');
        for (const row of m[2]!.slice(m[2]!.indexOf("<tbody>")).matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
          expect(row[1], `${f}: the first cell heads the row`).toMatch(/^\s*<th scope="row">/);
          for (const td of row[1]!.matchAll(/<td([^>]*)>/g)) expect(td[1], `${f}: every other cell names its column`).toMatch(/data-label="[^"]+"/);
        }
      }
    }
    expect(n).toBeGreaterThan(30);
  });

  it("loads the heavy results file only when the page gets near the charts", () => {
    const js = readFileSync(join(root, "public/js/data.js"), "utf8");
    expect(js).toMatch(/IntersectionObserver/);
    expect(js).toMatch(/requestIdleCallback/);
    expect(js).toMatch(/fetch\("\/data\/results\.json"/); // still the one file every figure comes from
    const page = readFileSync(join(root, "public/index.html"), "utf8");
    expect(page.match(/data-needs-results/g)?.length).toBeGreaterThanOrEqual(2);
    expect(page.slice(page.indexOf('id="story"') - 40, page.indexOf('id="story"') + 80)).toContain("data-needs-results");
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
