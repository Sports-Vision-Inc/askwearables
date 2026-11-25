// Bundles the console's browser code and the streaming Apple Health importer (both vendored unchanged)
// into public/app.js. The output is committed, so a deploy does not need to run this.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Options shared with test/client-bundle.test.ts, which checks public/app.js is current. */
export const clientBuildOptions = {
  entryPoints: [resolve(root, "vendor/workers/console/client/app.ts")],
  bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false, platform: "browser", logLevel: "warning",
  alias: {
    "@askwearables/core": resolve(root, "vendor/core/src/index.ts"),
    "@askwearables/importers": resolve(root, "vendor/importers/src/index.ts"),
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build({ ...clientBuildOptions, outfile: resolve(root, "public/app.js") });
  console.log("public/app.js built");
}
