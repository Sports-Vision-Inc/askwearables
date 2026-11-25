# Decisions that depart from the spec

One line per choice, with the reason. Newest last.

- 2026-11-24 · Sensitive categories added to the catalogue as four metrics (`blood_glucose`, `menstrual_cycle`, `ecg_classification`, `breathing_disturbances`) flagged `sensitive`, so the gate can refuse them by name. The v1 catalogue is otherwise exactly as specified.
- 2026-11-24 · `receipt_id` is returned in the response envelope, not inside the packet, so the packet stays byte-identical across repeated asks. The packet carries `as_of` (the current hour) instead; repeatability holds within the hour and on frozen clocks.
- 2026-11-24 · Freshness is measured against `as_of` (the hour), not the exact request time, for the same reason.
- 2026-11-24 · When a grant's maximum level is below the lowest level an operation needs, the gate releases the coarser level instead of denying (for example `latest` at level 1 returns "within / below usual" with no number). Denying would push agents to retry with other phrasings.
- 2026-11-24 · Baselines may use data up to 28 days before a grant's window. Only a bucket derived from it is released; no value from outside the window is.
- 2026-11-24 · Coverage: intraday metrics count hours with data against 12 expected hours (steps, energy) or 16 (heart rate); nightly and vendor-daily values count a day as covered. A day under 60% is low-coverage.
- 2026-11-24 · Per-day source choice: valid coverage first, then device priority (watch, ring, band, scale, cgm, phone). Baseline comparisons use each day's own source.
- 2026-11-24 · Encryption at rest: a per-user AES-256-GCM data key wrapped by a master key (Workers secret) encrypts provider tokens, receipt payloads and stored packets. Numeric samples rely on Cloudflare's storage encryption and per-user Durable Object isolation, because SQL aggregation needs them in the clear. Delete-everything destroys the data key, which crypto-erases receipt payloads.
- 2026-11-24 · The MCP `ask` tool keeps a `purpose` argument for compatibility, but it is recorded and never used; the purpose comes only from the grant.
- 2026-11-24 · The consent screen's live example needs the user's own data, so auth has a service binding to gate (method `consentExample` only). The trust-zone table listed auth as reaching D1 only.
- 2026-11-24 · Gate binds auth to re-validate agent tokens and console sessions ("checked again by gate"). This makes gate and auth mutually bound; first deploy bootstraps gate without the auth binding.
- 2026-11-24 · Edge also binds auth (token validation via `OAuthResourceServer`), as the OAuth library's split-role design expects.
- 2026-11-24 · MCP server built on `@modelcontextprotocol/server` v2 with `createMcpHandler` from `agents/mcp/server` (stateless). `McpAgent` is marked legacy in the current Agents SDK.
- 2026-11-24 · OAuth uses `@cloudflare/workers-oauth-provider` 1.3 in its split-role shape: `OAuthAuthorizationServer` in auth, `OAuthResourceServer` in edge. Dynamic client registration stays enabled for clients without CIMD support (MCP 2026-07-28 deprecates DCR for new implementations).
- 2026-11-24 · Owner sign-in is passkey-only (WebAuthn via `@simplewebauthn/server`). Email links are not built yet: they need an email-sending setup. Bootstrap uses a one-time setup token, valid only while no owner exists.
- 2026-11-25 · The planner is LLM-first (owner's decision): every question goes to the model; keyword rules run only if both models are unreachable.
- 2026-11-26 · The planner is LLM-only (owner's decision): no keyword fallback in the planner Worker (both models unreachable = `planner_unavailable`, the agent retries), and the owner console's Ask box plans through the same LLM planner instead of keyword rules. The rule planner stays in core only as a test and evaluation baseline. Deterministic code only validates the model's output (QuerySpec schema) and enforces policy (gate).
- 2026-11-25 · Planner models chosen by measurement on a 400-question stratified PHIA sample (eval/paper/results/planner-phia.jsonl; `python3 eval/paper/summarize_planner.py`): primary `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (100% refusal of unsupported questions, 0 guesses, 72.6% operation+metric agreement, 0.9 s median), fallback `@cf/openai/gpt-oss-120b`. `inkling-2-small` refused 55% of answerable questions and took 71 s median, so it is not used. `nemotron-3-120b-a12b` was not in the account's catalogue.
- 2026-11-24 · AI Gateway is not used yet: the deploy token lacks AI Gateway permission. Planner calls go to Workers AI directly, which still keeps question text on Cloudflare. Add the gateway (logging off) when a token with that scope is available.
- 2026-11-24 · Signed developer requests use a D1 `nonces` table rather than the user's Durable Object, because the nonce must be checked before the user is known.
- 2026-11-24 · Phone sync apps push through `POST /v1/ingest` with a per-source sync key, so a key can write only to its own source.
- 2026-11-25 · When a question names no window, the planner uses the last 30 days (was 7), matching how people read "what is my lowest HRV?".
