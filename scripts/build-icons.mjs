#!/usr/bin/env node
// The AskWearables "AW" monogram, drawn once here and written out as every file the site needs.
//   node scripts/build-icons.mjs
// Writes (under workers/site/public):
//   favicon.svg                      adaptive: light tile, or the dark variant when the system is in dark mode
//   assets/logo/aw-mark-light.svg    rounded tile for light backgrounds
//   assets/logo/aw-mark-dark.svg     rounded tile for dark backgrounds
//   assets/logo/aw-icon-square.svg   full-bleed square (platforms round the corners themselves)
//   favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable-512.png
// PNGs are rendered with headless Chromium (playwright-core; `npx playwright-core install chromium-headless-shell`).
//
// The glyph: one stroke that rises and falls five times. The first two strokes and a crossbar read as A; the last
// four, sharing the A's right leg, read as W. Bevelled joins keep the points flat so it holds at 16 px.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "../workers/site/public");
const LOGO = join(PUBLIC, "assets/logo");

export const GLYPH = (fg) =>
  `<path d="M5.9 23.5 10.5 8.5l4.6 15 3.2-10.5 3.2 10.5 4.6-15" fill="none" stroke="${fg}" stroke-width="2.8" stroke-linejoin="bevel"/>` +
  `<path d="M7.4 18.6h6.3" stroke="${fg}" stroke-width="2.4"/>`;
const LIGHT = { top: "#13806f", bottom: "#0b5c53", fg: "#ffffff" };
const DARK = { top: "#6fd6c6", bottom: "#4bb8a8", fg: "#0c1514" };

function tile({ top, bottom, fg }, { rx = 8, scale = 1 } = {}) {
  const off = (32 - 32 * scale) / 2;
  const glyph = scale === 1 ? GLYPH(fg) : `<g transform="translate(${off} ${off}) scale(${scale})">${GLYPH(fg)}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="32" height="32" rx="${rx}" fill="url(#t)"/>${glyph}</svg>`;
}

const favicon =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.a{stop-color:${LIGHT.top}}.b{stop-color:${LIGHT.bottom}}.g{stroke:${LIGHT.fg}}` +
  `@media (prefers-color-scheme:dark){.a{stop-color:${DARK.top}}.b{stop-color:${DARK.bottom}}.g{stroke:${DARK.fg}}}</style>` +
  `<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop class="a" offset="0"/><stop class="b" offset="1"/></linearGradient></defs>` +
  `<rect width="32" height="32" rx="8" fill="url(#t)"/>` +
  GLYPH("currentColor").replace(/stroke="currentColor"/g, 'class="g"') +
  `</svg>`;

mkdirSync(LOGO, { recursive: true });
const files = {
  [join(PUBLIC, "favicon.svg")]: favicon,
  [join(LOGO, "aw-mark-light.svg")]: tile(LIGHT),
  [join(LOGO, "aw-mark-dark.svg")]: tile(DARK),
  [join(LOGO, "aw-icon-square.svg")]: tile(LIGHT, { rx: 0 }),
};
for (const [f, s] of Object.entries(files)) writeFileSync(f, s + "\n");

const PNGS = [
  ["favicon-32.png", 32, tile(LIGHT)],
  ["apple-touch-icon.png", 180, tile(LIGHT, { rx: 0 })],
  ["icon-192.png", 192, tile(LIGHT)],
  ["icon-512.png", 512, tile(LIGHT)],
  // Maskable: full bleed, glyph inside the central 80% safe zone.
  ["icon-maskable-512.png", 512, tile(LIGHT, { rx: 0, scale: 0.8 })],
];
const { chromium } = await import("playwright-core");
const browser = await chromium.launch();
try {
  for (const [name, size, svg] of PNGS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: join(PUBLIC, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`wrote ${Object.keys(files).length} SVGs and ${PNGS.length} PNGs`);
