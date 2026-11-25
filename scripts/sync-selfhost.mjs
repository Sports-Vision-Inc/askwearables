// Copies the shared code the self-host edition runs into selfhost/, so that directory builds and deploys
// on its own (the Deploy to Cloudflare button clones only that subdirectory). The copies are committed.
// Nothing is edited on the way: the self-host Worker imports the same files the hosted Workers run.
//
//   node scripts/sync-selfhost.mjs           copy, then write selfhost/vendor/MANIFEST.json
//   node scripts/sync-selfhost.mjs --check   exit 1 if any copy differs from its source
//
// selfhost/test/vendor-sync.test.ts runs the same comparison under vitest.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selfhost = join(root, "selfhost");

/** source (relative to the repo root) -> destination (relative to selfhost/). Directories copy every file. */
export const MAPPINGS = [
  { source: "packages/core/src", dest: "vendor/core/src", kind: "dir" },
  { source: "packages/importers/src", dest: "vendor/importers/src", kind: "dir" },
  // auth: passkeys, sessions, the consent flow and its pages, the self-hosted WebAuthn browser bundle
  { source: "workers/auth/src/flows.ts", dest: "vendor/workers/auth/src/flows.ts", kind: "file" },
  { source: "workers/auth/src/pages.ts", dest: "vendor/workers/auth/src/pages.ts", kind: "file" },
  { source: "workers/auth/src/rpc.ts", dest: "vendor/workers/auth/src/rpc.ts", kind: "file" },
  { source: "workers/auth/src/vendor/webauthn-browser.ts", dest: "vendor/workers/auth/src/vendor/webauthn-browser.ts", kind: "file" },
  // edge: the MCP server, its tools, and the REST handlers
  { source: "workers/edge/src/handlers.ts", dest: "vendor/workers/edge/src/handlers.ts", kind: "file" },
  { source: "workers/edge/src/openapi.ts", dest: "vendor/workers/edge/src/openapi.ts", kind: "file" },
  // gate, vault (the UserVault Durable Object) and planner
  { source: "workers/gate/src/index.ts", dest: "vendor/workers/gate/src/index.ts", kind: "file" },
  { source: "workers/gate/src/rpc.ts", dest: "vendor/workers/gate/src/rpc.ts", kind: "file" },
  { source: "workers/vault/src/index.ts", dest: "vendor/workers/vault/src/index.ts", kind: "file" },
  { source: "workers/vault/src/rpc.ts", dest: "vendor/workers/vault/src/rpc.ts", kind: "file" },
  { source: "workers/planner/src/index.ts", dest: "vendor/workers/planner/src/index.ts", kind: "file" },
  { source: "workers/planner/src/rpc.ts", dest: "vendor/workers/planner/src/rpc.ts", kind: "file" },
  // console: its /api and its browser client (bundled into selfhost/public/app.js), styles and icons
  { source: "workers/console/src/api.ts", dest: "vendor/workers/console/src/api.ts", kind: "file" },
  { source: "workers/console/client/app.ts", dest: "vendor/workers/console/client/app.ts", kind: "file" },
  { source: "workers/console/public/app.css", dest: "public/app.css", kind: "file" },
  { source: "workers/console/public/favicon.svg", dest: "public/favicon.svg", kind: "file" },
  { source: "workers/console/public/favicon.ico", dest: "public/favicon.ico", kind: "file" },
  { source: "workers/console/public/favicon-32.png", dest: "public/favicon-32.png", kind: "file" },
  { source: "workers/console/public/apple-touch-icon.png", dest: "public/apple-touch-icon.png", kind: "file" },
  // the control-plane schema (users, passkeys, sessions, agents, grants, keys)
  { source: "migrations", dest: "migrations", kind: "dir" },
  // a deployer's copy holds only selfhost/, so it carries the licence itself
  { source: "LICENSE", dest: "LICENSE", kind: "file" },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === ".DS_Store") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every [sourceAbs, destRel] pair the mappings expand to. */
export function expand(repoRoot = root) {
  const pairs = [];
  for (const m of MAPPINGS) {
    const src = join(repoRoot, m.source);
    if (m.kind === "dir") for (const f of walk(src)) pairs.push([f, join(m.dest, relative(src, f))]);
    else pairs.push([src, m.dest]);
  }
  return pairs;
}

function main() {
  const check = process.argv.includes("--check");
  const pairs = expand();
  const files = {};
  let drift = 0;
  for (const [src, destRel] of pairs) {
    const dest = join(selfhost, destRel);
    const buf = readFileSync(src);
    files[destRel] = { source: relative(root, src), sha256: sha256(buf) };
    const same = existsSync(dest) && sha256(readFileSync(dest)) === files[destRel].sha256;
    if (same) continue;
    if (check) { console.error(`drift: selfhost/${destRel} differs from ${relative(root, src)}`); drift++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  // Files left behind in a copied directory after their source was removed.
  for (const m of MAPPINGS.filter((x) => x.kind === "dir")) {
    const d = join(selfhost, m.dest);
    if (!existsSync(d)) continue;
    for (const f of walk(d)) {
      const rel = relative(selfhost, f);
      if (files[rel]) continue;
      if (check) { console.error(`drift: selfhost/${rel} has no source`); drift++; continue; }
      rmSync(f);
    }
  }
  const manifest = JSON.stringify({ note: "Written by scripts/sync-selfhost.mjs. Do not edit vendored files; edit the source and re-run the script.", mappings: MAPPINGS, files }, null, 2) + "\n";
  const manifestPath = join(selfhost, "vendor/MANIFEST.json");
  if (check) {
    if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifest) { console.error("drift: selfhost/vendor/MANIFEST.json is stale"); drift++; }
    if (drift) { console.error(`${drift} file(s) out of sync. Run: node scripts/sync-selfhost.mjs`); process.exit(1); }
    console.log(`selfhost vendor copy in sync (${pairs.length} files)`);
    return;
  }
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifest);
  console.log(`synced ${pairs.length} files into selfhost/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
