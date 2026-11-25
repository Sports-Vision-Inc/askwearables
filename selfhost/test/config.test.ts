// The shape the Deploy to Cloudflare button needs: one Worker, every resource declared in the Wrangler
// config with a default name, secrets in .dev.vars.example, descriptions in package.json, migrations in
// the deploy script, and every dependency inside this directory at an exact version.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc, read, root } from "./helpers.js";

const wrangler = parseJsonc(read("wrangler.jsonc"));
const pkg = JSON.parse(read("package.json"));
const secrets = read(".dev.vars.example").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]!);

describe("wrangler.jsonc", () => {
  it("is one Worker on workers.dev, with no custom domain, route, service binding or cron", () => {
    expect(wrangler.name).toBe("askwearables-selfhost");
    expect(wrangler.main).toBe("src/index.ts");
    expect(wrangler.workers_dev).toBe(true);
    expect(wrangler.preview_urls).toBe(false);
    for (const k of ["routes", "route", "services", "triggers", "ratelimits", "env", "r2_buckets", "queues"]) expect(wrangler[k], k).toBeUndefined();
  });

  it("sets the compatibility flags the OAuth provider and the shared code need", () => {
    expect(wrangler.compatibility_flags).toEqual(expect.arrayContaining(["nodejs_compat", "global_fetch_strictly_public"]));
    expect(wrangler.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("declares every resource with a default name for the button to provision", () => {
    expect(wrangler.d1_databases).toEqual([{ binding: "DB", database_name: "askwearables-selfhost", migrations_dir: "migrations" }]);
    expect(wrangler.kv_namespaces).toEqual([{ binding: "OAUTH_KV" }]);
    expect(wrangler.durable_objects.bindings).toEqual([{ name: "USER_VAULT", class_name: "UserVault" }]);
    expect(wrangler.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["UserVault"] }]);
    expect(wrangler.ai).toEqual({ binding: "AI" });
    expect(wrangler.assets).toMatchObject({ directory: "./public", binding: "ASSETS", run_worker_first: true });
    expect(wrangler.vars).toEqual({ PLANNER_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", PLANNER_FALLBACK_MODEL: "@cf/openai/gpt-oss-120b" });
  });

  it("resolves the vendored packages inside this directory", () => {
    for (const [name, path] of Object.entries<string>(wrangler.alias)) {
      expect(name).toMatch(/^@askwearables\//);
      expect(path.startsWith("./vendor/")).toBe(true);
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });

  it("exports the Durable Object class it declares", () => {
    expect(read("src/index.ts")).toMatch(/export \{ UserVault \};/);
  });
});

describe("package.json and .dev.vars.example", () => {
  it("deploys (which provisions D1), then applies D1 migrations by binding name", () => {
    expect(pkg.scripts.deploy).toBe("wrangler deploy && wrangler d1 migrations apply DB --remote");
    // No "build" script: the button would pre-fill it, and public/app.js is committed already built.
    expect(pkg.scripts.build).toBeUndefined();
  });

  it("pins every dependency to an exact version", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).length).toBeGreaterThan(5);
    for (const [name, v] of Object.entries(all)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.workspaces).toBeUndefined();
    expect(JSON.stringify(all)).not.toMatch(/file:|link:|workspace:|@askwearables\//);
  });

  it("declares exactly the two secrets, with no values", () => {
    expect(secrets.sort()).toEqual(["MASTER_KEY", "OWNER_SETUP_TOKEN"]);
    expect(read(".dev.vars.example")).not.toMatch(/^[A-Z_]+=\S/m);
  });

  it("describes every secret, binding and variable for the deploy form", () => {
    const names = [...secrets, "DB", "OAUTH_KV", "USER_VAULT", "AI", ...Object.keys(wrangler.vars)];
    for (const n of names) expect(String(pkg.cloudflare.bindings[n]?.description ?? "").length, n).toBeGreaterThan(30);
    expect(pkg.cloudflare.bindings.MASTER_KEY.description).toMatch(/openssl rand -base64 32/);
  });

  it("has a lockfile and ignores local secrets", () => {
    expect(existsSync(join(root, "package-lock.json"))).toBe(true);
    expect(read(".gitignore")).toMatch(/^\.dev\.vars$/m);
  });
});

describe("README", () => {
  it("carries the Deploy to Cloudflare button for this subdirectory", () => {
    expect(read("README.md")).toContain(
      "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sports-Vision-Inc/askwearables/tree/main/selfhost)",
    );
  });
});

describe("migrations", () => {
  const files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();

  it("are present and numbered in order", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    files.forEach((f, i) => expect(f).toMatch(new RegExp(`^${String(i + 1).padStart(4, "0")}_[a-z_]+\\.sql$`)));
  });

  it("apply cleanly and create the tables the Worker uses", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    for (const f of files) db.exec(read(`migrations/${f}`));
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    for (const t of ["users", "passkeys", "sessions", "webauthn_challenges", "agents", "grants", "api_keys", "nonces"]) expect(tables, t).toContain(t);
    const userCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((r) => r.name);
    expect(userCols).toEqual(expect.arrayContaining(["terms_version", "terms_accepted_at", "age_confirmed"]));
  });
});
