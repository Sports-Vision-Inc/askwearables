# Mobile sync apps

Two thin apps push phone-store health data to the broker: **AskWearables Sync for iOS** (HealthKit) and
**AskWearables Sync for Android** (Health Connect). Neither app answers questions or shows charts. Each one reads the
store, maps records to the canonical shapes in `packages/core/src/types.ts`, and posts them to the ingest endpoint.

Status (2026-11-24): both apps are written, compile and pass their unit tests. Nothing has been submitted to any store
and no developer accounts have been created. Background delivery, permissions sheets and real data have **not** been
exercised on a physical phone yet.

## Platform docs checked (read 2026-11-24)

| Topic | URL |
|---|---|
| Health Connect releases (connect-client 1.1.0 stable, 1.2.0-alpha06 latest) | https://developer.android.com/jetpack/androidx/releases/health-connect |
| Health Connect get started (manifest, rationale activity, compileSdk 36 + AGP 8.9.1 for 1.1.0+) | https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started |
| Health Connect read data (30-day limit, history and background permissions, paging, aggregate for cumulative types) | https://developer.android.com/health-and-fitness/guides/health-connect/develop/read-data |
| Health Connect sync data (Changes tokens, one per type, 30-day token expiry) | https://developer.android.com/health-and-fitness/guides/health-connect/develop/sync-data |
| HKHealthStore.enableBackgroundDelivery (entitlement since iOS 15, hourly caps, call completion handler) | https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:) |
| HKObserverQuery | https://developer.apple.com/documentation/healthkit/hkobserverquery |
| HKAnchoredObjectQuery | https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery |
| Background-delivery entitlement | https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.background-delivery |
| authorizationStatus(for:) ("your app cannot determine whether … permission to read data" was granted) | https://developer.apple.com/documentation/healthkit/hkhealthstore/authorizationstatus(for:) |
| Sleeping wrist temperature (absolute value; Health shows it relative to a baseline) | https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/applesleepingwristtemperature |

Apple pages were read through the documentation JSON that backs each page (`developer.apple.com/tutorials/data/documentation/...json`).
Things that changed from older tutorials and that the code follows:

- connect-client 1.1.0 needs `compileSdk 36` and AGP 8.9.1 or later.
- History and background reads are guarded by feature availability (`HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY`, `FEATURE_READ_HEALTH_DATA_IN_BACKGROUND`). `SkinTemperatureRecord` needs `FEATURE_SKIN_TEMPERATURE`.
- `Metadata` constructors are internal (since 1.1.0-alpha12); `IntervalRecord` and `InstantaneousRecord` are internal too.
- From the June 2026 Health Connect update, on-device steps carry a per-device synthetic package name instead of `android`. The app does not filter aggregates by origin, so no change was needed.
- Since iOS 15 background delivery fails without the `com.apple.developer.healthkit.background-delivery` entitlement.

## What both apps send

`POST https://api.askwearables.app/v1/ingest`, header `Authorization: Bearer <device sync token>`, body
`{"source": Source, "records": CanonicalRecord[]}`. Each request carries at most 2,000 records. On 429, 408 or 5xx
the client waits for `Retry-After` (seconds or HTTP date) or an exponential backoff with full jitter (1 s base, 300 s
cap, 6 attempts). 401/403 and other 4xx are not retried. A `Retry-After` longer than the cap ends the run without
advancing the anchor or token, so the next run re-sends the same delta.

| Field | iOS | Android |
|---|---|---|
| `source.id` | `apple_health:<install uuid>` | `health_connect:<install uuid>` |
| `source.provider` | `apple_health` | `health_connect` |
| `source.device_model` | phone model id, e.g. `iPhone16,2` | `Build.MANUFACTURER Build.MODEL` |
| `source.device_class` | user picks (default `watch`): what mostly writes into the store | same |
| `source.earliest_readable` | `HKHealthStore.earliestPermittedSampleDate()` | with history access: earliest record seen; without: first grant minus 30 days |
| `tz_offset_min` | device time zone's offset at the sample start | same |
| `external_id` | HealthKit object UUID | Health Connect record id (`metadata.id`) |

Exceptions to "external_id = record UUID":

- **Steps and active energy** are sent as hourly totals, not raw samples, because the iPhone and the watch (or two
  Android apps) both record the same steps. Totals come from `HKStatisticsCollectionQuery` / Health Connect
  `aggregateGroupByDuration`, which de-duplicate across writers. Their id is `hk-hourly:<metric>:<hour ISO>` or
  `hc-hourly:<metric>:<hour ISO>`. A later re-send of the same hour overwrites the total (the broker upserts on
  `(source_id, external_id)`).
- **Heart rate on Android**: a `HeartRateRecord` holds a series; each reading becomes a sample with id `<record id>:<epoch ms>`.
- **Sleep on iOS**: HealthKit has stage samples, not sessions. Samples from one writer with gaps of 60 minutes or less
  form a night; the session id is the UUID of its earliest sample. If an earlier sample for that night arrives later,
  the id changes and the broker briefly holds two overlapping sessions. Deleting the stale one needs a delete call the
  ingest API does not have yet.

Metric mapping (all values converted to the catalogue unit on the phone):

| Type | iOS (HealthKit) | Android (Health Connect) | metric, unit |
|---|---|---|---|
| Steps | stepCount, hourly totals | StepsRecord, hourly aggregate | `steps`, count |
| Active energy | activeEnergyBurned, hourly totals | ActiveCaloriesBurnedRecord, hourly aggregate | `active_energy`, kcal |
| Heart rate | heartRate | HeartRateRecord samples | `heart_rate`, bpm |
| Resting HR | restingHeartRate (`vendor_daily`) | RestingHeartRateRecord (`vendor_daily`) | `resting_hr`, bpm |
| HRV | heartRateVariabilitySDNN, s → ms | HeartRateVariabilityRmssdRecord | `hrv_sdnn` (iOS) / `hrv_rmssd` (Android), ms |
| SpO2 | oxygenSaturation, fraction × 100 | OxygenSaturationRecord | `spo2`, percent |
| Respiratory rate | respiratoryRate | RespiratoryRateRecord | `respiratory_rate`, breaths/min |
| VO2 max | vo2Max | Vo2MaxRecord | `vo2max`, ml/kg/min |
| Weight | bodyMass | WeightRecord | `weight`, kg |
| Sleep | sleepAnalysis → session | SleepSessionRecord → session | session `sleep` with stage minutes |
| Workouts | HKWorkout → session (distance, energy, avg HR from workout statistics) | ExerciseSessionRecord → session (distance, energy, avg HR from `aggregate` over the session) | session `workout` |
| Skin temperature | appleSleepingWristTemperature → deviation from the mean of up to 30 earlier nights (needs 5), `derived` | SkinTemperatureRecord mean delta from the writer's baseline | `skin_temp_deviation`, degC |

## iOS app (`mobile/ios`)

Layout:

- `AskWearablesKit/`: a Swift package with all HealthKit logic. Models (`CanonicalModels.swift`), pure mapping
  (`Mapping.swift`), HealthKit conversion (`HealthKitConversion.swift`), the sync engine (`HealthKitSyncEngine.swift`),
  anchor persistence (`AnchorStore.swift`), the uploader (`IngestClient.swift`), Keychain token store and settings.
- `App/`: SwiftUI app (iOS 17+), `Info.plist`, `AskWearablesSync.entitlements`.
- `project.yml`: XcodeGen spec; `AskWearablesSync.xcodeproj` is generated from it and checked in.

How it works:

1. **Permissions.** "Connect Apple Health" calls `requestAuthorization(toShare: [], read:)` for the twelve types. The
   user can allow or refuse each type on the system sheet.
2. **Observers.** `application(_:didFinishLaunchingWithOptions:)` starts one `HKObserverQuery` per type and calls
   `enableBackgroundDelivery(for:frequency: .immediate)` for each. iOS caps most types at hourly. The observer handler
   always calls its completion handler; after three misses HealthKit stops waking the app.
3. **Deltas.** Each wake-up runs an `HKAnchoredObjectQuery` from that type's stored anchor, 5,000 objects per page.
   Each page is mapped and uploaded, and only then is the new anchor written. One file per type lives in
   `Application Support/AskWearables/anchors/`, with `completeUntilFirstUserAuthentication` protection.
4. **Locked phone.** While the phone is locked the store is unreadable and queries fail with
   `errorDatabaseInaccessible`. The app sets a `pendingCatchUp` flag and syncs everything on
   `protectedDataDidBecomeAvailableNotification` (next unlock). It also syncs every time the app comes to the foreground.
5. **Denied or empty.** HealthKit hides whether read access was refused: a refused type looks like a type with no data.
   The Sync tab says so in plain words, shows "No data yet: either nothing has recorded it, or access is off in the
   Health app" per type, and links to the Health app's per-app privacy screen.
6. **Token.** Settings has a secure field for the device sync token. The token is stored in the Keychain with
   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so background uploads work after the first unlock.

Entitlements (`App/AskWearablesSync.entitlements`): `com.apple.developer.healthkit`,
`com.apple.developer.healthkit.access` (empty: no clinical records) and `com.apple.developer.healthkit.background-delivery`.

Build and test (commands verified on this Mac, Xcode 26.6):

```sh
cd mobile/ios
xcodegen generate            # only after editing project.yml
xcodebuild -scheme AskWearablesSync -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
(cd AskWearablesKit && swift test)    # runs the 31 Kit tests on macOS
# Same 31 tests on a simulator. Name a simulator and OS you have installed (`xcrun simctl list devices`);
# without OS=, xcodebuild looks for the newest runtime (26.5 here), which has no iPhone 16 Pro.
xcodebuild test -scheme AskWearablesSync -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=18.6' CODE_SIGNING_ALLOWED=NO
```

Run on your own iPhone:

1. Open `AskWearablesSync.xcodeproj` in Xcode, select the target, then Signing & Capabilities. Pick your team and
   change the bundle id if `app.askwearables.sync` is taken. HealthKit must appear as a capability with Background
   Delivery ticked. The entitlements file already asks for both. Check Apple's supported-capabilities table for your
   account type: free personal teams do not get every capability, and HealthKit may need a paid membership.
2. Turn on Developer Mode on the phone, connect it, and press Run.
3. In the app: Settings → paste the token → Sync → Connect Apple Health.
4. Background delivery does not run in the Simulator; test it on the phone. Leave it locked overnight, then unlock it
   and check that each type's "Last checked" time moves.

## Android app (`mobile/android`)

Layout: one `app` module, Kotlin, minSdk 28 (the Health Connect app needs Android 9), compileSdk and targetSdk 36,
AGP 8.13.2, Kotlin 2.2.21, Gradle 8.14.3 via the wrapper (with its checksum pinned), `connect-client:1.1.0`,
`work-runtime-ktx:2.10.5`. JSON is built with `kotlinx-serialization-json` element builders, so no compiler plugin
is needed.

- `model/Canonical.kt`: models and `toJson()`.
- `mapping/Mapper.kt`: pure mapping (unit-tested).
- `hc/`: type list and permissions, record conversion, and `HealthConnectSync` (tokens, aggregation, backfill).
- `net/IngestClient.kt`: batching, retries, Retry-After.
- `store/Stores.kt`: SharedPreferences state, and the token encrypted with an Android Keystore AES-GCM key.
- `work/SyncWorker.kt`: hourly periodic WorkManager job plus a one-off "sync now" job.
- `ui/`: `MainActivity` (onboarding, token, status) and `PermissionsRationaleActivity` (privacy text that Health
  Connect opens; declared for Android 13 and earlier and as the Android 14+ `VIEW_PERMISSION_USAGE` alias).

How it works:

1. **Onboarding** requests, in one Health Connect sheet: read access for each type, `READ_DISTANCE` (for workout
   distance), `PERMISSION_READ_HEALTH_DATA_HISTORY` and `PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND`. The last two are
   requested only where the feature is available on the device. The first grant time is stored.
2. **Earliest readable date.** Without history access, Health Connect serves only 30 days before the first grant, so
   `earliest_readable` = first grant minus 30 days. With history access it is the earliest record start the app has
   seen. The main screen shows both permission states and the date.
3. **First sync per type**: take a Changes token (one per type, as the docs recommend), then backfill. Steps and
   active energy use `aggregateGroupByDuration` in one-hour buckets, 7 days per request, starting at the first record.
   Other types use paged `readRecords` (1,000 per page). The token is stored only after the backfill has uploaded.
4. **Later syncs**: `getChanges` page by page. Upserts from other apps are mapped. Cumulative types re-aggregate each
   affected day and send every touched hour, including zeros, so a lowered total overwrites the old one. Each page is
   uploaded before `nextChangesToken` is saved. An expired token (unused for about 30 days) triggers a re-read from the
   last successful sync minus one day.
5. **Schedule**: an hourly periodic WorkManager job with a network constraint, plus a sync every time the app is
   opened. Without the background permission the job's reads fail, and data arrives when the app is next opened.

Build and test:

```sh
cd mobile/android
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # 26 JVM tests: JSON mapping, record conversion, uploader
./gradlew lintDebug              # passes (warnings only)
```

`local.properties` (git-ignored) points at `~/Library/Android/sdk`; Android Studio writes it automatically.

Run on your own Android phone:

1. Turn on Developer options and USB debugging, connect the phone, and run `./gradlew installDebug` (or Run in
   Android Studio).
2. On Android 13 or earlier, install or update the Health Connect app from Play. The app offers a link when
   `getSdkStatus` says an update is needed. On Android 14 and later it is part of the system.
3. Open the app, paste the token, tap Connect Health Connect, and allow the types plus "access past data" and
   "access data in the background".
4. Health Connect only holds data that other apps write into it. Check that the watch or ring app (Fitbit, Samsung
   Health, Oura and others) has Health Connect sync switched on.

## Known gaps

- **Deletions are not forwarded.** Both platforms report deletions (HealthKit `deletedObjects`, Health Connect
  `DeletionChange`). The ingest API has no delete operation, so the apps count deletions and show the count per type.
  On iOS a deleted step sample also leaves its hourly total stale until another sample in that hour changes.
- **The ingest endpoint does not exist in this repo yet** (`workers/` is empty). `packages/core` `ingest()` rejects
  records whose `source_id` is not a known source, so the endpoint must upsert the posted `source` before ingesting.
- **HRV differs by platform**: HealthKit gives SDNN, Health Connect gives RMSSD, and they stay separate metrics.
- **iOS wrist temperature** is a device-side derived deviation with a simple baseline (mean of up to 30 earlier nights,
  at least 5). It will not match the Health app's figure exactly.
- `tz_offset_min` uses the phone's current time zone rules at the sample start, as specified. It ignores the zone
  stored with the record (HealthKit `HKMetadataKeyTimeZone`, Health Connect `startZoneOffset`), so a trip is attributed
  to the phone's current zone.
- **First iOS sync of years of heart-rate data** is paged 5,000 at a time and can take several foreground sessions.
- **Not tested on hardware**: permission sheets, background wake-ups, locked-phone catch-up, and Health Connect rate
  limits.

## What store submission will need later

Apple (App Store / TestFlight):

- An Apple Developer Program membership, an App ID with the HealthKit capability (Background Delivery on), and a
  distribution provisioning profile.
- A privacy policy URL. App Review requires one for HealthKit apps, and health data may not be used for advertising
  or data mining or sold to third parties (App Review Guidelines 5.1.1 and 5.1.3).
- App Store Connect privacy "nutrition label": Health & Fitness data, collected, linked to the user, not used for tracking.
- Review notes explaining that the app is a sync companion with no UI value without an AskWearables account, plus a
  demo token for the reviewer.
- Clear purpose strings (already in `Info.plist`). Drop `NSHealthUpdateUsageDescription` if review objects, since the
  app writes nothing.

Google (Play):

- A Play Console developer account and app signing.
- The **Health apps declaration form** and the **Health Connect permissions declaration**, with a justification for
  every read type, history access and background access. The data types declared must match the manifest.
- A privacy policy whose text matches `PermissionsRationaleActivity`.
- The Data safety form (health and fitness data collected, encrypted in transit, deletable).
- Current target API level requirements (targetSdk 36 today), and possibly a demo video of the permission flow for review.
