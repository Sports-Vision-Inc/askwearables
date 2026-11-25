// Regenerates src/schema.ts from ../openapi.json (written by scripts/gen-openapi.ts at the repo root).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.js";

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(here, "../../openapi.json"), "utf8"));
writeFileSync(resolve(here, "../src/schema.ts"), generate(spec));
console.log("wrote src/schema.ts");
