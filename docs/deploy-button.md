> **Status (2026-11-25): live.** The button deploys `selfhost/` from https://github.com/Sports-Vision-Inc/askwearables/tree/main/selfhost. A test deploy confirmed Cloudflare auto-provisions the D1 database and KV namespace; the deploy script runs `wrangler deploy` before the D1 migrations so the database exists first.

# Deploy to Cloudflare button

Status: **not enabled.** The site shows the button in a disabled state with an explanation and the manual steps. This file says why, and what would have to change to turn it on.

Source for every rule below: https://developers.cloudflare.com/workers/platform/deploy-buttons/ (page modified 2026-10-12). Research notes with quotes are in `docs/site-research.md`.

## Where the button lives and how to change it

- `scripts/build-site-data.mjs` holds two constants:
  - `DEPLOY_REPO_URL`. The placeholder is `https://github.com/YOUR-ORG/askwearables`. For a subdirectory, use a tree URL such as `https://github.com/<org>/<repo>/tree/main/<path>`.
  - `DEPLOY_BUTTON_ENABLED`. Set it to `false` today.
- Running `node scripts/build-site-data.mjs` rewrites everything between `<!-- deploy-button -->` and `<!-- /deploy-button -->` in two pages: `workers/site/public/index.html` (Self-host section) and `workers/site/public/docs/self-hosting.html`.
  - With the flag on, the result is an `<a>` to `https://deploy.workers.cloudflare.com/?url=<DEPLOY_REPO_URL>`.
  - With the flag off, it is a disabled `<span>`.
- The button is drawn with CSS and an inline SVG. It does not use Cloudflare's hosted image (`https://deploy.workers.cloudflare.com/button`), because the site's CSP and tests allow images only from this origin. Edit the explanatory text on both pages when you change the state.

## What the button requires

1. **A public repository on github.com or gitlab.com.** Self-hosted GitHub and GitLab are not supported. Cloudflare clones the repository into the deploying user's account and builds it with Workers Builds.
2. **Workers only.** Pages projects are not supported.
3. **One application per button.** For a subdirectory, the docs say the application "must be fully isolated within that subdirectory, including any dependencies. Otherwise, the build will fail."
4. **Resources declared in the Wrangler config, with default names and ids.**
   - The button can provision KV, D1, R2, Hyperdrive, Vectorize, Secrets Store secrets, Durable Objects, Workers AI and Queues.
   - It writes the new ids back into the user's copy of the config.
5. **Variables in `vars`. Secrets in `.dev.vars.example` or `.env.example`.** The user is prompted for these at deploy time.
   - Each binding can carry a description in `package.json` under `"cloudflare": { "bindings": { "NAME": { "description": "…" } } }`.
6. **Build and deploy commands.**
   - The button pre-fills them from the `build` and `deploy` scripts in `package.json`.
   - With no `deploy` script, it runs `npx wrangler deploy`.
   - D1 migrations belong in the `deploy` script and should name the binding, not the database: `wrangler d1 migrations apply DB --remote && wrangler deploy`.
7. **Multi-Worker projects are not deployed together.** The docs say: "Cloudflare does not fully support monorepos … if you have a monorepo that contains multiple Workers applications, they will not be deployed together. You must configure a separate Deploy to Cloudflare button for each application."
8. **Not documented:** how the button handles service bindings to other Workers, custom-domain `routes`, cron triggers and the rate-limit binding. Treat all four as unsupported until tested.

## Why AskWearables cannot use it as is

The broker is seven Workers (site, console, auth, edge, planner, gate, vault), and they depend on each other in several ways:

- **Service bindings:** edge binds auth, gate and planner; auth binds gate; console binds gate; gate binds vault and auth. A button deploys one Worker, so the bound Workers would not exist.
- **Shared code:** the Workers import `@askwearables/core` from `packages/`, and some import each other's `src/rpc.js`. No Worker directory is self-contained, so a per-Worker button build would fail.
- **Shared D1 database:** auth and gate share `askwearables-control`, whose migrations live in `/migrations` at the repository root, outside any Worker directory.
- **Undocumented features:** custom-domain routes on every Worker, crons on auth and gate, and the rate-limit binding on edge.

What a button would have to provision, if a single-Worker or fully isolated template is ever made:

| Binding | Kind | Worker today |
|---|---|---|
| `DB` | D1 (`askwearables-control`) | auth, gate |
| `OAUTH_KV` | KV | auth |
| `USER_VAULT` | Durable Object class (SQLite) | vault |
| `ANCHORS` | R2 (`askwearables-anchors`) | vault |
| `AI` | Workers AI | planner |
| `MASTER_KEY` | secret: 32 random bytes, base64 (`openssl rand -base64 32`). Losing it makes stored data unreadable | vault |
| `GATE_SECRET` | secret: 32 random bytes, base64 | gate |
| `OWNER_SETUP_TOKEN` | secret: one-time owner setup token (`openssl rand -hex 24`) | auth |
| `ISSUER`, `MCP_RESOURCE`, `API_RESOURCE`, `MCP_HOST`, `API_HOST`, `RP_ID`, `COOKIE_DOMAIN`, `CONSOLE_URL`, `CONSOLE_ORIGIN`, `AUTH_URL`, `PLANNER_MODEL`, `PLANNER_FALLBACK_MODEL` | vars, all host-specific | various |

## Options

1. **Keep the manual path (current).** `docs/self-hosting.html` lists the steps: create the resources, set the three secrets, set the host vars, apply migrations, and deploy in the order vault, gate, planner, auth, edge, console, site.
   - Note: the root `package.json` has `"deploy": "npm run build:console && node scripts/deploy.mjs"`, but `scripts/deploy.mjs` does not exist in this tree. Add it, or drop the script, before you document `npm run deploy`.
2. **One button per Worker.** First make each `workers/<name>` self-contained: vendor or publish `@askwearables/core`, remove the cross-imports, and give each D1 user its own migrations folder. Then test how service bindings resolve when the Workers are deployed separately, and publish seven buttons in dependency order. This is fragile, and it still leaves custom domains and secrets to set by hand.
3. **A single-Worker "personal" template.** Collapse edge, planner, gate and vault into one Worker for a single owner. It would declare D1, KV, R2, the Durable Object, Workers AI and the three secrets in one config, with a `deploy` script that applies migrations. This is the only shape the button fully supports, but it gives up the four trust zones that the main design relies on, and the page would have to say so.
4. **A button for the static site only.** `workers/site` has no bindings, but it imports nothing from outside its directory only at runtime: its tests import `workers/edge` and `scripts/`. It would deploy the docs and results pages, not the broker. That is of little use for self-hosting, and offering it could mislead people.

To turn the button on later:
1. Publish the repository.
2. Set `DEPLOY_REPO_URL` (and a `/tree/main/<path>` if it points at a template subdirectory).
3. Set `DEPLOY_BUTTON_ENABLED = true`.
4. Rewrite the explanatory paragraph on both pages.
5. Run `node scripts/build-site-data.mjs`.
6. Run `npx vitest run workers/site`.
