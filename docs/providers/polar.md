# Polar AccessLink API v3 — provider notes

Read on 2026-11-24. These notes come from live docs, not memory. All sample values below are fake.

## Sources
| URL | Status |
|---|---|
| https://www.polar.com/accesslink-api/ (full reference, about 1.1 MB HTML, read in full via curl and WebFetch) | OK |
| https://github.com/polarofficial/accesslink-example-python (README) | OK |
| https://www.polar.com/en/legal/polar-api-agreement (Polar API Limited License Agreement, "last updated 22 August 2025") | OK |
| https://admin.polaraccesslink.com (admin portal) | Not fetched (login required). The URL comes from the README. |
| polar.com/sites/default/files/static/ACL_Ltd_License_Agreement.pdf (older AccessLink PDF) | Not fetched. The current agreement is the web page above. |
| lawinsider.com copies of the agreement | Not used (no text) |

Docs changelog entries: 20.11.2026 added the NIGHTLY_RECHARGE webhook event. 13.01.2026 added a non-transactional physical-info endpoint and the PHYSICAL_INFORMATION event, and deprecated transactional physical-info. 18.08.2025 added non-transactional daily activity and deprecated the transactional daily-activity and exercise endpoints. 21.03.2024 added route data to exercises. 05.03.2024 added Elixir body temperature.

## Base URL and auth
- API base: `https://www.polaraccesslink.com`. TLS is required.
- Authorize: `GET https://flow.polar.com/oauth2/authorization?response_type=code&client_id=...&redirect_uri=...&scope=accesslink.read_all&state=...`. Only `response_type` and `client_id` are required. `scope` defaults to `accesslink.read_all`.
- The authorization code expires in 10 minutes and is single use. Reusing it denies the request and deletes ALL tokens issued from that code.
- Token: `POST https://polarremote.com/v2/oauth2/token`
  - `Authorization: Basic base64(client_id:client_secret)`
  - Form body: `grant_type=authorization_code&code=...&redirect_uri=...` (redirect_uri is required if it was sent to the authorize endpoint)
  - Response: `{"access_token":"FAKE","token_type":"bearer","expires_in":31535999,"x_user_id":12345}`
- Lifetime: `expires_in` is described as "about one year", but the docs also say "Access tokens will not expire unless explicitly revoked by partners or users." No refresh-token grant is documented. The error list mentions "refresh token" only in generic OAuth boilerplate. If a token is revoked or expires, re-run the OAuth flow.
- Two auth modes:
  - User Bearer token for `/v3/users/**`. Note that `/v3/exercises` is also called with the user token.
  - Client Basic credentials for the other `/v3/` endpoints: `/v3/notifications` and `/v3/webhooks/**`.

## Mandatory user registration
- `POST /v3/users` (Bearer) with body `{"member-id":"<your-internal-id>"}`.
  - 200: user info.
  - 409: already registered or duplicate member-id. Treat this as success when re-linking.
  - 403: mandatory consents are missing.
- Data uploaded before registration is not available. The docs say "only exercises uploaded to Flow after the user is registered with your client will be available."
- `GET /v3/users/{user-id}` returns user info. `DELETE /v3/users/{user-id}` de-registers the user and revokes the token.

## Non-transactional endpoints (current)
| Data | Endpoints | Window |
|---|---|---|
| Exercises | `GET /v3/exercises?samples=&zones=&route=`, `GET /v3/exercises/{hashedId}`, plus `/fit`, `/tcx`, `/gpx` | uploaded in the last 30 days |
| Daily activity | `GET /v3/users/activities?from=&to=&steps=&activity_zones=&inactivity_stamps=`, `GET /v3/users/activities/{date}`, `GET /v3/users/activities/samples[/{date}]` | defaults to the last 28 days. `from` can't be older than 365 days, and a range is capped at 28 days. |
| Physical info | `GET /v3/users/physical-info` | latest |
| Continuous HR | `GET /v3/users/continuous-heart-rate/{date}`, `?from=&to=` | 5-minute samples. Excludes training sessions. |
| Sleep | `GET /v3/users/sleep` (`{"nights":[...]}`), `/sleep/{date}`, `/sleep/available` | 28 days |
| Nightly Recharge | `GET /v3/users/nightly-recharge` (`{"recharges":[...]}`), `/nightly-recharge/{date}` | 28 days |
| Cardio load | `GET /v3/users/cardio-load`, `/{date}`, `/date?from=&to=`, `/period/days/{n}`, `/period/months/{n}` | 28 days by default |
| SleepWise | `GET /v3/users/sleepwise/alertness[/date?from=&to=]`, `/sleepwise/circadian-bedtime[/date?from=&to=]` | 28 days. Times are UTC. Needs at least 5 days of sleep data. |
| Elixir biosensing | body temperature, skin temperature, skin contacts, wrist ECG, SpO2 | TODO(verify) paths |

### Payload shapes (fake values)
Exercise (`start_time` is local time with no offset, `start_time_utc_offset` is in minutes, and `upload_time` is UTC):
```json
{"id":"AbC123","upload_time":"2026-01-01T10:00:00.000Z","device":"Polar X","start_time":"2026-01-01T07:30:00",
 "start_time_utc_offset":120,"duration":"PT1H2M","calories":600,"distance":10000.0,
 "heart_rate":{"average":140,"maximum":175},"training_load":90.0,"sport":"RUNNING",
 "has_route":true,"detailed_sport_info":"RUNNING"}
```
Optional fields: `samples`, `heart_rate_zones`, `route`, `training_load_pro`.

Daily activity (new endpoint). It has no `created` or `duration` fields. Those belonged to the deprecated transactional model.
```json
{"start_time":"2026-01-01T00:00:10","end_time":"2026-01-01T23:59:59","active_duration":"PT3H10M",
 "inactive_duration":"PT18H","daily_activity":85.0,"calories":2400,"active_calories":1400,"steps":9000,
 "inactivity_alert_count":1,"distance_from_steps":5000.0}
```
Sleep. Stage durations are in seconds, `sleep_goal` is in seconds, and the hypnogram uses 30-second epochs.
```json
{"date":"2026-01-01","sleep_start_time":"2025-12-31T23:30:00+02:00","sleep_end_time":"2026-01-01T07:00:00+02:00",
 "light_sleep":14000,"deep_sleep":5000,"rem_sleep":6000,"unrecognized_sleep_stage":0,
 "total_interruption_duration":1500,"short_interruption_duration":600,"long_interruption_duration":900,
 "sleep_score":80,"sleep_charge":3,"sleep_goal":28800,"continuity":3.0,"hypnogram":{"23:30":2},"heart_rate_samples":{"23:30":55}}
```
Nightly Recharge. `ans_charge` ranges from -10.0 to +10.0. HRV is RMSSD in ms (inferred; TODO(verify) the units).
```json
{"date":"2026-01-01","heart_rate_avg":60,"beat_to_beat_avg":1000,"heart_rate_variability_avg":40,
 "breathing_rate_avg":14.0,"nightly_recharge_status":3,"ans_charge":1.0,"ans_charge_status":3,
 "hrv_samples":{"00:00":40},"breathing_samples":{"00:00":14.0}}
```

## Deprecated transactional endpoints
- `POST /v3/users/{uid}/{exercise|activity|physical-information}-transactions` returns 201 with a transaction-id, or 204 if there is nothing new.
- `GET .../{tid}` returns a list of URLs. Fetch each item with `GET`.
- Commit with `PUT .../{tid}`. The commit response says "Transaction has been committed and data deleted", so data is not returned again after commit.
- Each transaction holds at most 50 items.
- Only data uploaded to Flow in the last 30 days is available. Some deprecated sections say 28 days.
- Pull notifications: `GET /v3/notifications` (Basic client auth) returns `{"available-user-data":[{"user-id":1,"data-type":"ACTIVITY_SUMMARY","url":".../v3/users/1/activity-transactions"}]}`, or 204 when nothing is available. This is tied to the transactional model.

## Webhooks
- Each client has one webhook, managed with client Basic auth.
  - Create: `POST /v3/webhooks` with `{"events":["EXERCISE","SLEEP"],"url":"https://example.invalid/hook"}`
  - Response 201: `{"data":{"id":"x","events":[...],"url":"...","signature_secret_key":"FAKE-UUID"}}`. The key is returned **only once**. 409 means a webhook already exists.
  - Other operations: GET, PATCH (update; a URL change re-pings), activate, deactivate, `DELETE /v3/webhooks/{id}`.
- Events: EXERCISE, SLEEP, CONTINUOUS_HEART_RATE, SLEEP_WISE_CIRCADIAN_BEDTIME, SLEEP_WISE_ALERTNESS, ACTIVITY_SUMMARY, PHYSICAL_INFORMATION, NIGHTLY_RECHARGE.
- A PING is sent on create and on URL update. The endpoint must reply 200, or the create or update fails.
- Polar auto-deactivates the webhook after 7 days of failed deliveries.
- Request headers: `Polar-Webhook-Event: <EVENT>` and `Polar-Webhook-Signature: <64 lowercase hex chars>`.
- Signature: the docs say only that `signature_secret_key` is used "to sign all payload messages". The example signature is 64 hex characters, which fits a **hex-encoded HMAC-SHA256**. Compute HMAC-SHA256(key=signature_secret_key as UTF-8, msg=raw request body) and hex-compare in constant time. TODO(verify) with a live PING, because the docs do not state the key encoding or the exact message.
- Payloads:
  - PING: `{"timestamp":"...","event":"PING"}`
  - EXERCISE: `{"event":"EXERCISE","user_id":1,"entity_id":"AbC123","timestamp":"...","url":"https://www.polaraccesslink.com/v3/exercises/AbC123"}`
  - SLEEP, ACTIVITY_SUMMARY, CONTINUOUS_HEART_RATE, NIGHTLY_RECHARGE: `{"event":...,"user_id":1,"date":"2026-01-01","timestamp":...,"url":".../v3/users/<type>/2026-01-01"}`. These use `date`, not `entity_id`.
  - PHYSICAL_INFORMATION: `{event,user_id,timestamp,url}`
  - The webhook does not carry the data itself. Fetch `url` with the user's token.

## Rate limits (dynamic, recalculated daily)
- 15 minutes: `500 + users*20`. 24 hours: `5000 + users*100`.
- Response headers `RateLimit-Usage`, `RateLimit-Limit`, and `RateLimit-Reset` each hold two values, "short,long". Reset is in seconds.
- Exceeding a limit returns 429. Short-term violations still count toward the long-term limit.

## Terms (Polar API Limited License Agreement, updated 22 Aug 2025)
- The license is non-exclusive and non-transferable. Your app's primary purpose must be improving the Member's experience. You may not build a service that competes with the Polar Ecosystem.
- No sublicensing except to "Corporate Customers", for which you act as an aggregator. You must accept the agreement separately for each Corporate Customer. Polar may connect with those customers directly.
- No Data may go to external sources without the Member's explicit permission. You need a privacy policy and must tell Members when you store their Data.
- **You must credit "Polar Ecosystem" as the source when displaying Data.** Follow Polar's Brand Guidelines. Marketing use of Polar marks requires written consent.
- When a Member asks, or the relationship ends, revoke the token and delete it. On termination, delete all Data.
- No scraping. Load testing needs prior approval.
- The API is free for now, but Polar may charge fees. Polar can terminate immediately. EU DMA gatekeepers are excluded.
- **AI/ML is not mentioned.** There is no explicit ban or permission. Sending data to an LLM provider is arguably "external sources" and needs explicit Member permission. TODO(verify) with Polar.

## Uncertain / TODO(verify)
- Webhook HMAC: the docs do not state that the input is the raw body or that the key is used as UTF-8 bytes. Hex output is inferred from the example.
- Whether the token really never expires, or expires after `expires_in` (about 1 year). Plan for re-auth on 401.
- The units of `heart_rate_variability_avg`. "RMSSD ms" is an assumption.
- Elixir endpoint paths, and whether `/v3/notifications` covers the non-transactional data types.
- The exercise window is 30 days and the sleep, NR, and cardio windows are 28 days, while daily activity goes back 365 days. The deprecated sections give conflicting 28- and 30-day values.
