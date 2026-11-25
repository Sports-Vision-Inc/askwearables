# Google Health API (successor to the Fitbit Web API)

Read on 2026-11-24. Sources: the live developers.google.com/health docs (`.md.txt` exports), the live discovery document (`revision: 20261123`), and the live webhook public keyset. No real user data or credentials appear here. All IDs and values below are fake or are placeholders taken from the docs.

## URLs fetched

Fetched OK (HTTP 200):
- https://developers.google.com/health (landing page)
- https://developers.google.com/health/about.md.txt
- https://developers.google.com/health/migration.md.txt
- https://developers.google.com/health/get-started.md.txt
- https://developers.google.com/health/setup.md.txt
- https://developers.google.com/health/scopes.md.txt
- https://developers.google.com/health/data-types.md.txt
- https://developers.google.com/health/endpoints.md.txt
- https://developers.google.com/health/filters.md.txt
- https://developers.google.com/health/data-management.md.txt
- https://developers.google.com/health/aggregate-data.md.txt (downloaded, not read in detail)
- https://developers.google.com/health/webhooks.md.txt
- https://developers.google.com/health/rate-limits.md.txt
- https://developers.google.com/health/app-verification.md.txt
- https://developers.google.com/health/developer-checklist.md.txt
- https://developers.google.com/health/release-notes.md.txt
- https://developers.google.com/health/troubleshooting.md.txt (downloaded, not read in detail)
- https://developers.google.com/health/data-types/skin-temperature.md.txt, data-types/sleep.md.txt (downloaded, skimmed)
- https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints.md.txt (only partly read; it is truncated at about 100k characters)
- https://developers.google.com/health/reference/rest/v4/users/getIdentity.md.txt
- https://developers.google.com/health/policies/health-api-developer-terms-and-conditions.md.txt
- https://developers.google.com/health/policies/health-api-developer-user-data-policy.md.txt
- https://developers.google.com/terms/api-services-user-data-policy.md.txt
- https://health.googleapis.com/$discovery/rest?version=v4 (full discovery JSON, the primary source for schemas)
- https://health.googleapis.com/$discovery/rest?version=v4beta
- https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json (Tink keyset with 5 ENABLED ECDSA keys, outputPrefixType TINK)

Failed (404):
- developers.google.com/llms.txt and /health/llms.txt
- /health/guides/webhooks.md.txt (the real path is /health/webhooks.md.txt)
- /health/quotas.md.txt (the real page is /health/rate-limits.md.txt)
- /health/terms.md.txt and /health/policy.md.txt (the real pages are under /health/policies/...)
- /health/reconciled-stream.md.txt (no dedicated page; see endpoints.md and data-management.md)

## Status and timeline (about.md)

- **2026-03-24:** Google Health API launched.
- **2026-09-30:** Support for the Fitbit Web API ended.
- **2026-11-02:** "The Fitbit Web API and Fitbit OAuth endpoints were turned off ... Requests to these endpoints fail and return an HTTP `410 Gone` status code."
- Existing Fitbit tokens do not carry over, so every user must re-consent through Google OAuth.
- Before the OAuth flow, the user must have linked Google Health to their Google Account in the Google Health mobile app.

## Base URL and versions

- **Stable:** `https://health.googleapis.com/v4`. The discovery doc gives `rootUrl` `https://health.googleapis.com/`, `batchPath` `batch`, and gRPC package `google.devicesandservices.health.v4`.
- **Beta:** `https://health.googleapis.com/v4beta`. It is a superset of v4 and is not recommended for production. Under the Developer Terms, beta features carry no SLA and are excluded from the deprecation policy.
- Both REST and gRPC are supported. The API follows the AIP conventions (AIP-160 filters, `pageToken`/`nextPageToken` pagination).
- Request headers: `Authorization: Bearer <token>` and `Accept: application/json`.

## OAuth 2.0 (standard Google OAuth)

- **Authorization URL:** `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&response_type=code&access_type=offline&scope=<space-separated scopes>`. Add `prompt=consent` only when you need a new refresh token or the scopes have changed.
- **Token URL:** `POST https://oauth2.googleapis.com/token` (`grant_type=authorization_code` or `grant_type=refresh_token`). The documented refresh response includes `refresh_token_expires_in`.
- **Refresh tokens in Testing mode:** they expire after 7 days.
- **Refresh tokens in Production mode:** they do not expire unless revoked or unused for about 6 months.
- Refresh tokens on demand. Do not refresh every user's token in one batch.
- **Unverified apps:** capped at 100 users ("Testing" mode, using added test users).
- **OAuth token-grant rate limit:** applies per minute and over a 24-hour sliding window. Request a higher quota in advance if you expect more than 10,000 sign-ups or re-auths in 24 hours.

### Scopes

All scopes have the prefix `https://www.googleapis.com/auth/googlehealth.` (this list is from the v4 discovery doc):

| Scope suffix | Notes |
|---|---|
| `activity_and_fitness.readonly` / `.writeonly` | steps, distance, floors, altitude, active-energy-burned, exercise, VO2 max, ... |
| `health_metrics_and_measurements.readonly` / `.writeonly` | heart rate, RHR, HRV, SpO2, respiratory rate, skin temp derivations, weight, body fat, ... |
| `sleep.readonly` / `.writeonly` | sleep |
| `location.readonly` | exercise GPS (TCX export needs this **and** activity_and_fitness) |
| `profile.readonly` / `.writeonly` | profile |
| `settings.readonly` / `.writeonly` | settings |
| `ecg.readonly` | electrocardiogram |
| `irn.readonly` | irregular-rhythm-notification |
| `nutrition.writeonly` (+ `nutrition.readonly` per scopes page; see TODO) | food / nutrition-log / hydration-log |
| `logged_symptoms.readonly` / `.writeonly`, `mindfulness.readonly` / `.writeonly`, `reproductive_health.readonly` / `.writeonly` | write-focused women's-health types |

- Scopes used to have read/write variants. On 2026-05-26 the write variants were renamed to `.writeonly`.
- "All Google Health API scopes are categorized as Restricted" (about.md). Restricted scopes require OAuth app verification plus an annual CASA security assessment.
- Users can grant scopes partially, and the app must degrade gracefully when they do.

Minimal read set for this project:
```
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
```

## Identity / healthUserId

`GET https://health.googleapis.com/v4/users/me/identity` (method `users.getIdentity`). Any Google Health scope is enough to call it.

```json
{ "name": "users/me/identity", "legacyUserId": "Z9Y8X7", "healthUserId": "123456789012345678" }
```

- `legacyUserId` is the old 6-character Fitbit ID. `healthUserId` is the new ID, documented as "up to 63 digits and characters" and numeric in practice.
- Use `healthUserId` as `{user}` in every resource path; the alias `me` also works.
- The mapping is stable and can be cached indefinitely.
- Webhooks identify users by `healthUserId` only.
- If the account is not linked, the call returns HTTP 400 with `status: FAILED_PRECONDITION`, `ErrorInfo.reason: ACCOUNT_NOT_LINKED`, and `metadata.redirect_uri: https://fitbit.google.com/auth/signup`.

Other user endpoints:
- `GET /v4/users/{user}/profile`
- `GET /v4/users/{user}/settings`
- `GET /v4/users/{user}/irnProfile`
- `GET /v4/users/{user}/pairedDevices`

## Data point endpoints

Resource: `users/{user}/dataTypes/{dataType}/dataPoints`. `{dataType}` is kebab-case.

| Method | HTTP | Path |
|---|---|---|
| list (raw; also the intraday path) | GET | `/v4/users/{user}/dataTypes/{dataType}/dataPoints?filter=&pageSize=&pageToken=&dataSourceFamily=` |
| reconcile (reconciled stream) | GET | `/v4/users/{user}/dataTypes/{dataType}/dataPoints:reconcile?filter=&pageSize=&pageToken=&dataSourceFamily=` |
| rollUp (physical-time buckets) | POST | `/v4/users/{user}/dataTypes/{dataType}/dataPoints:rollUp` |
| dailyRollUp (civil-day buckets) | POST | `/v4/users/{user}/dataTypes/{dataType}/dataPoints:dailyRollUp` |
| get | GET | `/v4/users/{user}/dataTypes/{dataType}/dataPoints/{id}` (identifiable types only) |
| create / patch | POST / PATCH | same collection / item paths (returns an `Operation`) |
| batchDelete | POST | `...:batchDelete` |
| exportExerciseTcx | GET | `/v4/users/{user}/dataTypes/exercise/dataPoints/{id}:exportExerciseTcx?alt=media` |

### Paging and filters

- **Default page size:** 1440.
- **Maximum page size:** 10000. For `sleep` and `exercise`, both the default and the maximum are 25.
- `nextPageToken` is empty when there are no more pages.
- Results are ordered by interval start time, **descending**.

Filters use AIP-160 syntax and snake_case type names. Only `>=` and `<` are allowed, combined with `AND`:

- **Interval types:** `steps.interval.start_time >= "2026-11-01T00:00:00Z" AND steps.interval.start_time < "2026-11-02T00:00:00Z"`, or `steps.interval.civil_start_time >= "2026-11-01"`
- **Sample types:** `weight.sample_time.physical_time ...` or `heart_rate.sample_time.civil_time ...`
- **Daily types:** `daily_resting_heart_rate.date >= "2026-11-01"`
- **Sessions:** `exercise.interval.civil_start_time ...`
- **Sleep:** `sleep.interval.end_time` or `sleep.interval.civil_end_time` (`OR` is also allowed)
- **ECG:** `electrocardiogram.interval.start_time >=` only

### Rollup limits

- **Maximum range:** 14 days for `heart-rate`, `active-minutes`, `total-calories`, and `calories-in-heart-rate-zone`; 90 days for all other types.
- **rollUp request:** `{ "range": {"startTime","endTime"}, "windowSize": "3600s", "pageSize", "pageToken", "dataSourceFamily" }`
- **dailyRollUp request:** `{ "range": {"start": CivilDateTime, "end": CivilDateTime}, "windowSizeDays": 1, ... }`. The page size cap is 90, or 14 for the 14-day types.
- **Rollup values** come from reconciled data and exclude off-wrist periods. Examples: `steps.countSum`; `heartRate.beatsPerMinuteAvg`, `beatsPerMinuteMax`, `beatsPerMinuteMin`; `totalCalories.kcalSum`.
- `total-calories` is available only through rollup and requires a time filter or range.

### Reconciled stream and data sources

- `list` returns every stored record as uploaded, so overlapping re-bucketed device syncs and multi-device duplicates all appear.
- `:reconcile` deduplicates overlapping records and conflicts between devices. Where records conflict, it picks the authoritative record instead of merging time ranges.
- The reconcile response uses `ReconciledDataPoint`, whose ID field is `dataPointName` (not `name`). The response has no `dataSource` field.
- Rollups are also computed from reconciled data.

`dataSourceFamily` is a query parameter on list and reconcile, and a body field on the rollups. Allowed values:
- `users/me/dataSourceFamilies/all-sources` (default)
- `.../google-wearables` (Fitbit and Pixel trackers, excluding manual entries)
- `.../google-sources` (first-party sources: devices, manual entries, and Health Connect)
- `.../self-sources` (only data written by this OAuth client)

`list` with `dataSourceFamily` is not supported for `sleep`, `food`, or `food-measurement-unit`; for sleep, use reconcile instead.

Fields on each `DataPoint.dataSource`:
- `platform`: one of FITBIT, HEALTH_CONNECT, HEALTH_KIT, FIT, FITBIT_WEB_API, NEST, GOOGLE_WEB_API, GOOGLE_PARTNER_INTEGRATION
- `recordingMethod`: one of MANUAL, PASSIVELY_MEASURED, DERIVED, ACTIVELY_MEASURED, UNKNOWN
- `device`: `{formFactor, manufacturer, displayName}`
- `application`: `{packageName, webClientId, googleWebClientId}`

### Time representation

- **Physical time:** RFC 3339 UTC strings (`startTime`, `endTime`, `physicalTime`).
- **UTC offset:** a separate Duration string such as `"-28800s"` (`startUtcOffset`, `endUtcOffset`, `utcOffset`).
- **Civil time:** output-only `CivilDateTime` objects, `{date:{year,month,day}, time:{hours,minutes,seconds,nanos}}`, with no zone attached.
- **Daily types:** carry only `date: {year, month, day}`, in the user's local time.

The time shape depends on the record type:
- **Interval types** use `ObservationTimeInterval`: `{startTime, startUtcOffset, endTime, endUtcOffset, civilStartTime, civilEndTime}`.
- **Sample types** use `ObservationSampleTime`: `{physicalTime, utcOffset, civilTime}`.
- **Session types** (sleep, exercise) use `SessionTimeInterval`, which has the same fields as `ObservationTimeInterval`.

### Data types (v4, from data-types.md + discovery)

| Need | dataType | Kind | Payload field / key fields | Ops | Webhook |
|---|---|---|---|---|---|
| Steps | `steps` | interval (1-minute resolution) | `steps.count` (int64 as string), `interval` | list, reconcile, rollup, dailyRollup | yes |
| Heart rate | `heart-rate` | sample | `heartRate.beatsPerMinute` (string), `sampleTime`, `metadata.{sensorLocation,motionContext}` | list, reconcile, rollup, dailyRollup | yes |
| Resting HR | `daily-resting-heart-rate` | daily | `dailyRestingHeartRate.{date, beatsPerMinute}` | list, reconcile | yes |
| HRV (sample) | `heart-rate-variability` | sample | `heartRateVariability.{rootMeanSquareOfSuccessiveDifferencesMilliseconds, standardDeviationMilliseconds, sampleTime}` | list, reconcile | yes |
| HRV (daily) | `daily-heart-rate-variability` | daily | `dailyHeartRateVariability.{date, averageHeartRateVariabilityMilliseconds, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds, nonRemHeartRateBeatsPerMinute, entropy}` | list, reconcile | yes |
| Sleep | `sleep` | session | `sleep.{interval, type: CLASSIC/STAGES, stages[{startTime,endTime,startUtcOffset,endUtcOffset,type: AWAKE/LIGHT/DEEP/REM/ASLEEP/RESTLESS}], summary{minutesAsleep,minutesAwake,minutesInSleepPeriod,minutesToFallAsleep,minutesAfterWakeUp,stagesSummary[{type,minutes,count}]}, metadata{mainSleep,nap,processed,manuallyEdited,stagesStatus,externalId}, outOfBedSegments, shortAwakenings}` | list, get, reconcile, write | yes |
| SpO2 (sample) | `oxygen-saturation` | sample | `oxygenSaturation.{percentage, sampleTime}` | list, reconcile | **no** |
| SpO2 (daily) | `daily-oxygen-saturation` | daily | `dailyOxygenSaturation.{date, averagePercentage, lowerBoundPercentage, upperBoundPercentage, standardDeviationPercentage}` | list, reconcile | yes |
| Respiratory rate | `daily-respiratory-rate` | daily | `dailyRespiratoryRate.{date, breathsPerMinute}` | list, reconcile | yes |
| Resp. rate per sleep | `respiratory-rate-sleep-summary` | sample | `{sampleTime, fullSleepStats, deepSleepStats, lightSleepStats, remSleepStats}` | list, reconcile | yes |
| Skin temp (nightly) | `daily-sleep-temperature-derivations` | daily | `{date, nightlyTemperatureCelsius, baselineTemperatureCelsius, relativeNightlyStddev30dCelsius}` | list, reconcile | yes |
| Skin temp (raw) | `skin-temperature-sensors` | sample | **v4beta only**: `{sampleTime, sensorData}` | list | no |
| Active energy | `active-energy-burned` | interval | `activeEnergyBurned.{kcal, interval}` | list, reconcile, rollup, dailyRollup | **no** |
| Total calories | `total-calories` | rollup only | `totalCalories.kcalSum` | rollup, dailyRollup | no (data-types.md); release notes list `totalCalories` as webhook-capable (conflict) |
| Exercise | `exercise` | session | `exercise.{interval, exerciseType (enum, e.g. RUNNING), displayName, activeDuration, metricsSummary, splits, splitSummaries, exerciseEvents, exerciseMetadata{hasGps,poolLengthMillimeters}, notes}` | list, get, reconcile, write, TCX export | yes |
| Weight | `weight` | sample | `weight.{weightGrams, sampleTime, notes}` | list, get, reconcile, rollup, dailyRollup, write | yes |
| VO2 max | `vo2-max` (sample, `vo2Max`, `measurementMethod`), `daily-vo2-max` (`vo2Max, cardioFitnessLevel, estimated, vo2MaxCovariance`), `run-vo2-max` (`runVo2Max`) | | | list, reconcile (run: + rollups) | vo2-max **no**, daily-vo2-max **no**, run-vo2-max yes |

Other types:
- **Interval and summary types:** `distance`, `floors`, `altitude`, `active-minutes`, `active-zone-minutes`, `activity-level`, `sedentary-period`, `time-in-heart-rate-zone`, `calories-in-heart-rate-zone`, `daily-heart-rate-zones`, `swim-lengths-data`
- **Body and health types:** `body-fat`, `height`, `blood-glucose`, `core-body-temperature`, `electrocardiogram`, `irregular-rhythm-notification`
- **Nutrition and hydration:** `hydration-log`, `nutrition-log`, `food`, `food-measurement-unit`
- **Write-only:** `menstrual-period`, `ovulation-test`, `moods`, `symptoms`
- `basal-energy-burned` exists in the `DataPoint` schema but is not in the data-types table, and the roadmap still lists "Basal Metabolic Rate" as coming in Q4 2026.

### Payload shapes (scrubbed, fake values)

List steps (intraday):
```json
{
  "dataPoints": [{
    "dataSource": {"platform": "FITBIT", "recordingMethod": "PASSIVELY_MEASURED",
                   "device": {"displayName": "Example Tracker", "formFactor": "WATCH"}},
    "steps": {
      "count": "42",
      "interval": {
        "startTime": "2026-11-20T15:05:00Z", "startUtcOffset": "-28800s",
        "endTime": "2026-11-20T15:06:00Z",   "endUtcOffset": "-28800s",
        "civilStartTime": {"date": {"year": 2026, "month": 11, "day": 20}, "time": {"hours": 7, "minutes": 5}},
        "civilEndTime":   {"date": {"year": 2026, "month": 11, "day": 20}, "time": {"hours": 7, "minutes": 6}}
      }
    }
  }],
  "nextPageToken": "opaque-token"
}
```

Heart-rate sample:
```json
{"heartRate": {"beatsPerMinute": "64",
  "sampleTime": {"physicalTime": "2026-11-20T15:05:10Z", "utcOffset": "-28800s",
                 "civilTime": {"date": {"year": 2026, "month": 11, "day": 20}, "time": {"hours": 7, "minutes": 5, "seconds": 10}}},
  "metadata": {"sensorLocation": "WRIST", "motionContext": "SEDENTARY"}}}
```

Daily resting HR:
```json
{"dailyRestingHeartRate": {"date": {"year": 2026, "month": 11, "day": 20}, "beatsPerMinute": "58"}}
```

Sleep (reconcile):
```json
{"dataPoints": [{"dataPointName": "users/123456789012345678/dataTypes/sleep/dataPoints/fake-id",
  "sleep": {"type": "STAGES",
    "interval": {"startTime": "2026-11-20T06:30:00Z", "startUtcOffset": "-28800s", "endTime": "2026-11-20T14:10:00Z", "endUtcOffset": "-28800s"},
    "stages": [{"type": "LIGHT", "startTime": "2026-11-20T06:40:00Z", "endTime": "2026-11-20T07:10:00Z", "startUtcOffset": "-28800s", "endUtcOffset": "-28800s"}],
    "summary": {"minutesAsleep": "410", "minutesAwake": "50", "minutesInSleepPeriod": "460",
                "stagesSummary": [{"type": "DEEP", "minutes": "70", "count": "4"}]},
    "metadata": {"mainSleep": true, "nap": false, "processed": true, "stagesStatus": "SUCCEEDED"}}}]}
```

Rollup:
```json
POST .../dataTypes/heart-rate/dataPoints:rollUp
{"range": {"startTime": "2026-11-20T00:00:00Z", "endTime": "2026-11-21T00:00:00Z"}, "windowSize": "3600s"}
-> {"rollupDataPoints": [{"startTime": "...", "endTime": "...", "heartRate": {"beatsPerMinuteAvg": 71.2, "beatsPerMinuteMin": 55, "beatsPerMinuteMax": 120}}], "nextPageToken": ""}
```

Notes on JSON types:
- int64 fields such as `count`, `beatsPerMinute`, and the sleep minutes are JSON **strings**.
- Floats such as `percentage`, `kcal`, and `weightGrams` are numbers.

## Webhooks

### Subscribers

A subscriber is a project-level resource. It is managed with service-account or Cloud credentials using scope `https://www.googleapis.com/auth/cloud-platform` and an IAM role: Google Health API Read, Editor, or Admin.

Create one with:

`POST https://health.googleapis.com/v4/projects/{PROJECT_NUMBER}/subscribers?subscriberId=my-sub`

Use the project **number**, not the project ID. Using the ID returns 400 or 403.

```json
{"endpointUri": "https://example.com/webhooks/google-health",
 "endpointAuthorization": {"secret": "Bearer example-shared-secret"},
 "subscriberConfigs": [{"dataTypes": ["steps", "sleep"], "subscriptionCreatePolicy": "AUTOMATIC"}]}
```

- The response is an `Operation` with `done: true` and the created `Subscriber` in `response`. `state` is one of UNVERIFIED, ACTIVE, or INACTIVE.
- Manage subscribers with `list`, `patch` (`updateMask`: `endpointUri`, `subscriberConfigs`, `endpointAuthorization`), and `delete` (`?force=true` also deletes child subscriptions).
- Google recommends one subscriber per data type for high-volume types such as steps. Multiple subscribers can share the same endpoint URI.

### Subscription policies

- **AUTOMATIC:** Google subscribes every consenting user for the intersection of the subscriber's types and the user's granted scopes. There is no backfill. Automatic subscriptions cannot be listed or deleted individually.
- **MANUAL:** call `POST .../subscribers/{id}/subscriptions?subscriptionId=...` with body `{"user": "users/{healthUserId}", "dataTypes": [...]}`. Manage these with list, patch, and delete. The list call takes a filter such as `user = "users/X" AND data_type = "sleep"`.

### Endpoint verification

This handshake runs synchronously on create, and on a patch that changes `endpointUri` or `endpointAuthorization`. Google sends two POSTs with User-Agent `Google-Health-API-Webhooks` and body `{"type":"verification"}`:
1. The first request includes the configured `Authorization` header, which must equal your `secret` exactly. Your endpoint must respond `200` or `201`. The discovery doc says 201; the guide says 200 or 201.
2. The second request has no `Authorization` header. Your endpoint must respond `401` or `403`.

If either step fails, the call returns `FAILED_PRECONDITION`. To rotate the secret, accept both the old and new secrets, then `PATCH ?updateMask=endpointAuthorization`.

### Notification request

Each delivery is a `POST` with these headers:
- `Authorization: <your secret>`
- `GOOGLE-HEALTH-API-SIGNATURE: <base64>`
- `Content-Type: application/json`

The body is always a JSON **array** of 1 to 99 items. One delivery can mix users and data types.

```json
[{"data": {"version": "1",
  "clientProvidedSubscriptionName": "auto-000000000000-my-sub-WEBHOOK_DATA_TYPE_STEPS",
  "healthUserId": "123456789012345678",
  "operation": "UPSERT",
  "dataType": "steps",
  "intervals": [{
    "physicalTimeInterval": {"startTime": "2026-11-20T15:00:00Z", "endTime": "2026-11-20T15:05:00Z"},
    "civilDateTimeInterval": {"startDateTime": {"date": {"year": 2026, "month": 11, "day": 20}, "time": {"hours": 7}},
                              "endDateTime":   {"date": {"year": 2026, "month": 11, "day": 20}, "time": {"hours": 7, "minutes": 5}}},
    "civilIso8601TimeInterval": {"startTime": "2026-11-20T07:00:00", "endTime": "2026-11-20T07:05:00"}}]}}]
```

Payload fields:
- **`operation`** is `UPSERT` or `DELETE`. A `DELETE` for an identifiable type (such as sleep) also carries `recordId`.
- **`physicalTimeInterval`** is omitted for daily and full-day data. For those, use the civil fields.
- **System events:** the token list includes `WEBHOOK_DATA_TYPE_USER_DELETED` and `WEBHOOK_DATA_TYPE_USER_REVOKED_ACCESS`. The guide also says there are no notifications for system-level deletions such as permission revocation or account deletion. These two statements conflict; see TODO.
- **Notifications carry no data.** Coalesce by (healthUserId, dataType) and then call `:reconcile` with a civil-time filter.

### Signature verification

- The signature is ECDSA P-256 with SHA-256 over the raw JSON body, made with Tink `PublicKeySign`. The `GOOGLE-HEALTH-API-SIGNATURE` header carries it in base64, using the Tink output prefix: 5 bytes, made of a 1-byte version and a 4-byte keyId, followed by a DER signature.
- **Public keyset:** `https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json`. Keys rotate every 30 days, so cache the keyset and refetch it on an unknown keyId.
- **Recommended:** Tink `PublicKeyVerify`.
- **Manual verification:** base64-decode each key's `keyData.value` (a serialized EcdsaPublicKey proto), take the x and y coordinates from proto fields 3 and 4, build a P-256 key, and verify the DER signature.
- Also check that the `Authorization` header equals your secret.

### Response handling

- **Status below 400:** the delivery counts as acknowledged. Return 204 immediately and process asynchronously.
- **408, 429, 5xx, or a timeout:** delivery is retried with exponential backoff. Notifications stay queued for **24 hours** and are then dropped (webhooks.md). The 2026-05-26 release notes said "up to 7 days" (conflict).
- **Any other 4xx:** the batch is discarded.
- Delivery is best effort, so poll as a fallback.
- Handlers must be idempotent.

### Webhook coverage

Webhooks are **not** available for:
- `oxygen-saturation`
- `active-energy-burned`
- `vo2-max`
- `daily-vo2-max`
- `skin-temperature-sensors`
- `swim-lengths-data`
- `core-body-temperature`
- `electrocardiogram`
- `irregular-rhythm-notification`
- `food`
- the write-only women's-health types

## Rate limits (rate-limits.md)

| Limit | Default |
|---|---|
| Per project, daily | 86.4M requests/day (about 1,000 QPS sustained) |
| Per project, per minute | 120,000 requests/min |
| Per user, per minute | 300 requests/min (about 5 QPS) |
| Unverified apps | 100 users at 2.5 QPS per user, 250 QPS total |

- Over-limit requests get `429 RESOURCE_EXHAUSTED`.
- Retry 429, 503, and 504 with exponential backoff and jitter.
- Request quota increases in the Cloud Console.

## Terms that matter

- **Restricted scopes:** apps need OAuth verification plus an annual third-party **CASA** security assessment. Tier 2 takes about 2-3 weeks and tier 3 about 4-6 weeks; fees run $500-$4,500. HITRUST, SOC 2, or ISO 27001 can speed this up. Unverified apps are capped at **100 users**.
- **In-app disclosure:** required, shown in the normal app flow (not only in the privacy policy), and immediately before consent.
- **Affirmative statement:** you must publish one saying your use complies with the "Google Health API Developer and User Data Policy, including the Limited Use requirements".
- **Approved use cases** (Developer and User Data Policy): features that let users journal, report, monitor, or analyze their health and fitness data, or sync it.

Limited Use rules:
- Use data only for user-facing features that are prominent in the UI.
- Transfer data to third parties only to provide those features with the user's consent, for security, for legal compliance, or in an M&A with consent.
- No human reading of data, except with explicit consent, for security, for legal reasons, or on aggregated and anonymized data.
- Prohibited: ads, data brokers (even with aggregated or anonymized data), credit or lending decisions, use in FD&C Act 201(h) medical devices, use of HIPAA PHI without written approval, and IRB-style research unless you follow the Health Research Policy.

Data handling and conditions:
- **Security:** encrypt data at rest and tokens at rest, use HTTPS, and use HSM-grade key management. Report breaches to security@google.com.
- **Granularity (Developer Terms):** store data "at the same level of granularity as it is collected". For example, do not store only daily totals if per-minute data is available.
- **AI/LLM use:** neither Google Health policy page mentions AI, ML, or LLMs explicitly. No Workspace-style "no generalized AI/ML model training" clause was found in these policies. Sending user data to an LLM provider is a third-party transfer, so it is allowed only to provide a prominent user-facing feature, with the user's consent.
- **Intermediaries:** no explicit clause about aggregators or intermediaries was found. A pure data-reselling intermediary would conflict with the Limited Use transfer rules.

## Uncertain / TODO(verify)

- TODO(verify): `nutrition.readonly`. The scopes page lists it, but the v4 discovery doc does not. The discovery doc lists `logged_symptoms.readonly`, `mindfulness.readonly`, and `reproductive_health.readonly`, which the scopes page omits.
- TODO(verify): whether `total-calories` webhooks exist (data-types.md says No; the 2026-04-14 release notes list it).
- TODO(verify): how long webhook retries last (24 hours in webhooks.md vs 7 days in the 2026-05-26 release notes).
- TODO(verify): whether the `user-deleted` and `user-revoked-access` system notifications are actually delivered (the token table lists them, but the prose says there are none for revocation or account deletion).
- TODO(verify): the `Subscription.dataTypes` description in discovery lists only "altitude, distance, floors, sleep, steps, weight". This is probably stale and conflicts with the webhooks table.
- TODO(verify): the success code for the authorized verification handshake (201 per discovery; 200 or 201 per the guide).
- TODO(verify): the exact HTTP `410 Gone` behavior of the legacy Fitbit endpoints. It is documented in about.md but was not probed directly.
- TODO(verify): whether the `healthUserId` format is always numeric.
- TODO(verify): the full exercise `metricsSummary` fields, and the troubleshooting and aggregate-data guides, which were downloaded but not read in detail.
- TODO(verify): whether the `:reconcile` result for a sample type (such as heart-rate) is a single device stream or merged. The docs describe reconcile mainly for interval and session types.
