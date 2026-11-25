// selfhost/vendor (and the synced public assets, migrations and LICENSE) are copies of shared code, made by
// scripts/sync-selfhost.mjs at the repository root. In the monorepo this fails when a copy drifts from its
// source; in a deployer's copy of selfhost/ alone it still checks the copies against the manifest.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf, repoRoot, root } from "./helpers.js";

interface Mapping { source: string; dest: string; kind: "dir" | "file" }
const manifest = JSON.parse(readFileSync(join(root, "vendor/MANIFEST.json"), "utf8")) as { mappings: Mapping[]; files: Record<string, { source: string; sha256: string }> };
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const walk = (d: string): string[] => readdirSync(d).filter((n) => n !== ".DS_Store").flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const inMonorepo = existsSync(join(repoRoot, "packages/core/src/index.ts")) && existsSync(join(repoRoot, "scripts/sync-selfhost.mjs"));

describe("vendored copies", () => {
  it("cover packages/core and packages/importers", () => {
    expect(manifest.mappings).toEqual(expect.arrayContaining([
      { source: "packages/core/src", dest: "vendor/core/src", kind: "dir" },
      { source: "packages/importers/src", dest: "vendor/importers/src", kind: "dir" },
    ]));
  });

  it("match the manifest", () => {
    for (const [dest, { sha256 }] of Object.entries(manifest.files)) expect(sha(join(root, dest)), dest).toBe(sha256);
  });

  it("hold no file the manifest does not list", () => {
    for (const m of manifest.mappings.filter((x) => x.kind === "dir")) {
      for (const f of walk(join(root, m.dest))) expect(manifest.files[relative(root, f)], relative(root, f)).toBeDefined();
    }
  });

  it.skipIf(!inMonorepo)("match their sources in the repository (run `node scripts/sync-selfhost.mjs` if not)", () => {
    const expected = new Map<string, string>();
    for (const m of manifest.mappings) {
      const src = join(repoRoot, m.source);
      if (m.kind === "dir") for (const f of walk(src)) expected.set(join(m.dest, relative(src, f)), f);
      else expected.set(m.dest, src);
    }
    expect([...expected.keys()].sort()).toEqual(Object.keys(manifest.files).sort());
    for (const [dest, src] of expected) expect(sha(join(root, dest)), `selfhost/${dest} vs ${relative(repoRoot, src)}`).toBe(sha(src));
  });

  it.skipIf(!inMonorepo)("include the same list of mappings as the sync script", async () => {
    const { MAPPINGS } = await import(join(repoRoot, "scripts/sync-selfhost.mjs"));
    expect(manifest.mappings).toEqual(MAPPINGS);
  });
});

describe("isolation", () => {
  it("no source file imports anything outside selfhost/", () => {
    const files = [...walk(join(root, "src")), ...walk(join(root, "vendor")), ...walk(join(root, "scripts"))].filter((f) => /\.(ts|mjs|js)$/.test(f));
    let checked = 0;
    for (const f of files) {
      for (const spec of importsOf(readFileSync(f, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(f), spec);
        expect(relative(root, target).startsWith(".."), `${relative(root, f)} imports ${spec}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("bare imports are declared dependencies, Node built-ins, or the aliased vendored packages", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const deps = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies), "@askwearables/core", "@askwearables/importers", "cloudflare:workers"]);
    const files = [...walk(join(root, "src")), ...walk(join(root, "vendor"))].filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      for (const spec of importsOf(readFileSync(f, "utf8"))) {
        if (spec.startsWith(".")) continue;
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (name.startsWith("node:")) continue;
        expect(deps.has(name), `${relative(root, f)} imports ${spec}`).toBe(true);
      }
    }
  });
});
