# Strava API: provider notes

Read on 2026-11-24. Sources were fetched live. Nothing here comes from memory. All JSON below is fake or scrubbed.

## Sources

| URL | Result |
|---|---|
| https://developers.strava.com/docs/ | OK (overview, pagination, status codes; no policy notices on page) |
| https://developers.strava.com/docs/authentication/ | OK |
| https://developers.strava.com/docs/webhooks/ | OK |
| https://developers.strava.com/docs/rate-limits/ | OK |
| https://developers.strava.com/swagger/swagger.json (+ /swagger/activity.json) | OK (curl) |
| https://www.strava.com/legal/api ("API Agreement (2026)", Effective June 1, 2026) | OK (curl, full text) |
| https://www.strava.com/legal/api_policy ("API Policy (2026)", Effective June 1, 2026). It is incorporated into the Agreement and holds the substantive restrictions. | OK (curl, full text) |
| https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428 (Strava, Jun 1 2026) | OK |
| https://www.techrepublic.com/article/news-strava-api-scraping-crackdown/ (Jun 2 2026) | OK |
| https://dcrainmaker.com/2024/11/stravas-changes-to-kill-off-apps.html (Nov 2024) | OK (first 100k chars) |

## Base URL and conventions

- API base: `https://www.strava.com/api/v3` (swagger `host` + `basePath`).
- The Strava announcement says that **on June 1, 2027 the base URL moves to a "new API v3 domain"**. The new domain is not named yet (TODO). From the same date, tokens must be sent in request headers, not form parameters. Use `Authorization: Bearer <access_token>` now.
- Pagination uses `page` and `per_page` (default 30, max 200). The docs say to "prefer iterating until an empty page is returned".
- Dates are ISO 8601. Status codes: 200, 201, 401, 403, 404, 429, 500.

## OAuth 2.0

- Authorize (web): `GET https://www.strava.com/oauth/authorize`
- Authorize (mobile): `GET https://www.strava.com/oauth/mobile/authorize` (Strava app 75.0 or later)
  - Params: `client_id`, `redirect_uri` (must be inside the app's callback domain; localhost and 127.0.0.1 are allowed), `response_type=code`, `approval_prompt=auto|force`, `scope` (comma- or space-delimited), `state`.
- Token: `POST https://www.strava.com/oauth/token`. The page's cURL example uses `https://www.strava.com/api/v3/oauth/token`, so the docs are inconsistent.
  - Code exchange: `client_id`, `client_secret`, `code`, `grant_type=authorization_code`. The response has `token_type`, `expires_at` (epoch s), `expires_in` (21600), `refresh_token`, `access_token`, `athlete` (summary), `scope`.
  - Refresh: `client_id`, `client_secret`, `refresh_token`, `grant_type=refresh_token`. The response has `access_token`, `expires_at`, `expires_in`, `refresh_token`.
- Access tokens expire **6 hours** after creation.
- **Refresh token rotation:** each refresh returns a refresh token that "may or may not be the same". "Once a new refresh token is returned, the older refresh token is invalidated immediately." Always persist the newest one. If the current access token has more than 1 hour left, the refresh call returns that same access token.
- Revoke: `POST https://www.strava.com/oauth/revoke` is the recommended endpoint. It returns 200 whether or not the token was found. Errors: 400 missing token, 401 bad Authorization header, 503 retry-safe. The legacy `POST https://www.strava.com/oauth/deauthorize` is retired on **June 1, 2027**.

### Scopes

| Scope | Meaning |
|---|---|
| `read` | Public segments, routes, profile, posts, events, club feeds, leaderboards |
| `read_all` | Private routes, private segments and private events |
| `profile:read_all` | All profile info, even when visibility is Followers or Only You |
| `profile:write` | Update weight and FTP; star or unstar segments |
| `activity:read` | Activities visible to Everyone and Followers, excluding privacy-zone data. **Required for activity webhooks.** |
| `activity:read_all` | `activity:read` plus privacy zones and Only Me activities |
| `activity:write` | Create manual activities and uploads; edit activities |

## Key data endpoints

- `GET /athlete/activities?before=<epoch>&after=<epoch>&page=&per_page=` returns `SummaryActivity[]`. Needs `activity:read`. Only Me activities appear only with `activity:read_all`.
- `GET /activities/{id}?include_all_efforts=` returns `DetailedActivity`.
- `GET /activities/{id}/streams?keys=time,heartrate,...&key_by_type=true`. Stream keys: `time, distance, latlng, altitude, velocity_smooth, heartrate, cadence, watts, temp, moving, grade_smooth`.
- `GET /activities/{id}/laps`, `/activities/{id}/zones`, `/athlete`, `/athlete/zones`, `/athletes/{id}/stats`.

### Activity fields (from swagger schema and examples)

- Identity and timing: `id` (int64, also `id_str`), `external_id`, `upload_id`, `athlete.id`, `name`, `sport_type` (use this; `type` is deprecated), `start_date` (UTC ISO, `Z`), `start_date_local` (local wall-clock time, also rendered with a `Z` suffix, so do not treat it as UTC), `timezone` (e.g. `"(GMT-08:00) America/Los_Angeles"`).
- `utc_offset` is in **seconds** (e.g. -25200). It appears in the response examples but **not** in the SummaryActivity schema definition.
- Metrics: `elapsed_time` and `moving_time` (s), `distance` (m), `total_elevation_gain`, `elev_high`, `elev_low` (m), `average_speed` and `max_speed` (m/s), `kilojoules` (rides only, per schema), `average_watts`, `max_watts`, `weighted_average_watts`, `device_watts`, `trainer`, `commute`, `manual`, `private`, `device_name`, `workout_type`.
- `average_heartrate`, `max_heartrate`, `has_heartrate` and `suffer_score` appear in **examples only**, not in the schema definitions.
- `calories` (kcal) is **DetailedActivity only**, along with `description`, `laps`, `splits_metric`, `best_efforts`, `segment_efforts` and `gear`.
- Garmin attribution: the API docs "strongly encourage" it. Policy §4.4 **requires** Garmin attribution when you display Garmin-sourced data.

```json
{
  "id": 1234567890123, "athlete": {"id": 111}, "name": "Morning Run",
  "sport_type": "Run", "start_date": "2026-11-20T14:00:00Z",
  "start_date_local": "2026-11-20T06:00:00Z", "timezone": "(GMT-08:00) America/Los_Angeles",
  "utc_offset": -28800, "elapsed_time": 3000, "moving_time": 2900, "distance": 8000.0,
  "has_heartrate": true, "average_heartrate": 150.1, "max_heartrate": 176,
  "calories": 610.0
}
```

## Webhooks (Push Subscriptions)

- Create: `POST https://www.strava.com/api/v3/push_subscriptions` sent as **form data** with `client_id`, `client_secret`, `callback_url` (255 chars max), `verify_token`.
- View: `GET .../push_subscriptions?client_id=&client_secret=`
- Delete: `DELETE .../push_subscriptions/{id}?client_id=&client_secret=` returns 204.
- **One subscription per application.** It covers all athletes who authorized the app.
- **Validation:** Strava sends `GET <callback_url>?hub.mode=subscribe&hub.challenge=<rand>&hub.verify_token=<yours>`. Check that `hub.verify_token` matches, then within **2 s** respond 200 with `Content-Type: application/json` and the body `{"hub.challenge":"<rand>"}`.
- **Events:** the POST must be acknowledged with 200 within **2 s**. Process asynchronously. A non-200 response is retried, up to 3 attempts total.

```json
{"object_type":"activity","object_id":1234567890123,"aspect_type":"update",
 "owner_id":111,"subscription_id":999,"event_time":1763650000,
 "updates":{"title":"New title","type":"Run","private":"true"}}
```

- `object_type` is `activity` or `athlete`. `aspect_type` is `create`, `update` or `delete`. `updates` keys are `title`, `type` and `private` (`"true"`/`"false"`). Athlete deauthorization arrives as `object_type:"athlete"` with `updates: {"authorized":"false"}`.
- **No signature:** the webhook docs have no signature, HMAC or verification header, so the payload cannot be authenticated cryptographically. Mitigations:
  - Put an unguessable secret path or token in `callback_url`.
  - Check that `subscription_id` matches yours.
  - Treat each event as a hint and re-fetch the object from the API with the user's token before acting.
  - Note: Open Wearables' Strava doc claims "Strava signs its webhook events with a key it does not share". Nothing in Strava's docs supports this, and it makes no practical difference.

## Rate limits (developers.strava.com/docs/rate-limits)

- Default overall limit: **200 requests / 15 min and 2,000 / day**.
- Default "non-upload" (read) limit: **100 / 15 min and 1,000 / day**.
- The 15-minute windows reset at :00, :15, :30 and :45. The daily window resets at midnight UTC. A 429 rejection still counts toward the daily limit.
- Headers: `X-RateLimit-Limit` and `X-RateLimit-Usage` (overall), `X-ReadRateLimit-Limit` and `X-ReadRateLimit-Usage` (read). Each holds two values, "15min,daily".
- **Athlete capacity:** new apps start at capacity **1 ("Single Player Mode")**, meaning only the developer can use the app.
  - A self-serve upgrade raises capacity to **10 athletes**, with read limits of 200/15 min and 2,000/day and overall limits of 400/15 min and 4,000/day.
  - More than 10 athletes requires review: "Until your app has been reviewed, you won't be able to authenticate any additional athletes."
- Policy §3.3 tiers:
  - Standard: up to 10 users, or up to 9,999 users. **A Strava subscription is required**: for new developers from Jun 1 2026, for existing ones from Jun 30 2026.
  - Extended Access: 10,000 or more users, case by case, no subscription required.

## Terms that matter (API Agreement + API Policy, both effective 2026-06-01)

Note: the Agreement page contains no AI clause. The substantive bans are in the **API Policy**, which the Agreement incorporates by reference.

- **AI (Policy §5.3):** "You may not use the Strava API Materials or Strava Data, directly or indirectly, in connection with the development, training, evaluation, or **operation** of any AI Application."
  - The ban explicitly covers grounding, embedding generation, RAG, "ingestion into a context window or working memory", and derived, aggregated, anonymized or model-output data.
  - The only exception is Strava's own MCP (§3.5): subscribers may bring their own AI app to their own data through Strava MCP, for personal use only.
  - Effect: **sending Strava data into an LLM prompt, even only to answer that same user, is prohibited.** This is stricter than the Nov 2024 "model training" wording.
  - TechRepublic still calls inference-only use "less-settled" and advises getting written guidance. The 2026 Policy text itself is explicit.
- **Display (Agreement highlights; Policy §2.3, §6.1):** Strava Data from a user "may be displayed or disclosed in your Developer Application only to that user". Other users' data may not be shown, even when it is public. (§6.1 has an oddly worded "Unless your Developer Application has an athlete capacity of 9,999 or less" clause; TODO(verify) its meaning.)
- **Intermediaries (Policy §5.16):** you may not "operate, offer, or facilitate any abstraction layer, integration-platform-as-a-service, no-code-AI platform, pass-through proxy, intermediary, or aggregator that re-exposes the Strava API Materials". You also may not:
  - operate any MCP server or agent interface that exposes Strava data;
  - share or multiplex tokens across services or end users;
  - build an app whose primary purpose is third-party access.
  The Strava announcement of Jun 1 2026 says: "Apps routing Strava data through third-party intermediary platforms are no longer supported". Direct integrations are unaffected.
- **No analytics or combining (§5.4):** no aggregated or de-identified analytics or insights, and Strava Data may not be **combined with other customer data**. This matters for any multi-source wearable product.
- **Storage (§5.5, §6.2–6.4):**
  - Cache for at most **7 days**.
  - No persistent index: no vector store, search index or embeddings.
  - Reflect deletions made in Strava within **48 h**.
  - On deauthorization or user request, delete the user's data within **30 days** (§7.4) and confirm the deletion to the user in writing (§2.5).
- **Other rules:**
  - No resale, and no selling or transferring data to "AI Application providers, or model developers", even with user consent (§5.10).
  - No charging users for Strava functionality (§5.8).
  - No competing with Strava (§5.2).
  - Breach notice within 24 h (§8.3).
  - Disclose subprocessors on request (§7.7).

## Uncertain / TODO(verify)

- "AI Application", "Persistent Index" and "MCP Server" are capitalized in the Policy but no definitions were found on the page. Ask developers@strava.com.
- The new API v3 domain for June 2027 is not named.
- Token URL: `/oauth/token` vs `/api/v3/oauth/token`. Both appear in the docs.
- `utc_offset` and the heart-rate fields are not in the swagger schema (examples only), so confirm them against a live response.
- Whether the "10 athletes" self-serve tier needs a Strava subscription (per the Policy, yes, for Standard Tier).
- The meaning of the §6.1 "9,999 or less" clause.
