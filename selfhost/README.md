# AskWearables, self-host edition

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sports-Vision-Inc/askwearables/tree/main/selfhost)

Run your own copy of AskWearables in your Cloudflare account, for your own data. AI agents such as Claude connect to it over MCP or a REST API, ask questions about your wearable data in plain language, and get small computed answers back at the level of detail you allowed. Every answer and every refusal is written to a receipt log you can check.

**You run this instance.** Your data stays in your Cloudflare account. Sports Vision does not see it, cannot recover it, and does not operate your copy. The software is provided under the [MIT License](https://github.com/Sports-Vision-Inc/askwearables/blob/main/LICENSE), as is, without warranty. Its answers are not medical advice.

## What you get

One Cloudflare Worker on `https://askwearables-selfhost.<your-subdomain>.workers.dev` with:

- **An MCP server** at `/mcp` with three tools: `ask`, `list_capabilities` and `get_packet`.
- **A REST API** under `/v1`:
  - Agents, with an OAuth token: `POST /v1/ask`, `POST /v1/query`, `GET /v1/capabilities`, `GET /v1/packets/{id}`.
  - You, with an owner key (`aw_own_…`): `POST /v1/ingest`, `POST /v1/query`, `GET /v1/receipts`, `GET /v1/status`, `GET /v1/export`, `POST /v1/pause`, `DELETE /v1/grants/{id}`.
  - A phone, with a sync key (`aw_sync_…`): `POST /v1/ingest`.
- **OAuth 2.1 for agents.** Agents register themselves, use PKCE, and see the same eight-item consent screen as the hosted service. You choose the purpose, the metrics, the level of detail, the window, a daily limit and an expiry date.
- **The same planner.** Workers AI turns a question into a query: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` first, then `@cf/openai/gpt-oss-120b`. The result is validated in code; anything invalid is refused.
- **The same gate, compute and receipts.** They run in one Durable Object (SQLite) that holds your health data encrypted with your `MASTER_KEY`. It keeps a hash-chained receipt log and the daily budgets.
- **Sign-in with a passkey.** There are no passwords and no third-party scripts; the WebAuthn helper is served by the Worker itself.
- **A console** at `/`. It shows your sources and their freshness, and lets you:
  - import an Apple Health `export.xml` (it is parsed in your browser, and only computed records are uploaded),
  - list and revoke agents,
  - read your receipts and verify the hash chain,
  - pause all answers,
  - export everything, or delete everything.

## How it differs from the hosted service

The hosted service at askwearables.app runs as **seven Workers in separate trust zones**: site, console, auth, edge, planner, gate and vault. Each has only the bindings it needs. For example, the Worker that reads agent requests has no binding to your data, and the planner never sees any data.

**This edition runs the same code in one Worker.** That is what makes a one-click deploy possible, and it gives up that separation. A bug in any part (MCP handling, the console, sign-in) runs in the same isolate as the code that holds your data key and can reach your data. The gate still re-checks every request, and every answer is still receipted, but nothing outside the Worker enforces those boundaries. We think that is a reasonable trade for one person hosting their own data. If you need the zones, deploy the seven Workers from the repository root as described in `docs/self-hosting`.

Other differences:

- **One owner.** There are no developer keys, end users or hosted consent links. The `/v1/users`, `/v1/grants` (create), `/v1/usage` and `/v1/developer` routes return 404.
- **No external anchoring.** The hosted service copies each day's receipt-chain head to R2, so tampering can be detected from outside. Here the chain is verified only inside the Worker.
- **No cron jobs.** Expired sessions and challenges are cleaned up during sign-in traffic, and expired OAuth records expire through their KV TTLs.
- **workers.dev only.** There are no custom domains or routes. You can add a custom domain later in the dashboard; see "Changing the address" below.

## Deploy

1. Click **Deploy to Cloudflare** above. Cloudflare copies this directory into a new GitHub or GitLab repository of yours. It then creates the D1 database, KV namespace and Durable Object, and runs `npm run deploy`, which applies the D1 migrations and deploys the Worker.
2. When asked for secrets, enter:
   - `MASTER_KEY`: 32 random bytes, base64. Run `openssl rand -base64 32`. **Keep a copy.** If you lose or change it, your stored data cannot be read.
   - `OWNER_SETUP_TOKEN`: a one-time token. Run `openssl rand -hex 24`.

## After deploying

1. **Create your passkey.** Open `https://<your-worker>.workers.dev/setup?token=<OWNER_SETUP_TOKEN>`. Accept the terms (you are the operator; the page links to the MIT License), then create a passkey. The setup link stops working once the passkey exists.
2. **Import data.** In the console at `https://<your-worker>.workers.dev/`, set your time zone, then import Apple Health. On your iPhone, open Health, tap your profile picture, then Export All Health Data. Unzip the file and choose `export.xml`. A large export takes a few minutes.
3. **Connect Claude or another MCP client** to `https://<your-worker>.workers.dev/mcp`.
   - In Claude, go to Settings, then Connectors, then Add custom connector, and paste that URL.
   - The client opens your consent screen. Sign in with your passkey if asked, choose what to allow, and approve.
4. **Check the receipts** in the console. Every answer an agent received, and every refusal, is listed there, and the hash chain is verified each time you load the page.

To use the REST API yourself, create an owner key under **Keys** in the console. Then call the API with it, for example:

```sh
curl -H "Authorization: Bearer aw_own_…" https://<your-worker>.workers.dev/v1/receipts
```

## Costs

- **Workers AI** is the main running cost. Each question an agent asks makes one or two model calls (the fallback model is used only when the first fails). Workers AI is billed in neurons and includes a daily free allocation. A personal instance answering a few dozen questions a day usually stays within or near it. Check current prices at https://developers.cloudflare.com/workers-ai/platform/pricing/.
- **Workers, Durable Objects (SQLite), D1 and KV** usage for one person fits the Workers Free plan's daily limits for typical use. Large Apple Health imports write many rows once. Check the limits at https://developers.cloudflare.com/workers/platform/pricing/.
- **The console's Ask box** uses fixed keyword rules, not Workers AI, so it costs nothing.

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in both values
npm run dev                      # applies the local D1 migrations, then runs wrangler dev
```

Open `http://localhost:8787/setup?token=<OWNER_SETUP_TOKEN>`.

- The AI binding always calls Cloudflare, even in local development. It needs `wrangler login`, and its usage is billed to that account.
- Logged out, the planner falls back to keyword rules.

Checks:

```sh
npx tsc --noEmit                 # types
npm test                         # config shape, migrations, vendored copies, console bundle
npm run e2e                      # starts its own wrangler dev on throwaway state and runs every flow
```

The end-to-end script uses a software passkey, so it exercises real WebAuthn registration and sign-in. It then:

- imports a synthetic `export.xml` through the console's importer,
- connects an agent over OAuth and asks over REST and MCP,
- checks the receipts,
- revokes the agent, pauses answers, exports, and deletes everything.

## Manual deploy without the button

```sh
npm install
npx wrangler login
npx wrangler deploy                              # creates the D1 database, KV namespace and Durable Object
npx wrangler secret put MASTER_KEY
npx wrangler secret put OWNER_SETUP_TOKEN
npm run deploy                                   # applies migrations to the new database, then deploys again
```

## Changing the address

The OAuth issuer and the protected resource are both derived from the address each request arrives on. If you add a custom domain later:

- Agents connected through the old address must reconnect through the new one.
- Your passkey is tied to the host name it was created on, so create a new passkey on the new host. Sign in on the old address, then add one from the console.

## Where the code comes from

- `src/` is the only code written for this edition. It wires the shared zones together in one Worker and adds the setup page's licence copy.
- Everything under `vendor/` is copied unchanged from the main repository:
  - `packages/core` and `packages/importers`,
  - the auth, edge, gate, vault, planner and console code under `workers/`.
- `migrations/`, `LICENSE` and the console's styles and icons in `public/` are also copied unchanged.
- `vendor/MANIFEST.json` records each file's source and hash.
- In the main repository, `node scripts/sync-selfhost.mjs` refreshes the copies, and `selfhost/test/vendor-sync.test.ts` fails if they drift.
