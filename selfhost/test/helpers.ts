import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** selfhost/ */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository root when this runs inside the monorepo; absent in a deployer's copy of selfhost/ alone. */
export const repoRoot = resolve(root, "..");
export const read = (f: string) => readFileSync(join(root, f), "utf8");

/** JSONC to JSON: drops // and block comments outside strings, then trailing commas. */
export function parseJsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Module specifiers of the static imports, re-exports and dynamic imports in a source file. */
export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}
