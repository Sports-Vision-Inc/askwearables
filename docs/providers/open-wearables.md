# Open Wearables: provider notes

Read on 2026-11-24. Sources were fetched live. Nothing here comes from memory. All JSON below is fake or scrubbed.

Open Wearables is a self-hosted unified wearable API, MIT licensed ("Copyright (c) 2025 Momentum"). It is built on FastAPI, Postgres, Redis and Celery, uses Svix for outgoing webhooks, and ships an MCP server. Each deployment serves one organization; there is no multi-tenancy.

## Sources

| Source | Result |
|---|---|
| github.com/the-momentum/open-wearables: shallow clone of the default branch, HEAD `6811b28` (committed 2026-11-24). Files read: README, `backend/app/api/routes/v1/*`, `backend/app/schemas/**`, `backend/app/services/api_key_service.py`, `backend/app/utils/auth.py`, `mcp/README.md`, `docs/api-reference/guides/webhooks.mdx`, `docs/providers/strava-api-integration.mdx` | OK |
| `gh release list`: latest release **0.11.0** ("Daily aggregates & faster summaries", 2026-11-02). Releases are still pre-1.0; 0.9.0 was flagged "breaking changes". | OK |
| https://openwearables.io/docs/api-reference/introduction | OK |
| https://openwearables.io/docs/mcp-server | OK |
| A generated OpenAPI JSON from a running instance | Not fetched. Routes and schemas were read from source instead. A running instance serves FastAPI's default `/openapi.json` and `/docs` (TODO: verify the path). |

## Base path and auth

- Base: `{your_host}/api/v1` (`settings.api_v1 = "/api/v1"`). Locally: `http://localhost:8000/api/v1`.
- **External/data endpoints:** header `X-Open-Wearables-API-Key: sk-<32 hex>`.
  - Keys come from `sk-` + `secrets.token_hex(16)`. They are shown once and stored hashed.
  - Create keys in the dashboard (Settings > Credentials) or at `POST /api/v1/developer/api-keys`, which needs a developer JWT. Rotate with `POST /developer/api-keys/{id}/rotate`.
  - The same endpoints also accept a developer JWT (`Authorization: Bearer`).
- **Developer JWT:** comes from `POST /api/v1/auth/login`. The **outgoing-webhook management endpoints require it** (`DeveloperDep`); the API key does not work there.
- **Other credentials:**
  - SDK user tokens: Bearer with scope `sdk`, used by the mobile SDK.
  - `X-Open-Wearables-Connect-Token`: comes from `POST /users/{user_id}/connect-token` and is used for the provider OAuth pairing flow.
- **Errors:** RFC 9457 `application/problem+json` with `title`, `status`, `detail` and `code`. Branch on `code`. A 422 adds an `errors` list.
- **Rate limits:** the API itself has none; none were found in the code or docs. Upstream provider limits surface as `PROVIDER_RATE_LIMITED`.

## Endpoints (external)

All paths are relative to `/api/v1`. `{user_id}` is an Open Wearables UUID.

| Purpose | Method and path | Key params |
|---|---|---|
| List users | `GET /users` | `page` (1), `limit` (20, max 100), `sort_by`, `sort_order`, `search`, `email`, `provider`, `connection_status`, `has_active_connection`, `last_synced_before`, `include=connections` |
| Get / create / update / delete user | `GET`, `POST`, `PATCH`, `DELETE` `/users[/{user_id}]` | |
| Connect token | `POST /users/{user_id}/connect-token` | |
| Connections | `GET /users/{user_id}/connections`; `DELETE /users/{user_id}/connections/{provider}`; `DELETE .../{provider}/data` | |
| Data sources | `GET /users/{user_id}/data-sources` | |
| Timeseries | `GET /users/{user_id}/timeseries` | `start_time`, `end_time` (required), `types` (repeatable), `resolution=raw\|1min\|5min\|15min\|1hour\|1day\|1week\|1month`, `cursor`, `limit` (50, max 1000), `provider`, `source`, `device_model`, `data_source_id`, `source_selection=all\|per_range\|per_period\|reconcile` |
| Workouts | `GET /users/{user_id}/events/workouts` (also `/types`, `/totals`) | `start_date`, `end_date` (required), `type`, `record_type`, `include=zones\|segments`, `cursor`, `limit`, `provider`, `source`, `device_model`, `data_source_id`, `source_selection=all\|per_session` |
| Sleep sessions | `GET /users/{user_id}/events/sleep` (also `/totals`) | the workout filters, plus `is_nap` and `include=stages` |
| Other events | `GET /users/{user_id}/events/menstrual-cycles`, `/events/meals`; `DELETE` per id | |
| Daily summaries | `GET /users/{user_id}/summaries/activity` (+ `/totals`), `/summaries/sleep`, `/summaries/recovery`, `/summaries/body` (`average_period` 1–7, `latest_window_hours` 1–24), `/summaries/data`, `/summaries/data/timeline` | `start_date`, `end_date`, `cursor`, `limit`, `sort_order` (activity only) |
| Health scores | `GET /users/{user_id}/health-scores` | `limit`, `offset` |
| Coverage / extensions | `GET` routes in `meta.py`, e.g. coverage | |

### Date parameters

- Accepted formats: ISO 8601 (`2026-11-20T00:00:00Z` or with an offset), a date only (`2026-11-20`, which covers the whole day with both boundary days inclusive), or Unix seconds.
- An explicit `T00:00:00Z` end bound excludes that day.

### Pagination

- **Cursor** pagination for timeseries, events and summaries. Response envelope:
  - `{"data": [...], "pagination": {"next_cursor", "previous_cursor", "has_more", "total_count"}, "metadata": {"resolution", "sample_count", "start_time", "end_time"}}`
  - `total_count` is set on the first page only.
  - Cursors are opaque base64 and cannot be reused across endpoints or resolutions.
- **Offset** pagination for `/users`:
  - `{"items", "total", "page", "limit", "pages", "has_next", "has_prev"}`

### Series types and units (`SeriesType`)

Selected types with their units:

- `heart_rate` bpm, `resting_heart_rate` bpm, `walking_heart_rate` bpm
- `heart_rate_variability_sdnn` ms, `heart_rate_variability_rmssd` ms
- `oxygen_saturation` percent, `respiratory_rate` brpm
- `steps` count, `active_energy` kcal, `basal_energy`, `total_energy`, `active_time`
- `distance_walking_running` meters (also `distance_cycling` and other distance types)
- `weight` kg, `body_temperature` celsius, `skin_temperature` celsius
- `vo2_max`, `blood_glucose`, `blood_pressure_systolic` and `_diastolic`

Each sample carries its `unit` string, so read it rather than hard-coding. The full map is `SERIES_TYPE_DEFINITIONS` in `backend/app/schemas/enums/series_types.py`. Retired aliases: `energy` maps to `active_energy`.

### Timestamps and source attribution

- Times are ISO datetimes. A separate `zone_offset` string (`"+01:00"`, pattern `^[+-]\d{2}:\d{2}$`) gives the local offset. Compare Strava's `utc_offset`, which is in seconds.
- Every record has a `source` object:
  - `provider`: one of `apple, samsung, garmin, health_connect, google_health, polar, suunto, whoop, strava, oura, fitbit, ultrahuman, sensorbio, withings, unknown, internal`
  - `source`: the writing app, e.g. "Connect"
  - `device`, `device_type` (`watch|band|phone|scale|ring|...`), `device_id`, and a computed `device_name`

Timeseries sample (`resolution=raw`):

```json
{"data":[{"timestamp":"2026-11-20T07:00:00Z","zone_offset":"+01:00","type":"heart_rate",
  "value":62,"unit":"bpm","source":{"provider":"garmin","source":"garmin","device":"fr265",
  "device_type":"watch","device_id":null,"device_name":"Forerunner 265"},
  "is_daily_total":false,"window_seconds":null,"period_end":null,"computed_by":null,"stats":null}],
 "pagination":{"next_cursor":"ZmFrZQ==","previous_cursor":null,"has_more":true,"total_count":1440},
 "metadata":{"resolution":"raw","sample_count":1,"start_time":"2026-11-20T00:00:00Z","end_time":"2026-11-21T00:00:00Z"}}
```

At day, week or month resolutions, samples also carry `period_end`, `computed_by` and `stats{avg,min,max,sum,last,count}`.

### Event and summary payloads

- **Workout:**
  - Identity and timing: `id` (UUID), `type`, `name`, `start_time`, `end_time`, `zone_offset`, `duration_seconds`, `moving_time_seconds`, `source`, `entry_source`, `intensity`.
  - Metrics: `calories_kcal`, `distance_meters`, `avg_heart_rate_bpm`, `max_heart_rate_bpm`, `heart_rate_min`, `avg_pace_sec_per_km`, `elevation_gain_meters`, `elev_high`, `elev_low`, `steps_count`, `average_speed`, `max_speed`, `average_cadence`, `average_watts`, `max_watts`, `average_met`.
  - With `include`: `hr_zones`, `power_zones`, `segments`.
- **SleepSession:**
  - `id`, `start_time`, `end_time`, `zone_offset`, `source`, `duration_seconds`, `sleep_duration_seconds`, `time_in_bed_seconds`, `efficiency_percent`.
  - `stages{awake_minutes,light_minutes,deep_minutes,rem_minutes}`.
  - `sleep_stage_intervals[{stage,start_time,end_time}]`, present with `include=stages`.
  - `is_nap`, `is_final` (false while the provider may still extend the session).
- **ActivitySummary (daily):**
  - `date`, `source`, `steps`, `distance_meters`, `floors_climbed`, `elevation_meters`, `active_calories_kcal`, `total_calories_kcal`.
  - `active_minutes`, `sedentary_minutes`, `intensity_minutes{light,moderate,vigorous}`, `heart_rate{avg_bpm,max_bpm,min_bpm}`.
  - Each day comes from the highest-priority source, with gaps filled from lower-priority sources.
- **SleepSummary (daily):**
  - `date`, `source`, `start_time`, `end_time`, `zone_offset`, `duration_minutes`, `total_duration_minutes`, `time_in_bed_minutes`, `efficiency_percent`, `stages`, `interruptions_count`.
  - `nap_count`, `nap_duration_minutes`, `sessions[]`.
  - `avg_heart_rate_bpm`, `avg_hrv_sdnn_ms`, `avg_hrv_rmssd_ms`, `avg_respiratory_rate`.
- **Recovery summary:** daily resting HR, HRV, SpO2, main sleep and recovery score. The field list was not enumerated (TODO).
- **Default provider priority:** apple 1, garmin 2, polar 3, suunto 4, whoop 5, fitbit 6, google_health 7, health_connect 8, oura 9, samsung 10, sensorbio 11, strava 12, ultrahuman 13, withings 14. It is configurable via the priorities routes.

## Outgoing webhooks (Svix)

- **Off by default.** Enable with `OUTGOING_WEBHOOKS_ENABLED=true`; otherwise the endpoints return 503.
- Management API (developer JWT):
  - `POST/GET /webhooks/endpoints`
  - `GET/PATCH/DELETE /webhooks/endpoints/{id}`
  - `GET /webhooks/endpoints/{id}/secret` (returns `whsec_...`)
  - `POST /webhooks/endpoints/{id}/test`
  - `GET /webhooks/event-types`
  - `GET /webhooks/messages` (Svix cursor: `iterator`, `limit` ≤ 250)
  - attempts listing per endpoint
- Endpoints can be filtered by event types (`filter_types`) and by `user_id`.
- **Event types:**
  - Connection: `connection.created`, `connection.revoked`
  - Sync: `sync.started`, `sync.completed`, `sync.failed`, `sync.data_type.completed`, `sync.data_type.failed`
  - Records: `workout.created`, `sleep.created`, `meal.created`, `menstrual_cycle.created`
  - Metric groups: `heart_rate.created`, `heart_rate_variability.created`, `steps.created`, `calories.created`, `respiratory_rate.created`, `body_temperature.created`, `stress.created`, `blood_glucose.created`, `blood_pressure.created`, `body_composition.created`, `fitness_metrics.created`, `recovery_score.created`, `activity_timeseries.created`, `workout_metrics.created`, `environmental.created`
  - Granular series: `series.<series_type>.created`
  - Extension events, prefixed with the extension name
- Envelope: `{"type": "<event>", "data": {..., "user_id": "<uuid>"}}`. The workout `data` mirrors the Workout schema.
- **Verification:** standard Svix. Headers are `svix-id`, `svix-timestamp` and `svix-signature` (`v1,<base64 HMAC-SHA256>`). The signed content is `"{svix-id}.{svix-timestamp}.{raw_body}"`, using the endpoint's `whsec_` secret. Use `svix` `Webhook(secret).verify(body, headers)`, which rejects messages older than 5 minutes.
- **Retries:** Svix retries over about 28 h, extending to about 3 days with `Retry-After`.

```json
{"type":"sleep.created","data":{"id":"00000000-0000-0000-0000-000000000001",
 "user_id":"00000000-0000-0000-0000-0000000000aa","start_time":"2026-11-19T23:10:00+01:00",
 "end_time":"2026-11-20T07:00:00+01:00","zone_offset":"+01:00","source":{"provider":"oura"},
 "duration_seconds":28200,"is_nap":false}}
```

## MCP server

- Lives in `/mcp` in the same repo and is built on FastMCP.
- **Transport is stdio only.** Clients such as Claude Desktop and Cursor launch it via `uv run --directory .../mcp start`.
- Configured with `OPEN_WEARABLES_API_URL` and `OPEN_WEARABLES_API_KEY`. It calls the REST API.
- Tools: `get_users`, `get_activity_summary`, `get_sleep_summary`, `get_workout_events`, `get_timeseries`, `get_menstrual_cycles`.
- No stability label is given, and there is no hosted or remote HTTP transport.
- The README warns that fetched records "are sent to the model provider behind your MCP client".

## Terms and compliance

- **License:** MIT. There is no upstream API agreement because you self-host, so obligations come from each upstream provider's terms.
- **Telemetry:** an anonymous daily ping goes to `telemetry.openwearables.io` with no health data. Disable it with `TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1`.
- **Strava conflict:** Open Wearables ships a Strava provider. Its doc covers 10-athlete Standard Tier capacity and the June 2026 subscription requirement.
- **Self-hosted vs hosted:** running it **self-hosted with your own Strava app** is a direct integration. Even so, Strava API Policy prohibits several things this stack does:
  - §5.3: feeding Strava data to an LLM, which covers both the MCP server and any AI layer.
  - §5.16(b): exposing Strava data through an MCP server.
  - §5.4: combining Strava data with other sources' data, which is what `reconcile` and priority merging do.
  - Practical step: exclude `provider=strava` from any AI path, or do not connect Strava.
- **Hosted intermediary:** using a *hosted* Open Wearables run by someone else would be an intermediary under §5.16(a). Strava stopped supporting apps that route data through third-party intermediary platforms in June 2026.

## Uncertain / TODO(verify)

- Confirm the exact `/openapi.json` URL on a running instance and diff it against the routes listed here; the source is at HEAD and may differ from 0.11.0.
- Enumerate the RecoverySummary and BodySummary fields, and the `connections` and `data-sources` response shapes.
- Check whether the API key, not only the JWT, can manage webhook endpoints. The code says only the JWT works.
- The project is pre-1.0 (`backend/pyproject.toml` says 1.0.0 but releases are 0.x), so expect breaking changes and pin a release.
- No API rate limiting was found. Add a proxy-level limit if the API is exposed.
