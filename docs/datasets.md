# Open datasets

The evaluation and the importer tests use four open datasets. They are downloaded by
`npm run fetch -w @askwearables/eval` (script: `eval/scripts/fetch-datasets.ts`) into `eval/data/`, which is
gitignored. **Never commit anything from `eval/data/`.** The script prints each licence before downloading.
Unit tests use small hand-made fixtures in `packages/importers/test/fixtures/` that mimic the formats; they
contain no real data.

All pages below were read on 2026-11-24.

| Dataset | Licence | Fetched size | Used for |
|---|---|---|---|
| PHIA synthetic users and questions | CC BY-NC 4.0 | 0.7 MB (4 users, 4 question files) | Accuracy eval (`npm run eval:phia`) |
| PMData | CC BY-NC 4.0 per the dataset's own `license.txt` (Simula's page and the HF card metadata say CC BY 4.0) | 337 MB without `heart_rate.json`; about 1.9 GB with it | PMData importer, real-data smoke test |
| LifeSnaps (CSV variant) | CC BY 4.0 | 615 MB zip, 23 MB of CSV extracted | LifeSnaps importer, real-data smoke test |
| MMASH | ODbL 1.0 | 22.7 MB zip, 123 MB extracted | RMSSD vs SDNN check |

Licence notes: PHIA and PMData are non-commercial. They may be used for internal evaluation; nothing derived
from them that reproduces their content may ship in a commercial product. ODbL requires attribution and
share-alike for a derived *database*; our derived numbers in test output are not a database release. Check
again before redistributing anything.

## PHIA (Personal Health Insights Agent)

- Repository: https://github.com/yahskapar/personal-health-insights-agent (linked from the paper; pinned at commit
  `c0abed8096641bd6dc2f8154f25558aa76a28453`). README and `LICENSE` read: "Creative Commons
  Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)".
- Paper: Merrill et al., "Transforming Wearable Data into Personal Health Insights using Large Language Model
  Agents", https://arxiv.org/abs/2406.06464 (Nature Communications, 2026).
- Layout used:
  - `synthetic_wearable_users/summary_df_<id>.csv`: one row per day. Columns: `pseudo_id2, datetime, age, gender,
    weight_kg, resting_heart_rate, heart_rate_variability, fatburn_active_zone_minutes, cardio_active_zone_minutes,
    peak_active_zone_minutes, active_zone_minutes, steps, rem_sleep_minutes, deep_sleep_minutes, awake_minutes,
    light_sleep_minutes, sleep_minutes, bed_time, wake_up_time, stress_management_score, deep_sleep_percent,
    rem_sleep_percent, awake_percent, light_sleep_percent, height_cm`.
  - `synthetic_wearable_users/exercise_df_<id>.csv`: one row per workout. Columns: `pseudo_id2, date, duration,
    activityName, startTime, endTime, averageHeartRate, elevationGain, distance, calories, steps,
    activeZoneMinutes, speed`.
  - `data/auto_eval/<persona>_final_v2.csv`: `question, label, code` (1000 objective questions per persona;
    `label` is the reference answer, `code` the pandas expression that defines it).
  - The README names users 465, 333, 171 and 41 as the evaluation subjects; their question files are
    `health_behavior`, `sedentary_sleeper`, `inactive_insomniacs` and `active_achiver` (spelling as upstream).
  - `data_utils.py` defines `ChiaDataFrame.during()`, the time-window semantics of `code`.
  - `Objective Query - PHIA.xlsx` (4000 queries) is fetched for reference; the eval reads the CSVs.
- Format facts relied on: timestamps are naive local times; `sleep_minutes = deep + rem + light + awake`
  (time in bed); a row's sleep columns describe the night that began on `datetime`.

## PMData

- Dataset page: https://datasets.simula.no/pmdata/ (automated fetch failed on a TLS certificate error; its
  licence statement, CC BY 4.0, is from the search-result snippet of that page).
- Mirror used for download: https://huggingface.co/datasets/aai530-group6/pmdata (pinned revision
  `2c97bcd6713edd075e1d88fa8401ca0b881c9464`). Its README and `license.txt` were read: the text says
  "Attribution-NonCommercial 4.0 International"; the card metadata says `cc-by-4.0`. We treat it as CC BY-NC 4.0.
- Paper: Thambawita et al., "PMData: A Sports Logging Dataset", MMSys '20, https://doi.org/10.1145/3339825.3394926.
- Layout (16 participants `p01`..`p16`, Fitbit Versa 2, November 2019 to March 2020):
  - `pXX/fitbit/steps.json`, `calories.json`, `distance.json`: per-minute `[{"dateTime": "2019-11-01 00:00:00", "value": "0"}]`.
    Calories include basal burn (not imported: the catalogue holds active energy only). Distance is in centimetres per the README (not imported).
  - `pXX/fitbit/heart_rate.json`: every few seconds, `{"dateTime", "value": {"bpm", "confidence"}}` (~120 MB each;
    fetched only with `--pmdata-hr`). The importer streams it and averages per minute.
  - `pXX/fitbit/resting_heart_rate.json`: daily `{"dateTime", "value": {"date", "value", "error"}}`; 0 means none.
  - `pXX/fitbit/sleep.json`: Fitbit sleep logs (`logId, dateOfSleep, startTime, endTime, duration` ms,
    `minutesAsleep, minutesAwake, timeInBed, efficiency, type` "stages"/"classic", `mainSleep, levels.summary`).
  - `pXX/fitbit/exercise.json`: `logId, activityName, startTime, duration` (ms), `calories, averageHeartRate,
    distance, distanceUnit` ("Kilometer"), `steps, elevationGain, ...`.
  - `pXX/fitbit/sleep_score.csv`, `*_active_minutes.json`, `time_in_heart_rate_zones.json`: not imported.
  - `pXX/googledocs/reporting.csv`: `date` (dd/mm/yyyy), `weight` (kg), meals, fluids, alcohol.
  - `pXX/pmsys/wellness.csv, srpe.csv, injury.csv`: self-reports; not imported.
- Timestamps are local wall-clock times with no offset; participants were in Norway, so the importer defaults
  to `Europe/Oslo` (configurable). Upstream repeats some sleep logs and weight reports; idempotent upserts keep one.

## LifeSnaps

- Zenodo: https://zenodo.org/records/6832242, whose latest version is https://zenodo.org/records/7229547
  (`rais_anonymized.zip`, 615 MB, CC BY 4.0).
- Data descriptor: Yfantidou et al., "LifeSnaps, a 4-month multi-modal dataset capturing unobtrusive snapshots
  of our lives in the wild", Scientific Data 2022, https://pmc.ncbi.nlm.nih.gov/articles/PMC9622868/ . Read:
  "all timestamps are stored in local time format", users' UTC offsets are withheld, durations are in
  milliseconds, and "the CSV files are subsets of the MongoDB database presenting aggregated versions of the raw data".
- Exploratory code: https://github.com/Datalab-AUTH/LifeSnaps-EDA (README read).
- CSV variant (`rais_anonymized/csv_rais_anonymized/`), columns as found in the files:
  - `daily_fitbit_sema_df_unprocessed.csv` (7,410 rows, 71 participants): `id, date, nightly_temperature, nremhr,
    rmssd, spo2, full_sleep_breathing_rate, stress_score, sleep_points_percentage, exertion_points_percentage,
    responsiveness_points_percentage, daily_temperature_variation, badgeType, calories, filteredDemographicVO2Max,
    distance, activityType, bpm, lightly/moderately/very_active_minutes, sedentary_minutes, mindfulness_session,
    scl_avg, resting_hr, sleep_duration (ms), minutesToFallAsleep, minutesAsleep, minutesAwake, minutesAfterWakeup,
    sleep_efficiency, sleep_deep/wake/light/rem_ratio, steps, minutes_in/below_default_zone_*, age, gender, bmi,
    step goals, SEMA mood and place columns`.
  - `hourly_fitbit_sema_df_unprocessed.csv` (159,508 rows): `id, date, hour, temperature, badgeType, calories,
    distance, activityType, bpm, mindfulness_session, scl_avg, steps, minutes_in/below_default_zone_*,
    demographics, SEMA columns`.
- Imported: `rmssd` (hrv_rmssd), `spo2`, `full_sleep_breathing_rate`, `resting_hr`, `filteredDemographicVO2Max`,
  `steps`, `minutesAsleep`, `sleep_efficiency` as vendor daily values; `stress_score` as a vendor score; hourly
  `steps` and `bpm`. A 0 in any column but steps means no reading. Not imported: calories (includes basal), the
  temperature columns (`nightly_temperature` is absolute; `daily_temperature_variation` is not defined precisely
  enough in the descriptor to call it the catalogue's deviation), SEMA and survey data. The CSV has no sleep
  start or end times, so sleep arrives as daily values, not sessions.
- The MongoDB dump in the same zip is left packed.

## MMASH

- PhysioNet: https://physionet.org/content/mmash/1.0.0/ ("Open Data Commons Open Database License v1.0").
  Download: https://physionet.org/files/mmash/1.0.0/MMASH.zip.
- Layout: `DataPaper/user_N/` with `user_info.csv, sleep.csv, RR.csv, questionnaire.csv, Activity.csv,
  Actigraph.csv, saliva.csv` (22 users, about 24 hours each).
  - `RR.csv`: `,ibi_s,day,time`: seconds between consecutive beats, recording day 1 or 2, clock time.
  - `sleep.csv`: `,In Bed Date,In Bed Time,Out Bed Date,Out Bed Time,Onset Date,Onset Time,Latency,Efficiency,
    Total Minutes in Bed,Total Sleep Time (TST),...` (dates are recording days 1/2). Some users have no sleep row.
- No calendar dates or offsets: the importer maps day 1 to a chosen date at offset 0.
