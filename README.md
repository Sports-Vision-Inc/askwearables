# AskWearables

A broker between wearable data and AI agents. An agent asks a question; AskWearables plans it into a typed query, checks it against the user's grant, computes the answer in tested code, and returns a small context packet at the coarsest level that answers it, with a receipt.

Live: [askwearables.app](https://askwearables.app) · console [app.askwearables.app](https://app.askwearables.app) · MCP `https://mcp.askwearables.app/mcp` · REST `https://api.askwearables.app/v1` ([OpenAPI](https://api.askwearables.app/v1/openapi.json))

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Data model, metric catalogue, store, compute engine (8 operations), packets, gate, receipts, LLM planner |
| `packages/connectors` | Oura, WHOOP, Google Health, Garmin, Polar, Strava (disabled), Open Wearables; all flags off |
| `packages/importers` | Streaming Apple Health export.xml, PMData, LifeSnaps, PHIA, MMASH |
| `workers/*` | site, console, auth, edge, planner, gate, vault (Cloudflare Workers, four trust zones) |
| `mobile/ios`, `mobile/android` | HealthKit and Health Connect sync apps (build; not submitted to stores) |
| `sdks/typescript`, `sdks/python` | Clients with request signing |
| `eval/` | Dataset fetchers, PHIA evaluation, and the paper's study (`eval/paper`) |
| `docs/` | Plan, decisions, threat model, release checklist, provider notes, datasets, paper draft |

## Develop

```sh
npm install
npm run db:migrate:local
npm run dev            # all Workers locally under wrangler dev
npm test               # 241 tests
./scripts/e2e-local.sh # end to end against the local system
```

Secrets (`MASTER_KEY` for vault, `GATE_SECRET` for gate, `OWNER_SETUP_TOKEN` for auth) go in each Worker's `.dev.vars` locally and in Workers secrets in production. Never commit them.

## Evaluate

```sh
./eval/paper/run-lane1.sh                     # open models on Workers AI
./eval/paper/run-lane2.sh                     # frontier and free models via OpenRouter (OPENROUTER_API_KEY)
eval/.venv/bin/python eval/paper/report.py    # tables and figures → eval/paper/out/
npm run eval:phia -w @askwearables/eval       # compute engine against PHIA reference answers
```
