# Oura API v2: provider notes

Read on 2026-11-24. Main source: the OpenAPI spec the docs page loads (`openapi-1.43.json`, version 1.43). Example values are scrubbed or fake. Most of them come from the sandbox, which serves generated data.

## Sources

| URL | Result |
|---|---|
| https://cloud.ouraring.com/v2/docs | Fetched OK. It is a Redoc shell with no content of its own; it references `/v2/static/json/openapi-1.43.json`. |
| https://cloud.ouraring.com/v2/static/json/openapi-1.43.json | Fetched OK (468 KB). Primary source. |
| https://cloud.ouraring.com/docs/authentication | Fetched OK. |
| https://cloud.ouraring.com/legal/api-agreement | Fetched OK. "Oura API and MCP Agreement", effective 2026-06-08. |
| https://api.ouraring.com/v2/sandbox/usercollection/{daily_activity,sleep,heartrate,daily_spo2,daily_readiness,daily_sleep,workout,vO2_max,daily_resilience} | Live calls returned 200 with a dummy bearer token. |
| https://api.ouraring.com/v2/usercollection/daily_activity with a dummy token | Returned 401 as expected. |
| https://pypi.org/pypi/django-oura/json (django-oura 0.2.1, uploaded 2026-09-29) | Fetched OK. Secondary source. |
| https://pypi.org/project/django-oura/ | Failed. The HTML page needs JavaScript; the JSON API was used instead. |
| https://developer.ouraring.com/ | Redirects to `/signin?callbackUrl=/applications`, the app console. It is not a docs site. |
| WebSearch: "Oura API agreement terms developers AI intermediary" | Search results only. They pointed to the agreement and a third-party Terra blog post (not used as a source). |
| WebSearch: "Oura MCP server" | Found only community MCP servers. No official Oura MCP server URL was found. |

## Auth (OAuth2 only)

- **Authorize:** `GET https://cloud.ouraring.com/oauth/authorize`
  - The auth page also says: "An alternative authorization URL is now provided at `https://developer.ouraring.com/authorize` for new OAuth clients." On mobile it can open the consent page inside the Oura app.
  - Parameters: `response_type=code`, `client_id`, `redirect_uri` (must match exactly; URL-encoded), `state`, `scope` (space-separated; blank means all scopes).
  - PKCE is recommended: `code_challenge` plus `code_challenge_method=S256`.
- **Token:** `POST https://api.ouraring.com/oauth/token`
  - Body is `application/x-www-form-urlencoded`.
  - Code exchange: `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, and `client_id` + `client_secret` (or HTTP Basic auth).
  - Refresh: `grant_type=refresh_token`, `refresh_token`, plus client credentials.
  - Response fields: `token_type=bearer`, `access_token`, `expires_in` (seconds), `refresh_token`.
  - Auth codes are valid for 10 minutes (from the docs' troubleshooting section).
- **Refresh tokens are single-use.** Auth page: "The refresh token is single-use, meaning it is invalidated after being used." Store the new access/refresh pair atomically on every refresh.
- **Revoke:** `https://api.ouraring.com/oauth/revoke?access_token={token}`. The HTTP method is not stated.
- **Access token lifetime is documented inconsistently.**
  - 30 days: the auth page (client-side flow, `expires_in=2592000`) and the FAQ.
  - 24 hours: the "Authentication Troubleshooting" section ("typically 24 hours").
  - Always use `expires_in` from the token response.
- **Personal access tokens are gone.** OpenAPI: "personal access tokens were deprecated in December 2025 and are no longer available for use." The auth page navigation still lists "Personal Access Tokens [Deprecated]".
- **Required headers on every request:** `Authorization: Bearer <token>` and `User-Agent: YourApp/1.0`. Requests without a `User-Agent` may get a 403.
- **User cap:** "API Applications are limited to **10** users before requiring approval from Oura. There is no limit once an application is approved." Users consent to each data type separately, so granted scopes can be a subset of requested scopes.

### Scopes

The OpenAPI `securitySchemes` lists 9 scopes:

`email`, `personal`, `daily`, `heartrate`, `workout`, `tag`, `session`, `spo2`, `heart_health` ("Heart health data")

The auth page lists only the first 8. `heart_health` presumably covers vO2_max and cardiovascular age; see TODO.

## Endpoints

Base URL: `https://api.ouraring.com`

**Collection routes:** `GET /v2/usercollection/{type}`, plus `/{document_id}` for a single document. Available types:

- `daily_activity`, `daily_readiness`, `daily_sleep`, `sleep`, `sleep_time`
- `daily_spo2`, `daily_stress`, `daily_resilience`, `daily_cardiovascular_age`, `vO2_max`
- `workout`, `session`, `enhanced_tag`, `tag` (deprecated), `rest_mode_period`, `ring_configuration`

Collection query parameters: `start_date`, `end_date` (date or date-time), `next_token`, and `fields` (a comma-separated list of extra fields).

**Time series routes:** `GET /v2/usercollection/heartrate` and `GET /v2/usercollection/ring_battery_level`. These take `start_datetime`, `end_datetime`, `next_token`, `latest` (bool) and `fields`.

**Personal info:** `GET /v2/usercollection/personal_info`. No scope is needed to read `id`.

**Pagination:** every list response is `{"data": [...], "next_token": "string|null"}`. Repeat the request with `next_token` until it is null.

**Sandbox:** `GET /v2/sandbox/usercollection/{type}` for the same types (no `personal_info`; `heartrate` and `ring_battery_level` included).
- It serves fake data, with no Oura account or real token needed.
- It requires a non-empty `Authorization` header. Without one it returns 400 `"Missing auth token. Include any string in 'Authorization' header."` The `fields` parameter is not offered.
- It counts against the same rate limit as the real data endpoints.
- The values are degenerate: `bedtime_start == bedtime_end`, durations of 24–200 s, a vO2_max `day` of 2021.
- The sandbox `heartrate` rows carried `producer_timestamp` and no `timestamp_unix`, which differs from the spec.
- `start_date=end_date` returned `[]` and 01-01..01-03 returned 2 days, so `end_date` looked exclusive in the sandbox.

## Payload shapes

**Timestamps:**
- Document timestamps (`timestamp`, `bedtime_*`, `*_datetime`) are ISO 8601 with an offset, e.g. `2025-01-01T23:10:00.000+02:00` ("LocalizedDateTime").
- `day` is `YYYY-MM-DD`.
- Heart-rate `timestamp` is UTC (`...Z`).

**Units:**
- Durations are in seconds.
- Calories are in kcal; distances are in metres.
- Temperature deviations are in °C.
- Scores are 1–100 and can be null.

```jsonc
// daily_activity: units are kcal (calories), seconds (*_time), metres (distances)
{"id":"daily_activity-x","day":"2025-01-01","score":74,"steps":8000,"active_calories":350,
 "total_calories":2300,"equivalent_walking_distance":7000,"high_activity_time":600,
 "medium_activity_time":1800,"low_activity_time":9000,"sedentary_time":30000,"resting_time":25000,
 "non_wear_time":0,"target_calories":400,"class_5_min":"0011223...","met":{"interval":60,"items":[1.0],"timestamp":"..."},
 "contributors":{"meet_daily_targets":64,"move_every_hour":83,"recovery_time":56,"stay_active":99,"training_frequency":70,"training_volume":60},
 "timestamp":"2025-01-01T04:00:00.000+02:00"}

// daily_readiness
{"id":"...","day":"2025-01-01","score":80,"temperature_deviation":0.5,"temperature_trend_deviation":0.2,
 "contributors":{"activity_balance":70,"body_temperature":70,"hrv_balance":80,"previous_day_activity":90,
 "previous_night":60,"recovery_index":90,"resting_heart_rate":60,"sleep_balance":70,"sleep_regularity":null},
 "timestamp":"..."}

// daily_sleep
{"id":"...","day":"2025-01-01","score":73,"contributors":{"deep_sleep":90,"efficiency":70,"latency":80,
 "rem_sleep":70,"restfulness":80,"timing":90,"total_sleep":80},"timestamp":"..."}

// sleep: one document per sleep period; a day can have several
{"id":"...","day":"2025-01-01","type":"long_sleep",          // deleted|sleep|long_sleep|late_nap|rest
 "bedtime_start":"2024-12-31T23:10:00.000+02:00","bedtime_end":"2025-01-01T07:05:00.000+02:00",
 "time_in_bed":28500,"total_sleep_duration":25800,"deep_sleep_duration":5400,"light_sleep_duration":14400,
 "rem_sleep_duration":6000,"awake_time":2700,"latency":600,"efficiency":90,
 "average_heart_rate":55.0,"lowest_heart_rate":48,"average_hrv":45,"average_breath":14.5,
 "restless_periods":5,"period":0,"low_battery_alert":false,
 "heart_rate":{"interval":300,"items":[55.0,null],"timestamp":"..."},"hrv":{"interval":300,"items":[40.0],"timestamp":"..."},
 "sleep_phase_5_min":"4422211...","app_sleep_phase_5_min":null,"sleep_phase_30_sec":null,"movement_30_sec":"1123...",
 "readiness":{"score":73,"temperature_deviation":0.3,"temperature_trend_deviation":0.1,"contributors":{}},
 "readiness_score_delta":7,"sleep_score_delta":12,"sleep_algorithm_version":"v2","sleep_analysis_reason":null,"ring_id":null}
// sleep_phase codes: '1' deep, '2' light, '3' REM, '4' awake. ring_id is deprecated and always null.

// heartrate (time series): about 5-minute samples
{"data":[{"timestamp":"2025-01-01T00:00:00.000Z","timestamp_unix":1735689600000,"bpm":60,"source":"awake"}],"next_token":null}
// source: awake|workout|rest|sleep|live|session

// daily_spo2: average can be null
{"id":"...","day":"2025-01-01","spo2_percentage":{"average":96.5},"breathing_disturbance_index":1}

// workout: calories in kcal, distance in metres
{"id":"...","activity":"walking","calories":120.0,"distance":2000.0,"day":"2025-01-01",
 "start_datetime":"...+02:00","end_datetime":"...+02:00","intensity":"easy","label":null,"source":"autodetected"}
// intensity: easy|moderate|hard
// source: manual|autodetected|confirmed|workout_heart_rate|live_third_party_heart_rate|live_oura_heart_rate

// vO2_max (note the path casing: /vO2_max)
{"id":"...","day":"2025-01-01","timestamp":"...","vo2_max":47}

// daily_resilience
{"id":"...","day":"2025-01-01","level":"solid","contributors":{"sleep_recovery":90.0,"daytime_recovery":90.0,"stress":90.0}}
// level: limited|adequate|solid|strong|exceptional
```

## Webhooks

Subscriptions are app-level. Every call is authenticated with the headers `x-client-id` and `x-client-secret`, not a bearer token.

| Method | Path | Response |
|---|---|---|
| GET | `/v2/webhook/subscription` | Array of subscriptions |
| POST | `/v2/webhook/subscription` | 201 |
| GET | `/v2/webhook/subscription/{id}` | Subscription |
| PUT | `/v2/webhook/subscription/{id}` | Updated subscription. Body: `verification_token` (required), and optionally `callback_url`, `event_type`, `data_type`. |
| PUT | `/v2/webhook/subscription/renew/{id}` | Subscription with a new `expiration_time` |
| DELETE | `/v2/webhook/subscription/{id}` | 204 |

Request a missing `id` and you get 403 "Webhook with specified id does not exist".

**Create body:**
```json
{"callback_url":"https://example.com/oura/webhook","verification_token":"<random secret>","event_type":"update","data_type":"sleep"}
```

**Subscription model:**
```json
{"id":"uuid4","callback_url":"...","event_type":"create","data_type":"daily_activity","expiration_time":"2026-12-24T00:00:00+00:00"}
```

- `event_type` is one of `create`, `update`, `delete`.
- `data_type` is one of: `tag`, `enhanced_tag`, `workout`, `session`, `sleep`, `daily_sleep`, `daily_readiness`, `daily_activity`, `daily_spo2`, `sleep_time`, `rest_mode_period`, `ring_configuration`, `daily_stress`, `daily_cardiovascular_age`, `daily_resilience`, `vo2_max`.
- `vo2_max` is lowercase here, unlike the `/vO2_max` path. There is no heartrate webhook.
- You need one subscription for each (event_type, data_type) pair.

**Verification:** Oura sends `GET {callback_url}?verification_token=...&challenge=...`. Check the token, then respond with JSON `{"challenge":"<challenge>"}`.

**Notification:** Oura sends a `POST` with the headers `x-oura-signature` and `x-oura-timestamp`, and this body:
```json
{"event_type":"update","data_type":"sleep","object_id":"abc123","event_time":"2025-01-01T08:00:00+00:00","user_id":"fake-user-id"}
```
To get the data, fetch `/v2/usercollection/{data_type}/{object_id}` with that user's token, looking the user up by `user_id`.

**Signature check (from the docs' Node example):**
```
expected = HEX_UPPER( HMAC_SHA256(key = client_secret, msg = x-oura-timestamp + JSON.stringify(body)) )
valid    = expected == x-oura-signature
```
Use a constant-time comparison. The docs do not say whether the message is the raw body or a re-serialized body (see TODO).

**Delivery rules:**
- Respond with 2xx within 10 seconds. The FAQ says 2xx or 3xx.
- Failed deliveries are retried 10 times each for 4xx, 5xx and timeouts, for about 1 hour. Run a reconciliation job to cover outages.
- Responding with 410 cancels the subscription.
- Notifications arrive about 30 s after the app syncs.
- Sleep data only arrives after the user opens the Oura app.

## Rate limits

- The FAQ says: "limited to 5000 requests per 5-minute period."
- The newer "Rate Limits" section gives no numbers. It describes two tiers: per access token and per application (the total across all of an app's users).
- Hitting either tier returns 429 with these headers:
  - `Retry-After` (seconds)
  - `X-RateLimit-Limit`
  - `X-RateLimit-Window` (seconds)
  - `X-RateLimit-Reset` (epoch seconds)
  - `X-RateLimit-Tier`
- The sandbox shares the same limit.
- Oura recommends one historical backfill per user, then webhooks.

## Terms that matter (Oura API and MCP Agreement, effective 2026-06-08)

- **§4(d), a blocker for an LLM Q&A product:**
  - "To the extent you seek to use any Oura Data or User Data in connection with a large language model, you may (unless you are an Aggregator) access and process such Oura Data or User Data solely through the MCP Server..."
  - "You shall not use, and shall not permit any third party to use, the Oura API to develop, train, fine-tune, evaluate, prompt, or otherwise provide input or data to any AI Model or AI Platform."
  - "MCP Server" means infrastructure *operated by Oura*. No public URL for it was found.
- **§3(m):**
  - Data obtained through the MCP Server may not be stored or cached unless Oura agrees in writing.
  - Aggregators may not store or cache any User Data or Oura Data.
  - Data obtained through the API "may not be stored or retained beyond the duration strictly necessary."
- **§4(a)(iii), (iv) and §6(g):** no training, fine-tuning or improving of AI models, and no embeddings or "persistent representations". §4(c) says user consent does not override this.
- **§1 and §2(c), aggregators and intermediaries:**
  - An "Aggregator" is anyone who passes Oura data, or data derived from it, to a third party's products. This includes Users.
  - Aggregators may only pass data through to End Customers.
  - They must keep separate credentials for each End Customer, approved by Oura (§3(e)), and maintain a list of End Customers (§3(f)).
  - They must never pass data to any AI Model or LLM.
- **§2(b):** any third-party AI model you use must be bound by terms "no less protective" than this agreement, and you indemnify Oura.
- **§5(e):** you are responsible for reviewing, filtering and validating AI outputs.
- **§5(f):** honour deletion requests within 72 hours. When a user opts out, stop processing their data immediately.
- **§9(a)(ii):** data must be encrypted in transit and at rest.
- **§9(b):** report a data incident within 24 hours.
- **§9(h):** Oura may audit compliance, including the ban on AI training.
- **§3(h):** Oura may charge fees after giving notice.
- **§4(a)(xiii):** you may not charge users for MCP functionality.
- **§14(c):** Oura may suspend or terminate access at any time.
- The agreement does not mention the 10-user cap. It comes from the API docs only.

## Uncertain / TODO(verify)

- TODO(verify): access token lifetime. The docs say both 30 days and 24 hours.
- TODO(verify): which scope gates `daily_stress`, `daily_resilience`, `vO2_max` and `daily_cardiovascular_age`. `heart_health` is in the OpenAPI but missing from the auth page.
- TODO(verify): which authorize URL new clients must use: `developer.ouraring.com/authorize` or `cloud.ouraring.com/oauth/authorize`.
- TODO(verify): the webhook subscription lifetime. `expiration_time` and a renew route exist, but no duration is documented.
- TODO(verify): the exact HMAC input, i.e. raw request body versus re-serialized JSON, and whitespace. The docs only show Node's `JSON.stringify(req.body)`. There is also no stated replay window for `x-oura-timestamp`.
- TODO(verify): the actual rate-limit numbers. Read `X-RateLimit-*` from real responses; "5000/5 min" appears only in the FAQ.
- TODO(verify): whether `end_date` is inclusive on the production API. It behaved as exclusive in the sandbox.
- TODO(verify): the official Oura MCP Server endpoint and how to onboard to it. Not found in the public docs.
- TODO(verify): with counsel, whether an app that sends Oura API data to an LLM is permitted at all. §4(d) appears to prohibit it outside MCP.
- The Tag route is deprecated; use Enhanced Tag. `ring_id` on sleep is deprecated and always null.
