# WHOOP Developer Platform (API v2)

Read on 2026-11-24. These notes come from live WebFetch reads of the official docs, not from memory. All JSON below is scrubbed sample data.

## URLs fetched

| URL | Status |
|---|---|
| https://developer.whoop.com/docs/introduction | OK |
| https://developer.whoop.com/docs/developing/oauth | OK |
| https://developer.whoop.com/docs/developing/webhooks | OK |
| https://developer.whoop.com/api | OK (fetched twice) |
| https://developer.whoop.com/docs/developing/rate-limiting | OK |
| https://developer.whoop.com/docs/developing/v1-v2-migration | OK |
| https://developer.whoop.com/docs/developing/app-approval | OK |
| https://developer.whoop.com/docs/developing/pagination | OK |
| https://developer.whoop.com/docs/api-changelog | OK |
| https://developer.whoop.com/api-terms-of-use/ (Effective Date: October 6, 2026) | OK (fetched twice) |
| Web search "WHOOP API Terms of Use developer" | OK, used only to find the terms URL |

No fetch failed. WebFetch returns summaries made by a small model, so items marked TODO(verify) need a check against the raw page.

## OAuth 2.0 (authorization code flow)

- Authorize URL: `https://api.prod.whoop.com/oauth/oauth2/auth`
- Token URL (also used for refresh): `https://api.prod.whoop.com/oauth/oauth2/token`
- `state`: a CSRF value that comes back unchanged. If you generate it yourself, it **must be 8 characters**.
- Scopes listed in the API reference (6): `read:recovery`, `read:cycles`, `read:workout`, `read:sleep`, `read:profile`, `read:body_measurement`.
- `offline`: required to receive a refresh token. It is documented on the OAuth page, and the refresh request example sends `scope=offline`. The API reference's scope table does **not** list it. Request 7 scopes in total.
- Partner flow (not for us): client credentials, `https://api.prod.whoop.com/developer/v2/partner/token`, scope `whoop-partner/token`.
- Token lifetime: the sample response shows `expires_in: 3600`, but the page states no fixed lifetime. Always read `expires_in`. Refresh-token lifetime is not documented.
- Refresh behaviour (verbatim):
  - "Existing access tokens are invalidated once your app uses the refresh token to generate a new access token."
  - Refresh tokens rotate: "your app must use the new refresh token on the subsequent refresh request."
  - On concurrent refreshes, "The second request would fail because the first request invalidates the refresh token." Serialize refreshes per user (lock or single-flight) and persist the new refresh token atomically.
- Refresh request (form-encoded POST to the token URL): `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`, `scope=offline`.
- Revoke when a user disconnects: `DELETE https://api.prod.whoop.com/developer/v2/user/access` returns 204.

## v2 endpoints

Base URL: `https://api.prod.whoop.com/developer`

| Method / path | Notes |
|---|---|
| GET `/v2/cycle` | paginated; scope read:cycles |
| GET `/v2/cycle/{cycleId}` | cycleId is int64 |
| GET `/v2/cycle/{cycleId}/sleep` | sleep for a cycle |
| GET `/v2/cycle/{cycleId}/recovery` | recovery for a cycle |
| GET `/v2/recovery` | paginated; sorted by the related sleep's start, descending |
| GET `/v2/activity/sleep` | paginated |
| GET `/v2/activity/sleep/{sleepId}` | sleepId is a UUID |
| GET `/v2/activity/workout` | paginated |
| GET `/v2/activity/workout/{workoutId}` | workoutId is a UUID |
| GET `/v2/user/profile/basic` | read:profile |
| GET `/v2/user/measurement/body` | read:body_measurement |
| DELETE `/v2/user/access` | revoke, returns 204 |
| GET `/v1/activity-mapping/{activityV1Id}` | one-time v1 id to v2 UUID migration; 200 or 404 |

### Pagination

- Query parameters: `limit` (int32, **max 25, default 10**), `start` (date-time, inclusive), `end` (date-time, exclusive, defaults to now), `nextToken`.
- The response has `records[]` and `next_token`. Send `next_token` back as `?nextToken=`, keeping the same `start` and `end`. Stop when `next_token` is empty or absent.
- The pagination page calls `limit` a "header", while the API reference lists it as a query parameter. Use the query parameter (TODO(verify)).

### Payload shapes (fake data)

The responses include `score_state`, with values such as `SCORED`, `PENDING_SCORE` and `UNSCORABLE` (only `SCORED` was seen in the fetched sample; TODO(verify) the others). `score` is present only when the state is `SCORED`. Cycle `end` is null while the cycle is in progress (TODO(verify)).

Cycle:
```json
{"id": 1000001, "user_id": 42, "created_at": "2026-01-02T11:00:00.000Z", "updated_at": "2026-01-02T14:00:00.000Z",
 "start": "2026-01-02T03:00:00.000Z", "end": "2026-01-03T03:30:00.000Z", "timezone_offset": "-05:00",
 "score_state": "SCORED", "step_count": 8000,
 "score": {"strain": 10.5, "kilojoule": 9000.0, "average_heart_rate": 65, "max_heart_rate": 160}}
```
`step_count` was added on 2026-09-23 and is nullable.

Recovery:
```json
{"cycle_id": 1000001, "sleep_id": "00000000-0000-4000-8000-000000000001", "user_id": 42,
 "created_at": "...", "updated_at": "...", "score_state": "SCORED",
 "score": {"user_calibrating": false, "recovery_score": 60, "resting_heart_rate": 55,
           "hrv_rmssd_milli": 40.0, "spo2_percentage": 96.0, "skin_temp_celsius": 33.5}}
```
Recovery has no `id` of its own. It is keyed by `cycle_id` and `sleep_id`.

Sleep:
```json
{"id": "00000000-0000-4000-8000-000000000001", "cycle_id": 1000001, "v1_id": 123, "user_id": 42,
 "created_at": "...", "updated_at": "...", "start": "...", "end": "...", "timezone_offset": "-05:00",
 "nap": false, "score_state": "SCORED",
 "score": {
   "stage_summary": {"total_in_bed_time_milli": 28800000, "total_awake_time_milli": 1800000,
     "total_no_data_time_milli": 0, "total_light_sleep_time_milli": 14400000,
     "total_slow_wave_sleep_time_milli": 5400000, "total_rem_sleep_time_milli": 7200000,
     "sleep_cycle_count": 4, "disturbance_count": 10},
   "sleep_needed": {"baseline_milli": 27000000, "need_from_sleep_debt_milli": 0,
     "need_from_recent_strain_milli": 0, "need_from_recent_nap_milli": 0},
   "respiratory_rate": 15.0, "sleep_performance_percentage": 90.0,
   "sleep_consistency_percentage": 80.0, "sleep_efficiency_percentage": 92.0}}
```
`need_from_recent_nap_milli` can be negative.

Workout:
```json
{"id": "00000000-0000-4000-8000-000000000002", "v1_id": 456, "user_id": 42,
 "created_at": "...", "updated_at": "...", "start": "...", "end": "...", "timezone_offset": "-05:00",
 "sport_name": "running", "sport_id": 0, "score_state": "SCORED",
 "score": {"strain": 8.0, "average_heart_rate": 130, "max_heart_rate": 170, "kilojoule": 1500.0,
   "percent_recorded": 100.0, "distance_meter": 5000.0, "altitude_gain_meter": 20.0, "altitude_change_meter": 0.0,
   "zone_durations": {"zone_zero_milli": 0, "zone_one_milli": 0, "zone_two_milli": 0,
     "zone_three_milli": 0, "zone_four_milli": 0, "zone_five_milli": 0}}}
```
Distance and altitude fields may be absent (TODO(verify) whether they are optional).

Body measurement:
```json
{"height_meter": 1.75, "weight_kilogram": 70.0, "max_heart_rate": 190}
```

Profile:
```json
{"user_id": 42, "email": "user@example.com", "first_name": "Test", "last_name": "User"}
```

## Webhooks (v2)

- Events: `recovery.updated`, `recovery.deleted`, `sleep.updated`, `sleep.deleted`, `workout.updated`, `workout.deleted`. There are no cycle events.
- Delivery is a POST with a JSON body:
  ```json
  {"user_id": 42, "id": "00000000-0000-4000-8000-000000000001", "type": "recovery.updated", "trace_id": "00000000-0000-4000-8000-0000000000aa"}
  ```
  `user_id` is int64. `id` is a UUID in v2 and was an integer in v1.
- **For a recovery event, the `id` is the UUID of the associated sleep, not the cycle id** (v1 used the cycle id). To process it, fetch `/v2/activity/sleep/{id}` to get `cycle_id`, then fetch `/v2/cycle/{cycle_id}/recovery`.
- Webhooks are configured per URL in the Developer Dashboard, and the model version (v1 or v2) is chosen per URL. v1 webhooks "have been removed" and are no longer published (changelog, 2025-11-01).
- Signature headers: `X-WHOOP-Signature` and `X-WHOOP-Signature-Timestamp` (milliseconds since epoch).
- Verification algorithm:
  `expected = base64( HMAC_SHA256( key = client_secret, message = X-WHOOP-Signature-Timestamp + raw_request_body ) )`
  The timestamp is prepended to the raw body bytes as a string with no separator. Compare `expected` with `X-WHOOP-Signature` in constant time and reject the request on mismatch. The docs set no timestamp tolerance; applying a self-imposed freshness window, for example 5 minutes, is our choice.
- Retries: 5 retries over about 1 hour on a non-2xx response or a timeout. Return 2xx quickly and process asynchronously through a queue. Deliveries can be duplicated, so make processing idempotent on `(type, id)` and `trace_id`.

## Rate limits

- Default: **100 requests per minute and 10,000 requests per day** per client.
- Headers (IETF draft): `X-RateLimit-Limit: 100, 100;window=60, 10000;window=86400`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds).
- Exceeding a limit returns HTTP 429. No `Retry-After` header is documented, so use `X-RateLimit-Reset`.
- Increase: in the Developer Dashboard, choose Open Request, then "Rate limit increase".

## App approval and user caps

- Tiers: Sandbox (10 members, the default for new apps), Build (100), Growth (1,000), Scale (5,000), Production (unlimited).
- You can request only the next tier up. From Build onward you need at least 50% of the current tier's limit connected first; Sandbox can request Build at any time.
- Before requesting, you need: compliance with the Terms, testing with at least one member, App Name, Contact Email and Privacy Policy URL set, and compliance with the Design and Brand Guidelines.
- Submit through the Dashboard (Open Request, "Request higher limits"). Review is manual. Vague requests are rejected. Contacting WHOOP staff outside the Dashboard is prohibited and can get the app disabled.

## Terms that matter (API Terms of Use, effective 2026-10-06)

- **4.2.3, AI:** You may not "use any API or WHOOP Data to create, develop, test, train, fine-tune or improve any large language model", and the ban extends to other ML and AI models and systems. The clause **does not name inference**. Sending WHOOP data to an LLM for inference to answer the user's own question is not explicitly banned, but "test"/"improve" and the third-party provisions below make it ambiguous. Use zero-retention and no-training provider settings, get explicit user consent, and consider asking WHOOP.
- **Third parties and intermediaries:** No clause addresses intermediaries, subprocessors or service providers explicitly. Relevant clauses:
  - 2.3: do not transfer or disclose user information to third parties except as the Terms, the End User and your privacy policy authorize.
  - 4.2.1: exposure to third parties requires explicit opt-in consent.
  - 3.1.3: do not market, sell or license API data, even with consent.
  - 3.1.4: do not sublicense APIs.
  - 3.1.2: do not resell, redistribute or syndicate access.
  - 4.2.4: do not sell, distribute or sublicense WHOOP Data.
  - 3.1.5: do not build apps that "function substantially like any API". This is a risk for an aggregator or middleware product.
- **Retention:** No fixed retention period and no explicit delete-on-disconnect rule.
  - 4.2.2: no scraping, no databases built from WHOOP Data, no "permanent copies", and no cached copies kept "longer than permitted by the cache header". This is in tension with storing history long-term; TODO(verify) with WHOOP.
  - 7.1: on termination, delete cached and stored content.
- **Medical:** 3.1.10 bars medical devices. 3.1.11 bars giving medical, legal or other professional advice. 1.8 says there is no HIPAA representation and PHI requires written consent.
- **Security:** 2.4 requires encryption in transit and at rest and breach notice to WHOOP within 48 hours.
- **Other:** 2.1 requires explicit end-user authorization. 2.3 requires a privacy policy. 5.1 and 5.2 bar using WHOOP marks or public statements without written approval. 2.5 bars using WHOOP Data in ads without consent. 1.5 lets WHOOP set request and user caps. WHOOP may terminate or discontinue at any time.

## Uncertain / TODO(verify)

- `offline` appears on the OAuth page but not in the API reference scope table. Confirm the authorize request accepts all 7 scopes.
- Access token lifetime (sample 3600 s) and refresh token lifetime or idle expiry.
- Whether the old refresh token is hard-invalidated immediately after use. The docs imply it is; the concurrent-refresh note says the first refresh invalidates it.
- Whether `limit` is a query parameter or a header (the docs conflict). The API reference says query parameter, max 25.
- The full set of `score_state` enum values and which fields are nullable or optional (`end`, `distance_meter`, `step_count`, and so on).
- Webhook signature: confirm the timestamp string plus raw UTF-8 body with the client secret as key, using a test delivery. Check whether there is a replay window.
- Whether `*.deleted` recovery events also carry the sleep UUID. Presumably yes; not stated.
- Whether 4.2.3 or 2.3 allow sending WHOOP data to a third-party LLM for inference, and how long data may be retained, given 4.2.2's "permanent copies" and cache-header language. Ask WHOOP support in writing.
- Whether a `sport_id` to name list is still published; v2 provides `sport_name` directly.
