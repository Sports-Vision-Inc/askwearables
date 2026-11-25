// Writes the OpenAPI document from the edge Worker's source of truth to the site and the SDKs, and renders
// the API reference page from it. Run: npx tsx scripts/gen-openapi.ts
// Then regenerate the TypeScript SDK types: (cd sdks/typescript && npm run generate)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openapi } from "../workers/edge/src/openapi.js";
import { renderApiDocs } from "./render-api-docs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.AW_API_HOST ?? "api.askwearables.app";
const spec = JSON.parse(JSON.stringify(openapi(host)));
const doc = JSON.stringify(spec, null, 2) + "\n";

function write(rel: string, text: string) {
  const out = resolve(root, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${rel} (${text.length} bytes)`);
}

write("workers/site/public/openapi.json", doc);
write("sdks/openapi.json", doc);
write("workers/site/public/docs/api.html", renderApiDocs(spec));
