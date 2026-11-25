# Release checklist

Status on 2026-11-25. The system is deployed on askwearables.app with every live source switched off. Each flag below is off until the approval it names arrives.

## Flags and what each waits for

| Flag | Default | Waits for | Until then |
| --- | --- | --- | --- |
| `connector.oura` | off | Legal and product decision: Oura's API Agreement (effective 2026-06-08, §4(d)) forbids giving Oura data to an AI model except through Oura's own MCP server. Then Oura app approval past 10 users | Sandbox fixtures only |
| `connector.whoop` | off | WHOOP app approval; WHOOP's written position on AI use | Owner's own account |
| `connector.google_health` | off | Google review of Restricted scopes (unverified apps capped at 100 users) | Owner's own test users |
| `connector.garmin` | off | Garmin business approval; tier (backfill is Enterprise-only) | Fixture tests only |
| `connector.polar` | off | Polar client registration; confirm webhook signature scheme against a live ping | Fixture tests only |
| `connector.strava` | off, and refuses without a written-approval reference | Strava written approval (API Policy 2026 §5.3 and §5.16 ban AI use and aggregators) | Never reaches a model |
| `connector.open_wearables` | off | A self-hosted Open Wearables instance | — |
| Phone apps in stores | not submitted | Apple and Google developer accounts and app review | Run on the owner's own phones |
| Hosting other people's data | owner only | Legal advice on health-data rules (GDPR special category; US state laws) | Owner's data only |
| Gate sign-off | internal | An outside security reviewer | Threat model and tests in `docs/threat-model.md` |
| AI Gateway | off | A Cloudflare token with AI Gateway permission | Planner calls Workers AI directly (still on Cloudflare) |

## Checks that pass today

| Check | Command | Result |
| --- | --- | --- |
| Unit and contract tests | `npm test` | all passing (core, connectors, importers, eval, SDKs, Workers) |
| Type checks | `npx tsc -p <package>` | clean |
| Trust zones | `workers/edge/test/trust-zones.test.ts` | edge and planner have no data or policy bindings |
| Local end to end | `./scripts/e2e-local.sh` | 16 of 16 |
| Privacy tests | 50 adversarial requests, reconstruction, injection, terms flags | zero releases beyond the grant |
| Repeatability | 100 questions × 5 runs | byte-identical packets |
| PHIA computation | `npm run eval:phia -w @askwearables/eval` | 94.7% on PHIA's window conventions; 78.1% as worded (definition differences in `eval/phia/NOTES.md`) |
| Planner honesty on PHIA | `python3 eval/paper/summarize_planner.py` | 100% of unsupported questions refused (llama-3.3-70b, 400-question sample) |

## Before a public launch

- [ ] Owner creates the owner account at `https://auth.askwearables.app/setup?token=…` (token in `.secrets/production.env`), then deletes the token secret.
- [ ] Back up `MASTER_KEY` from `.secrets/production.env` to a password manager. Losing it makes stored provider tokens and receipt payloads unreadable.
- [ ] Production end to end with the owner key: `AW_BASE=https://api.askwearables.app AW_OWNER_KEY=… node scripts/e2e.mjs`.
- [ ] Signed releases and a published dependency list (`npm sbom`), because fake wearable MCP servers have carried malware.
- [ ] Trademark and handle checks for the name.
- [ ] Decide the Durable Object jurisdiction (`eu` option) before the first non-owner user.
