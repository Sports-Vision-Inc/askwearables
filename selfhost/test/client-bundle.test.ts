// public/app.js is committed so a deploy needs no build step; it must be the bundle of the vendored client.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { root } from "./helpers.js";

describe("console bundle", () => {
  it("public/app.js is current (run `npm run build:client` if not)", async () => {
    const { clientBuildOptions } = await import(join(root, "scripts/build-client.mjs"));
    const out = await build({ ...clientBuildOptions, write: false, outfile: join(root, "public/app.js") });
    expect(out.outputFiles?.[0]?.text).toBe(readFileSync(join(root, "public/app.js"), "utf8"));
  });

  it("the console page marks itself self-hosted, links the LICENSE, and loads only its own script", () => {
    const html = readFileSync(join(root, "public/index.html"), "utf8");
    expect(html).toContain('<html lang="en" data-selfhost="1">');
    expect(html).toContain("Sports Vision does not see it");
    expect(html).toContain("https://github.com/Sports-Vision-Inc/askwearables/blob/main/LICENSE");
    expect([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual(["/app.js"]);
  });
});
