#!/usr/bin/env node
// Loads every page of the site at the phone, tablet and desktop widths below, in portrait and landscape, light and
// dark, and fails if anything makes the page scroll sideways.
//
// For each viewport it records document.scrollingElement.scrollWidth against the viewport width, and walks the DOM
// for any element whose right edge passes the viewport and is not inside a scroll box of its own (the html and body
// elements do not count as scroll boxes, so the defensive `overflow-x: clip` there cannot hide a real cause).
//
// Usage:
//   node scripts/check-viewport.mjs                     # starts `wrangler dev` for workers/site on a spare port
//   node scripts/check-viewport.mjs --url http://localhost:8787
//   node scripts/check-viewport.mjs --json out.json      # also writes every measurement
//   node scripts/check-viewport.mjs --browser webkit     # one engine only (default: chromium and webkit)
// Needs the dev dependency playwright-core and its browsers: `npx playwright-core install chromium-headless-shell webkit`.
// WebKit matters: Safari on iPhone is where the sideways scroll was reported, and it sizes some boxes differently.
import { spawn } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "workers/site/public");
export const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1440];
const PHONE_MAX = 430;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function pages() {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  return walk(PUBLIC).filter((f) => f.endsWith(".html")).map((f) => "/" + relative(PUBLIC, f).replace(/\\/g, "/").replace(/index\.html$/, "").replace(/\.html$/, "")).sort();
}

/** Portrait and landscape for each width. A phone in landscape is the same device turned sideways. */
function viewports() {
  const out = [];
  for (const w of WIDTHS) {
    if (w <= PHONE_MAX) {
      const h = Math.round(w * 2.165);
      out.push({ name: `${w} portrait`, width: w, height: h, mobile: true });
      out.push({ name: `${w} landscape`, width: h, height: w, mobile: true });
    } else {
      out.push({ name: `${w} portrait`, width: w, height: Math.round(w * 1.33), mobile: w < 1280 });
      out.push({ name: `${w} landscape`, width: w, height: Math.round(w * 0.62), mobile: w < 1280 });
    }
  }
  return out;
}

async function startServer() {
  const port = 8790 + Math.floor(Math.random() * 100);
  const child = spawn("npx", ["wrangler", "dev", "-c", "workers/site/wrangler.jsonc", "--port", String(port), "--ip", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url + "/")).ok) return { url, stop: () => child.kill("SIGTERM") }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGTERM");
  throw new Error("wrangler dev did not start");
}

// Runs in the page. Returns the scroll width and the elements that pass the right edge without a scroll box to hold them.
function measure(vw) {
  const doc = document.scrollingElement || document.documentElement;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== "visible" || s.contain.includes("paint")) return true;
    }
    return false;
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { s += "#" + e.id; parts.unshift(s); break; }
      const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const offenders = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const right = r.right + window.scrollX;
    if (right > vw + 0.5 && !clipped(el)) offenders.push({ el: path(el), right: Math.round(right), width: Math.round(r.width) });
  }
  // Keep the outermost offender of each chain, which is the one to fix (its children overflow because it does).
  const top = offenders.filter((o, i) => !offenders.some((p, j) => j < i && o.el.startsWith(p.el + " > ")));
  return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, offenders: top.slice(0, 12), total: offenders.length };
}

async function settle(page) {
  // Scroll through once so scroll-triggered reveals run, open collapsed sections, and let animations reach any frame.
  await page.evaluate(async () => {
    for (const d of document.querySelectorAll("details")) d.open = true;
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += Math.max(200, innerHeight * 0.8)) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); }
    scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
  });
}

async function main() {
  const server = opt("--url") ? { url: opt("--url").replace(/\/$/, ""), stop: () => {} } : await startServer();
  const engines = opt("--browser") ? [opt("--browser")] : ["chromium", "webkit"];
  const results = [];
  let failures = 0;
  for (const engine of engines) {
  const browser = await (engine === "webkit" ? webkit : chromium).launch();
  try {
    const vps = viewports();
    // One page load per page and device class; each viewport is then a resize of that page. Pages run in parallel.
    const jobs = [];
    for (const mobile of [true, false]) {
      const set = vps.filter((v) => v.mobile === mobile);
      if (set.length) for (const path of pages()) jobs.push({ mobile, set, path });
    }
    const one = async ({ mobile, set, path }) => {
      const ctx = await browser.newContext({ viewport: { width: set[0].width, height: set[0].height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
      const page = await ctx.newPage();
      // Over plain-http localhost, WebKit applies the CSP's upgrade-insecure-requests and asks for https://localhost,
      // so the stylesheet never loads. Drop only that directive locally; the rest of the policy stays in force.
      if (server.url.startsWith("http:")) {
        await page.route("**/*", async (route) => {
          const res = await route.fetch();
          const headers = { ...res.headers() };
          if (headers["content-security-policy"]) headers["content-security-policy"] = headers["content-security-policy"].replace(/;\s*upgrade-insecure-requests/, "");
          await route.fulfill({ response: res, headers });
        });
      }
      await page.goto(server.url + path, { waitUntil: "networkidle" });
      if (!(await page.evaluate(() => [...document.styleSheets].some((s) => { try { return s.cssRules.length > 0; } catch { return false; } })))) throw new Error(`${engine}: style.css did not load on ${path}`);
      await settle(page);
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const v of set) {
          await page.setViewportSize({ width: v.width, height: v.height });
          await page.waitForTimeout(150);
          // Measure twice, half a second apart, so a looping animation is caught at more than one frame.
          const a = await page.evaluate(measure, v.width);
          await page.waitForTimeout(500);
          const b = await page.evaluate(measure, v.width);
          const m = b.offenders.length > a.offenders.length || b.scrollWidth > a.scrollWidth ? b : a;
          const overflow = m.scrollWidth > v.width || m.offenders.length > 0;
          results.push({ engine, page: path, viewport: v.name, width: v.width, height: v.height, scheme, ...m, overflow });
          if (overflow) {
            failures++;
            console.log(`OVERFLOW [${engine}] ${path} @ ${v.name} (${v.width}x${v.height}, ${scheme}): scrollWidth ${m.scrollWidth} > ${v.width}`);
            for (const o of m.offenders) console.log(`    ${o.el}  right=${o.right} width=${o.width}`);
          }
        }
      }
      await ctx.close();
    };
    const queue = [...jobs];
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
  } finally {
    await browser.close();
  }
  }
  server.stop();
  if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(results, null, 1));
  const n = results.length;
  console.log(`${n - failures} of ${n} page × viewport × scheme checks fit the viewport; ${failures} overflow.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
