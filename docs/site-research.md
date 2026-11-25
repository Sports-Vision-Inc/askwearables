# Site research for the askwearables.app redesign

Fetched 2026-11-24 with WebFetch. Page descriptions come from text extraction, so visual layout and imagery were not seen directly. Items that could not be verified are marked **[unverified]**.

---

## 1. Open Wearables: https://openwearables.io

What works
- Hero headline "The wearable data layer, in your own cloud" says what the product is and where it runs in one line. The subhead covers devices, raw payloads, and scores or coaching.
- Proof sits above the fold: GitHub star count (2.6k), "open source / self-hosted / MIT" tags, and a row of nine customer logos.
- Two CTAs only: "Get started" (goes to the docs quickstart) and "Book a demo".
- The integrations grid lists 14 providers (Garmin, Whoop, Oura, Polar, Apple Health, Health Connect, ...) under "one schema".
- Case studies give a concrete number: one engineer connected six providers for about 90k users.
- An FAQ answers buyer objections (HIPAA/GDPR, DPAs, credentials, self-hosting).

Gaps: no code snippet or install command on the page. The FAQ says load-test results are "published", but no figures appear.

Borrow
- Put a short line of open-source and self-host proof (license, repo, deploy-it-yourself) next to the main CTA.
- Add a provider grid that names exactly which sources are supported today.

## 2. Wearable Context: https://wearablecontext.com (closest competitor)

What works
- The headline "Your body knows. Now your AI can listen." sits under the eyebrow "Private wearable context for your AI". The page frames the product as a gateway between wearables and AI clients, not as a dashboard.
- The hero carries three trust badges: Read-only, Encrypted access, Disconnect any time.
- The main demo is a sample "context" card (WHOOP recovery 82%, sleep 7:42h, HRV 68 ms, RHR 52) labeled as available through MCP. It shows the output instead of describing it.
- A three-step "How it works" ends with "one remote MCP URL, sign in, approve access".
- A data-categories list names cycles, recovery, sleep, workouts, body measurements, and "deterministic trends".

Gaps: no logos, numbers, code, MCP config snippet, or docs link. Only one provider (WHOOP) is named.

Borrow
- Put a real context packet, including its receipt, in the hero as the main visual.
- Show the trust properties (read-only, grant-scoped, revocable) as badges, and back each one with a link.
- Beat it on developer proof: a copyable MCP config snippet and REST curl, which this site lacks.

## 3. Spike API: https://www.spikeapi.com

What works
- The headline "360° Health Data for AI" comes with a flow diagram: six input types go through normalize, standardize, and encrypt steps and come out as "AI-ready data via API".
- A row of stats: 200+ customers, 1M+ users connected, 1B+ data points, 500+ integrations, "1 API".
- A logo wall, six named testimonials that each link to a case study, an "As seen on" press row, and CCPA/GDPR/HIPAA/ISO badges in the footer.
- Developer reassurance: a sandbox ("Start testing right away") and a dedicated implementation engineer.

Gaps: every CTA is "Book a demo", and the page has no code. Some "Start with…" buttons link to "#" or the wrong product, which looks like copy-paste errors and hurts credibility.

Borrow
- Use a single left-to-right pipeline diagram as the one-screen explanation: agent, plan, grant check, compute, packet plus receipt.
- Use stat tiles, but only with numbers we can defend (test count, query types, p50 latency). Do not use vanity numbers.

## 4. Cloudflare Workers and D1 product pages

URLs: https://www.cloudflare.com/products/workers/ (https://workers.cloudflare.com 301-redirects there) and https://www.cloudflare.com/developer-platform/products/d1/

What works
- Each page has a one-line definition first: Workers are "fast, elastic, and serverless functions that scale automatically from zero to millions of requests". D1 is "Serverless SQLite database with global read replication, native Worker integration, and time travel backups".
- Feature lists are short and concrete (V8 isolates, 330+ cities, Cron Triggers, 30-day time travel).
- Both pages use the same structure: Key Features, Benefits, Use Cases, Resources, Related Products.
- CTAs are consistent: "Get Started", "Full Documentation", "Pricing".

Caveat: the fetch returned the markdown version of each page, which had no logos, code, or `npm create` command. The rendered page may show more **[unverified]**.

Borrow
- Keep one consistent block order across every page, and put a one-sentence definition at the top.
- Use a "Related" strip to cross-link the MCP, REST, Console, and Docs pages.

## 5. Berkeley Function-Calling Leaderboard (BFCL): https://gorilla.cs.berkeley.edu/leaderboard.html

What works
- The version and date are on the page: "BFCL V4", "Last Updated: 2026-04-12", plus a changelog link.
- Table columns: Overall Accuracy (defined as an "unweighted average of all the sub-categories"), Cost (estimated USD for the full run), Latency (s), and Mode (FC vs Prompt). Columns sort and there is a search box.
- A "Wagon Wheel" radar chart compares the models you pick across categories.
- Reproducibility is explicit: evaluated at commit `f7cf735`, model responses published in a GitHub repo, and a pinned PyPI package `bfcl-eval==2025.12.17`.
- Caveats are stated: the overall score is unweighted, and the data is "updated periodically".

Borrow
- Stamp every benchmark table with its version, date, and commit, and link the raw outputs.
- Define each metric in one sentence directly under the table.

## 6. Artificial Analysis: https://artificialanalysis.ai

What works
- Each headline card states its direction ("Higher is better" / "Lower is better").
- Scatter plots of quality vs cost per task mark the "most attractive quadrant" and a Pareto line. A stacked bar splits cost by token type.
- Indexes carry versions (Intelligence Index v5.0.2, Coding Agent Index v2.1) and link to methodology pages. A changelog sidebar holds dated entries.
- Filters show their scope as counts ("28 of 765 models", "23 of 46 evaluations").

Borrow
- Add a direction hint to each metric, and plot accuracy against latency or cost so trade-offs are visible.
- Show a visible, dated changelog of benchmark runs.

## 7. Arena (formerly LMArena): https://arena.ai/leaderboard

lmarena.ai/leaderboard 301-redirects here.

- The Agent leaderboard shows the top 15 with rank, organization, a linked model name, Index, $/task, and Time/task. Models on the cost/time Pareto frontier get an "On the Pareto frontier" tag.
- A "Best score for the cost" chart uses a log-scale cost axis. Costs are labeled "Median cost per task (last 14 days)".
- Methodology is a top-level navigation item. No "last updated" date and no confidence intervals were visible in the extract **[unverified for the rendered page]**.

Borrow: a Pareto or "best for the cost" tag, and window labels on rolling metrics.

## 8. SWE-bench: https://www.swebench.com

Partially loaded. The extract was truncated, so the results table columns were not visible **[unverified]**.

- "Official Leaderboards" has tabs for Verified, Multimodal, Multilingual, Lite, and Full, plus a "Compare results" action and a "Bash Only" variant.
- /verified.html has a collapsible methodology note and warns that release 1.x and 2.x results "aren't directly comparable". It links a reproduction guide and a Submit page.

Borrow: split benchmark tabs by dataset or split, and warn when runs are not comparable.

---

## Deploy to Cloudflare button

Source: https://developers.cloudflare.com/workers/platform/deploy-buttons/ (dateModified 2026-10-12). All quotes below come from that page.

**Markup / URL**
- Markdown: `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<your git repo URL>)`
- HTML: `<a href="https://deploy.workers.cloudflare.com/?url=<YOUR_REPO_URL>"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/></a>`
- Subdirectory: pass the tree URL, e.g. `https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/saas-admin-template`. The doc says: "You can also optionally specify a subdirectory."
- From the dashboard: the doc says you can "generate a Deploy to Cloudflare button directly from the Cloudflare dashboard by selecting the share button (located within your Worker details)".

**Repo requirements**
- "Repositories must be public in order for others to successfully use your Deploy to Cloudflare button."
- "Source repositories from anything other than github.com and gitlab.com are not supported. Self-hosted versions of GitHub and GitLab are also not supported."
- "Cloudflare clones your source repository into the user's GitHub/GitLab account". It then builds with Workers Builds.
- Subdirectories: "your application must be fully isolated within that subdirectory, including any dependencies. Otherwise, the build will fail. Cloudflare treats this subdirectory as the root of the new repository".
- "Deploy to Cloudflare buttons only support Workers applications" (not Pages).

**Resource provisioning**
- Supported: "KV namespaces, D1 databases, R2 buckets, Hyperdrive, Vectorize databases, and Secrets Store Secrets" (storage) and "Durable Objects, Workers AI, and Queues" (compute).
- "Cloudflare will read the Wrangler configuration file of your source repo to determine resource requirements ... provision any necessary resources and update the Wrangler configuration where applicable for newly created resources (e.g. database IDs and namespace IDs)."
- "please make sure your source repository includes default values for resource names, resource IDs and any other properties for each binding."
- On the setup page, users can customize "repository name, Worker name, and required resource names".

**Env vars and secrets**
- Vars: "can be defined in your Wrangler configuration file as normal" (`vars`).
- Secrets: "can be defined in a `.dev.vars.example` or `.env.example` file with a dotenv format", e.g. `COOKIE_SIGNING_KEY=my-secret # comment`.
- Secrets Store: via `secrets_store_secrets` in the Wrangler config.
- Binding descriptions go in `package.json`. The doc says "you can provide a description in your `package.json`" and supports inline markdown:
  `"cloudflare": { "bindings": { "COOKIE_SIGNING_KEY": { "description": "Generate a random string using \`openssl rand -hex 32\`." } } }`

**Build, deploy, and D1 migrations**
- "If you are using custom `build` and `deploy` scripts in your `package.json` ... Cloudflare will automatically detect and pre-populate the build and deploy fields."
- "If no `deploy` script is specified, Cloudflare will preconfigure `npx wrangler deploy` by default. If no `build` script is specified, Cloudflare will leave this field blank."
- Migrations: run them in `deploy`. The doc says "The migration command should reference the binding name rather than the database name". Example:
  `"deploy": "npm run db:migrations:apply && wrangler deploy"`, `"db:migrations:apply": "wrangler d1 migrations apply DB_BINDING --remote"`.

**Multi-Worker and monorepo limitation**
- "Cloudflare does not fully support monorepos."
- "if you have a monorepo that contains multiple Workers applications, they will not be deployed together. You must configure a separate Deploy to Cloudflare button for each application. The user will manually create a distinct Workers application for each subdirectory."
- **Not documented:** service bindings, `routes` and custom domains, `workers_dev`, cron triggers, and the rate-limit binding (`ratelimits`). None of these appear in the supported-resource list. I found no documentation on how a service binding to another Worker resolves after a button deploy **[unverified]**.
- For monorepos, Workers Builds (not the button) supports one connected repo per Worker, "with the root directory of each Worker set to where its Wrangler configuration file is located" (https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/).

**How this applies to AskWearables** (checked by reading `workers/*/wrangler.jsonc` and the root `package.json`)
- The project has 7 Workers. Their service bindings: edge → auth, gate, planner; auth → gate; console → gate; gate → vault, auth.
- Shared D1 `askwearables-control` (binding `DB`) is used by auth and gate. auth also has KV `OAUTH_KV`, and vault has the Durable Object `UserVault` and R2 `ANCHORS`. planner has Workers AI. edge has the `ratelimits` binding, and auth and gate have crons. Every Worker except site uses custom-domain `routes` with `workers_dev: false`.
- Workers import `@askwearables/core` and cross-import `../../<worker>/src/rpc.js`. The D1 `migrations_dir` is `../../migrations`. That breaks the "fully isolated within that subdirectory" rule, so a per-Worker button would fail to build.
- The root `deploy` script is `node scripts/deploy.mjs`, not a single `wrangler deploy`.
- Conclusion: one button cannot deploy the full broker. A button could work for `workers/site` alone, but it would still need the routes question checked **[unverified]**. A full self-host needs a documented `npm run deploy` path, or a purpose-built single-Worker template.

---

## Takeaways for askwearables.app

1. **Show the packet in the hero.** Fill the first screen with one question, the typed plan, the grant check, and the small context packet with its receipt. Wearable Context's sample card shows this works, and Spike's pipeline diagram shows how to explain the flow.
2. **Lead with copyable developer entry points.** Put an MCP config snippet and a REST curl right below the hero. None of the three wearable competitors shows code, so this is open ground.
3. **Use proof we can verify, not vanity stats.** Show trust badges (read-only, grant-scoped, revocable, receipts) that each link to the threat model, a "computed in tested code" claim with the test count, and a provider grid naming today's real sources. Open Wearables' repo and license line beside the CTA is the model.
4. **Make benchmark results reproducible.** Stamp each table with version, date, and commit (as BFCL does), define each metric with its direction (as Artificial Analysis does), plot accuracy vs latency or cost with a Pareto tag (as Arena does), link the raw outputs, and state caveats and non-comparability (as SWE-bench does).
5. **Be honest about self-hosting.** Cloudflare's button deploys one isolated Worker from a public GitHub or GitLab repo, and it does not document service bindings, routes, crons, or rate limits. Do not promise "one-click deploy" for the 7-Worker broker. Offer a documented `npm run deploy` quickstart, which needs MASTER_KEY, GATE_SECRET, and OWNER_SETUP_TOKEN. Consider a button only for the static site or a future single-Worker template.
