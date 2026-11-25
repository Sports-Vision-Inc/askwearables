// Bundles the console's browser code (and the streaming importer) into public/app.js.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [resolve(root, "workers/console/client/app.ts")],
  bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false,
  outfile: resolve(root, "workers/console/public/app.js"), platform: "browser", logLevel: "warning",
});
console.log("console bundle built");
