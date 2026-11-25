# Garmin Connect Developer Program (Health API + Activity API)

**Read on 2026-11-24.** Garmin's full Health/Activity API specs (endpoint list, payload schemas, rate limits, changelog) sit behind the partner login at `developerportal.garmin.com` / `apis.garmin.com/tools/*`. I could not read them. Everything below is labelled by source:

- **[G]**: Garmin public page or PDF (authoritative).
- **[G-PDF]**: Garmin's OAuth2 PKCE PDF on developerportal (public, dated 2025-06-11).
- **[3P]**: third-party code or docs (django-garmin 0.1.1, Open Wearables, press). Verify these.

Program status: Garmin paused new applications from about spring 2026 [3P: the5krunner, Terra] and reopened on **2026-10-21** with Personal / Starter / Enterprise tiers [G overview page plus 3P press].

## URLs fetched

| URL | Result |
|---|---|
| https://developer.garmin.com/gc-developer-program/health-api/ | **FAILED 404** (moved) |
| https://developer.garmin.com/gc-developer-program/activity-api/ | **FAILED 404** (moved) |
| https://developer.garmin.com/gc-developer-program/program-faq/ | **FAILED 404** (moved) |
| https://developer.garmin.com/gc-developer-program/overview | OK [G] tiers table |
| https://developer.garmin.com/gc-developer-program/enterprise/health-api/ | OK [G] |
| https://developer.garmin.com/gc-developer-program/enterprise/activity-api/ | OK [G] |
| https://developer.garmin.com/gc-developer-program/enterprise/program-faq/ | OK [G] (8 Q&As, thin) |
| https://developer.garmin.com/gc-developer-program/personal/ (+ personal-api, personal-faq, swagger-docs JS bundles) | OK [G] (JS-rendered; text read from the page bundles) |
| https://developerportal.garmin.com/sites/default/files/OAuth2PKCE.pdf | OK [G-PDF] (5 pages, 2025-06-11) |
| https://www8.garmin.com/en-US/GARMINCONNECTDEVELOPERPROGRAMAGREEMENT/GARMINCONNECTDEVELOPERPROGRAMAGREEMENT_EN.pdf | OK [G] agreement FRM-0952 Rev. B, file dated 2026-03-03. **Note:** the contracting party is Garmin China Shanghai RHQ (China template). |
| https://developerportal.garmin.com/sites/default/files/Garmin%20Connect%20Developer%20Program%20Agreement.pdf | OK [G] Garmin International version, Rev. B, but the PDF is dated **2023-10-04** (stale) |
| https://developer.garmin.com/brand-guidelines/overview/ , /brand-guidelines/api-brand-guidelines/ | OK [G] summary only; the detailed PDF needs a download/agreement |
| https://apis.garmin.com/tools/endpoints | **FAILED**: redirects to login |
| https://www.scribd.com/document/794185184/Garmin-Connect-Developer-Program-Health-API | **FAILED**: landing page only ("Garmin Health API Overview 2025", 53 pages); body not readable |
| https://www.mintlify.com/yocxy2/open-wearables/api/webhooks/garmin | **FAILED 410** |
| https://pypi.org/pypi/django-garmin/json (+ sdist 0.1.1 source and docs) | OK [3P] |
| https://openwearables.io/blog/garmin-connect-api-developer-guide-activities-health-metrics.md (2026-05-06) | OK [3P] |
| https://openwearables.io/docs/providers/garmin-api-integration.md | OK [3P] |
| https://openwearables.io/blog/garmin-connect-developer-program-reopened (2026-10-23) | OK [3P] |
| https://the5krunner.com/2026/09/14/garmin-developer-api-access-paused/ | OK [3P] |
| https://the5krunner.com/2026/10/22/garmin-personal-api/ | OK [3P] |
| https://tryterra.co/blog/garmin-connect-developer-program-pause (2026-09-07) | OK [3P] |
| https://idevice.com/garmin-reopens-its-connect-api-with-free-personal-keys-and-a-fee-for-big-apps.md | OK [3P] (cites DC Rainmaker) |
| https://nango.dev/docs/api-integrations/garmin-oauth2.md | OK [3P] (no URLs listed) |
| https://forums.garmin.com/developer/connect-iq/f/showcase/409293/data-retention-period-for-wellness-api | OK (forum; no official answer) |

## Tiers [G overview page, 2026]

| | Personal | Starter (Business) | Enterprise (Business) |
|---|---|---|---|
| Who | an individual's own data | "starting point for organizations" | "companies operating at scale" |
| How | self-serve key at connect.garmin.com/app/settings/personalApiToken | apply via form (StarterGarminConnectDeveloperAccess) | request via Developer Portal; "commercial terms are tailored" |
| APIs | Activity (JSON+.FIT), Health, Women's Health | Activity, Courses, Health, Training, Women's Health | Starter set + Golf |
| Delivery | **Pull only** | **Push only** | **Push or Ping/Pull** |
| Historical data | not stated | **Not included** | **"1 month +"** |
| Users | own | "Limited" ([3P] 1,000) | Unlimited |
| Support | – | – | Included |

Feature pages [G]: on the Health API page, **Ping/Pull, Multi-Project, backfill and Enhanced Beat-To-Beat Interval** are asterisked "Supported with Enterprise Access only". On the Activity API page, only Multi-Project and backfill are asterisked; Ping/Pull is not. The overview table still makes Starter push-only.

Fees:
- **[G agreement §10.1]** "no license fees or other payments will be due", but Garmin may charge for the API on 30 days' notice.
- **[G agreement §10.2]** Garmin may charge for request volume above the limits in the Application Requirements.
- **[3P press]** Enterprise has a **$1,000 entry fee** credited against a negotiated per-MAU monthly bill. Billing starts **2027-04-01**. Existing partners don't pay the entry fee. Starter is free up to 1,000 users.
- **[3P Terra, quoting earlier Garmin FAQ]** Some metrics, including Enhanced Beat-to-Beat, "may require a license fee or minimum device order" for commercial use.

None of these fee figures are on a public Garmin page I could read.

Personal API [G personal FAQ]:
- For individuals only: "not intended for commercial applications serving multiple end users".
- The key expires after 30, 90 or 180 days or 1 year, and is shown only once.
- Token: `POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token` with header `Authorization: ApiKey <key>`. For China accounts the host is `personal.connectapi.garmin.cn`.
- The access token lasts **24h**. There are **no refresh tokens**; you mint a new token from the key.
- The Swagger docs (public, /gc-developer-program/personal/swagger-docs/) use Connect-style paths, not wellness-api. Examples: `/usersummary-service/usersummary/daily`, `/sleep-service/sleep/dailySleep`, `/hrv-service/hrv/{calendarDate}`, `/wellness-service/wellness/dailyHeartRate`, `/activitylist-service/activities/search/activities`, `/download-service/files/activity/{activityId}`, `/metrics-service/metrics/maxmet/daily/{startDate}/{endDate}`, `/weight-service/weight/range/{startDate}/{endDate}`.
- GitHub: github.com/garmin/connect-personal-api-python.

## OAuth 2.0 PKCE (business tiers) [G-PDF unless noted]

The FAQ [G] says: "All APIs in the Developer Program use OAUTH 2.0." django-garmin [3P] says OAuth 1.0a is retired on 2026-12-31. No Garmin page I could read confirms that date.

1. **Authorize:** `GET https://connect.garmin.com/oauth2Confirm`
   - Required: `response_type=code`, `client_id`, `code_challenge` (S256 of the verifier), `code_challenge_method=S256`.
   - Optional: `redirect_uri`, `state`.
   - The verifier is 43–128 characters from `[A-Za-z0-9-._~]`.
   - CORS preflight is not supported.
   - Return: `<redirect>?code=…&state=…`.
   - Garmin's test tool: https://apis.garmin.com/tools/oauth2/authorizeUser
2. **Token:** `POST https://connectapi.garmin.com/di-oauth2-service/oauth/token` (form-encoded)
   - Fields: `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `code_verifier`, and `redirect_uri` if it was sent in step 1.
   - **Host conflict:** django-garmin and community code use `https://diauth.garmin.com/di-oauth2-service/oauth/token`, while the Garmin PDF says `connectapi.garmin.com`. TODO(verify).
3. **Response:**
   ```json
   {"access_token":"<redacted>","expires_in":86400,"token_type":"bearer",
    "refresh_token":"<redacted>","scope":"PARTNER_WRITE PARTNER_READ CONNECT_READ CONNECT_WRITE",
    "jti":"00000000-0000-0000-0000-000000000000","refresh_token_expires_in":7775998}
   ```
   - The access token lasts **24h**. The refresh token lasts about **90 days** (7,775,998 s).
   - The PDF's prose says "Access tokens expire three months after they are created", which contradicts its own `expires_in` and reads like it means the refresh token.
   - Scope is fixed per app and cannot be modified. API sections are chosen when the app is created; users pick permissions on the consent screen.
4. **Refresh:** same URL, with `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`.
   - "We return a new refresh token every time". **Rotate and persist both tokens.**
   - Refresh at least 600 s before expiry.
5. **API calls:** `Authorization: Bearer <access_token>` on `https://apis.garmin.com/wellness-api/rest/...`
   - `GET /wellness-api/rest/user/id` returns `{"userId":"<opaque-hex>"}`. The ID is stable across re-consent and across a partner's multiple programs. Push and ping payloads carry it.
   - `GET /wellness-api/rest/user/permissions` returns permissions from this set: `ACTIVITY_EXPORT`, `WORKOUT_IMPORT`, `HEALTH_EXPORT`, `COURSE_IMPORT`, `MCT_EXPORT`. The PDF example is malformed JSON (`{[...]}`), so parse it defensively.
   - [3P Open Wearables] `HISTORICAL_DATA_EXPORT` is needed for backfill. It is off by default on the consent screen, and without it backfill returns 403.
   - `DELETE /wellness-api/rest/user/registration` is **mandatory** if your app offers its own "Disconnect" or "Delete account".
   - Permission changes after consent arrive via the **User_Permission webhook**. Its payload shape was not seen.

## Data delivery

Push, ping and pull mechanics are [3P django-garmin / Open Wearables]. The model is consistent across sources, but the official spec wasn't seen.

- **Push:** Garmin POSTs full summaries to the endpoint you configure per summary type in the portal.
  ```json
  {"dailies":[{"userId":"u-fake-123","userAccessToken":"<maybe; legacy OAuth1 field>",
    "summaryId":"x-fake-1","calendarDate":"2026-01-01","startTimeInSeconds":1767225600,
    "startTimeOffsetInSeconds":3600,"durationInSeconds":86400,"steps":8000,
    "activeKilocalories":400,"bmrKilocalories":1700,"restingHeartRateInBeatsPerMinute":55,
    "timeOffsetHeartRateSamples":{"0":60,"15":61}}]}
  ```
- **Ping (Enterprise):** the same envelope, but each entry has a `callbackURL` instead of the data.
  ```json
  {"sleeps":[{"userId":"u-fake-123","callbackURL":"https://apis.garmin.com/wellness-api/rest/sleeps?uploadStartTimeInSeconds=1767225600&uploadEndTimeInSeconds=1767229200"}]}
  ```
  - GET the callback URL with that user's bearer token.
  - Only fetch URLs under `apis.garmin.com/wellness-api/rest/`, so a forged ping can't steal a token.
  - Garmin's guidance (via Scribd snippet): close the ping request first, then fetch asynchronously.
- **Pull (Enterprise):** `GET /wellness-api/rest/{type}?uploadStartTimeInSeconds=&uploadEndTimeInSeconds=`
  - This filters by **upload/sync time**, not the summary's own time.
  - The window is at most **86400 s** [3P].
- **Backfill (Enterprise):** `GET /wellness-api/rest/backfill/{type}?summaryStartTimeInSeconds=&summaryEndTimeInSeconds=`
  - Returns **202** with no body. The data arrives later through push/ping.
  - Limits reported by third parties:
    - django-garmin: up to 90 days per request.
    - Open Wearables: about 30 days back from connect, usually once per type, and "max one day per request". This conflicts with the 90-day figure.
    - Open Wearables: no concurrent backfills per account.
    - Garmin [G] only says "1 month +".
  - A deep history (2–5 years) is **not supported by anything I could see**.
  - Backfill types per Open Wearables: sleeps, dailies, activities, activityDetails, hrv.
- **Notification handling:**
  - Return 200 fast and process asynchronously.
  - Non-200 responses cause redelivery, and endpoints that keep failing get disabled [3P].
  - Expect duplicates: upsert on `summaryId` / `activityId`. Updated summaries are re-sent with the same `summaryId`.
- **Deregistrations:** these arrive as a `deregistrations` key (contains `userId`, and has no `callbackURL` or `uploadStartTimeInSeconds` [3P, Scribd snippet]). The exact shape was not seen.

### Summary types (REST path = notification key) [3P]

`dailies`, `epochs` (15-minute), `sleeps`, `bodyComps`, `stressDetails`, `userMetrics` (VO2max / fitness age), `pulseox`, `respiration` (Open Wearables calls it `allDayRespiration`), `hrv`, `bloodPressures`, `skinTemp`, `healthSnapshot`, `moveIQActivities`, `mct` (menstrual), `activities`, `activityDetails`, `manuallyUpdatedActivities`.

Garmin's Health page [G] lists: Steps, Intensity Minutes, Sleep, Calories, HR, Stress, Pulse Ox, Body Battery, Body Composition, Respiration, Blood Pressure, Enhanced Beat-To-Beat Interval (Enterprise only).

### Field names [3P django-garmin code/tests]

- **Common:** `summaryId`, `calendarDate`, `startTimeInSeconds`, `startTimeOffsetInSeconds`, `durationInSeconds`.
- **dailies:** `steps`, `distanceInMeters`, `activeKilocalories`, `bmrKilocalories`, `floorsClimbed`, `restingHeartRateInBeatsPerMinute`, `min/average/maxHeartRateInBeatsPerMinute`, `timeOffsetHeartRateSamples`, `moderateIntensityDurationInSeconds`, `vigorousIntensityDurationInSeconds`, `averageStressLevel`.
- **sleeps:** `sleepLevelsMap` (`{"deep"|"light"|"rem"|"awake":[{startTimeInSeconds,endTimeInSeconds}]}`) and `validation` (e.g. `ENHANCED_FINAL`).
- **pulseox:** `timeOffsetSpo2Values`, `onDemand`.
- **bodyComps:** `measurementTimeInSeconds`, `weightInGrams`, `bodyFatInPercent`, `bodyMassIndex`, `muscleMassInGrams`, `boneMassInGrams`, `bodyWaterInPercent`.
- **activities:** `activityId`, `activityName`, `activityType`, `averageHeartRateInBeatsPerMinute`, `averageSpeedInMetersPerSecond`, `deviceName`.
- **epochs:** `met`, `intensity`, `activeTimeInSeconds`.

**Not confirmed from any readable source:**
- Body Battery fields: `bodyBatteryChargedValue`.
- Sleep stage durations: `deepSleepDurationInSeconds`, `lightSleepDurationInSeconds`, `remSleepInSeconds`, `awakeDurationInSeconds`.
- HRV: `lastNightAvg`.
- Field names for `userMetrics` (vo2Max…), `stressDetails`, `respiration`, `skinTemp` and `healthSnapshot`.

[3P press] Garmin strips undocumented fields (VO2max, recovery time, performance condition) from API-delivered FIT files.

## Webhook verification

- There is **no HMAC signature and no verification handshake** [3P: Open Wearables, django-garmin].
- The `garmin-client-id` header is public and isn't proof of origin.
- Mitigations:
  - Put a secret token in the webhook URL path.
  - Restrict `callbackURL` to `apis.garmin.com`.
  - Map entries only to known `userId`s.
- No Garmin IP allowlist was found. TODO(verify) in the portal.

## Rate limits

- **Not published publicly.**
- [3P Open Wearables] "100 requests per minute". Unverified.
- [G agreement §5.2(f), §10.2] Garmin may act on "excessive" volume or charge for volume over the limits in the Application Requirements.
- [3P Terra] Users report undocumented 429s on history requests.
- On 429, back off and honour `Retry-After`.

## Terms [G agreement FRM-0952 Rev. B unless noted]

- **§4.1** Use is limited to "internal business purposes". Display is allowed in Licensee apps and third-party apps, with End User consent.
- **§5.2(e)/(o)** You may not "sell, lease, share, transfer, or sublicense the License Key, provide access to the API". You may not make the API available to third parties, or build an API that feeds End User Data to unapproved third parties, without written approval. This **restricts intermediaries and aggregators**. [3P Open Wearables, citing Garmin] Each company needs its own client ID and secret.
- **§15.8** You may not collect users' Garmin credentials and may not build an alternative authorization system. This rules out scraping.
- **§15.5** No selling of personal data without consent.
- **§5.2(d)** Not for "any application where human life may be at stake".
- **§5.4 (US version)** No FCRA, credit, insurance or employment eligibility use.
- **§6.4 (2026 China text)** Any display or distribution of Garmin data must carry attribution under the API Brand Guidelines. This covers title-level displays, secondary screens, exports, derived data and social media. Exemption: Health API data used only in defense, research or remote patient monitoring, when not shown to third parties.
- **§6.6** Give 30 days' notice of new display formats, with mockups, to connect-support@developer.garmin.com.
- **§6.5** You have 14 days to cure non-compliance before data is reduced or suspended.
- **§15.10 (2026 China text)** If End User Data is used "for training with, or processing by, artificial intelligence systems", your privacy policy needs an **AI Transparency Statement**. It must give the purpose, obtain explicit consent before processing, and let the user withdraw. **No outright training ban was seen.** [3P Open Wearables] claims the revised agreement "rules out using Garmin data to train or improve your own AI models". TODO(verify) against the agreement you actually sign.
- **§9.2** Garmin may terminate on 30 days' notice. **§9.4** Termination is automatic on breach.

## Uncertain / TODO(verify)

- [ ] Token host: `connectapi.garmin.com` (Garmin PDF) or `diauth.garmin.com` (django-garmin)?
- [ ] OAuth 1.0a end date (2026-12-31 per django-garmin only).
- [ ] Backfill limits: per-request window (1 day? 90 days?) and total depth ("1 month +"; 30 days per Open Wearables). Is backfill once per type? Which permission (`HISTORICAL_DATA_EXPORT`)?
- [ ] Exact JSON of deregistration and userPermissionsChange notifications.
- [ ] Exact field names for hrv (`lastNightAvg`?), sleep stage durations, Body Battery, userMetrics (`vo2Max`), skinTemp, healthSnapshot, stressDetails, respiration.
- [ ] Whether `userAccessToken` still appears in OAuth2-era push payloads.
- [ ] Rate limits (the 100/min figure is 3P), plus any IP ranges for webhook allowlisting.
- [ ] Enterprise pricing ($1,000 entry plus MAU from 2027-04-01 comes from press only). Is there a beat-to-beat licence fee? What is the Starter user cap (1,000 per press)?
- [ ] The AI clause in the agreement actually presented at sign-up after 2026-10-21 (the global PDF I read is 2023-dated; the China PDF is 2026-03).
- [ ] Whether the pull window is capped at 86400 s.
