# Build plan and status

The spec's five phases, with their done criteria and where each stands on 2026-11-25.

| Phase | Done criteria | Status |
| --- | --- | --- |
| 0 Skeleton | Seven Workers deployed on askwearables.app; fresh clone runs under `wrangler dev`; tests green | Done. All seven deployed; `npm run dev` runs the system locally |
| 1 Data in, numbers out | PHIA objective questions pass at 90%; data-quality cases pass | Computation: 94.7% on PHIA's window conventions, 78.1% as literally worded (see `eval/phia/NOTES.md`). All data-quality cases pass |
| 2 Questions, packets, gate | Claude over MCP with a level 1 grant answers 20 real questions; privacy tests pass | Privacy tests pass. MCP OAuth is live; connecting Claude needs the owner account first (passkey setup) |
| 3 Live sources | A day of real data arrives without manual steps | Code done for Oura, WHOOP, Google Health, Garmin, Polar, Strava (disabled), Open Wearables; iOS and Android sync apps build and pass tests. Live data waits on vendor approvals and the owner's phone |
| 4 Developers | A second developer integrates from the docs alone; outside review | Organizations, API keys with signed requests, hosted consent, usage metering, webhooks, SDKs, quickstart done. Waits on a real second developer and an outside reviewer |
