# Threat model

Internal model, written 2026-11-24. An outside security review is still required before the gate is signed off.

## Assets

| Asset | Where it lives | Who can read it |
| --- | --- | --- |
| Health samples, sessions, rollups | One SQLite Durable Object per user, in vault | vault only |
| Provider OAuth tokens | Encrypted in the user's Durable Object | vault ingestion only |
| Receipt payloads | Encrypted in the user's Durable Object | owner via gate |
| Grants, agents, users, API key hashes | D1 | auth, gate |
| Agent access and refresh tokens | KV, stored hashed by the OAuth library | auth |
| Master key, gate secret | Workers secrets | vault, gate |

## Trust zones

Public (site, console) → Identity (auth) → Request path (edge, planner) → Protected (gate, vault). The bindings are tested in `workers/edge/test/trust-zones.test.ts`. Edge and planner have no binding to data or policy. Gate and vault have no public route.

## Threats and responses

| Threat | Response | Test |
| --- | --- | --- |
| Agent asks beyond its grant (metric, level, window) | Gate denies the metric, clamps the window, caps the level | `gate.test.ts` decision-order tests; 50 adversarial requests |
| Prompt injection in the question | Question reaches only the planner, whose output must validate as a QuerySpec; gate never sees the text | `planner.test.ts`, adversarial set |
| Prompt injection in data (workout titles) | Free text released only at level 3 | "injection in data" test |
| Reconstruction from many narrow answers | Daily packet budget; denials not metered | reconstruction test |
| Restated purpose | Purpose fixed in the grant; claims recorded, ignored | adversarial set |
| Stolen agent token | Short TTL (1 h), audience-bound to one resource, revocable per agent; gate re-validates | end-to-end |
| Replay of signed developer request | Single-use nonce, 300 s window | end-to-end "replayed nonce" |
| Tampering with receipts | Hash chain per user; head anchored to R2 daily | receipts tamper test |
| Compromised edge or planner | No credentials or data bindings there | trust-zone test |
| Terms violation (Strava no-AI) | Terms flags per source; gate excludes them for model-facing agents | Strava test |
| Fake MCP server clones | Signed releases and a published dependency list (release checklist) | — |

## Known limits

- Individually permitted calls can still add up; budgets limit, not eliminate, this.
- A compromised Cloudflare account or gateway host defeats the design.
- The gate cannot stop an agent model from being deceived about what a packet means.
- Once released, what an agent's provider stores is outside this system.
