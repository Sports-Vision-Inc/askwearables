import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("console on a phone", () => {
  it("folds the section links into a disclosure menu with ARIA state", () => {
    const html = read("public/index.html");
    expect(html).toMatch(/<button id="menu" type="button" aria-expanded="false" aria-controls="nav" hidden>Menu<\/button><nav id="nav" aria-label="Sections">/);
    const app = read("client/app.ts");
    expect(app).toMatch(/setAttribute\("aria-expanded", String\(open\)\)/);
    expect(app).toMatch(/ev\.key === "Escape"/);
    // The shipped bundle is built from the client source.
    expect(read("public/app.js")).toContain("aria-expanded");
  });

  it("uses 44px controls, 16px fields and type, and stacks its tables", () => {
    const css = read("public/app.css");
    expect(css).toMatch(/--tap:44px/);
    expect(css).toMatch(/body\{[^}]*font:16px\/1\.5/);
    expect(css).toMatch(/button\{[^}]*min-height:var\(--tap\)/);
    expect(css).toMatch(/input,select,textarea\{[^}]*font-size:max\(16px,1em\);min-height:var\(--tap\)/);
    expect(css).toMatch(/nav a\{[^}]*min-height:var\(--tap\)/);
    expect(css).toMatch(/color-scheme:light dark/);
    // Dark theme: text on the accent button is dark, not white on light blue.
    expect(css).toMatch(/prefers-color-scheme:dark\)\{:root\{[^}]*--on-accent:#0b1430/);
    expect(css).toMatch(/table\.stack thead\{display:none\}/);
    const app = read("client/app.ts");
    expect(app.match(/<table class="stack">/g)?.length).toBe(3);
    for (const l of ["Device", "Last sync", "Purpose", "Expires", "Decision", "Reasons"]) expect(app).toContain(`data-label="${l}"`);
  });
});
