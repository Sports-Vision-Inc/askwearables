# PHIA accuracy eval: method, results and definition differences

Run: `npm run fetch -w @askwearables/eval -- --only phia` once, then `npm run eval:phia -w @askwearables/eval`.
Rebuild the mapping after changing the rules: `npm run phia:mapping -w @askwearables/eval` (review the diff).
Tests: `eval/test/phia.test.ts` (skips without `eval/data`), `eval/test/mapping.test.ts` (always runs).

## What is measured

- Questions: PHIA's 4,000 objective questions, `data/auto_eval/<persona>_final_v2.csv`, 1,000 for each of the
  four synthetic users its README names (465, 333, 171, 41). Each row has the question, a reference answer
  (`label`) and the pandas code that defines it.
- Each question is classified in `mapping.json` (one entry per line): either **mapped** (a QuerySpec plus an
  extraction rule) or **unsupported** (with a reason, no spec). The mapping is generated from PHIA's `code` by
  explicit rules in `eval/src/phia.ts` (`mapQuestion`), because 4,000 entries cannot be written by hand
  consistently; the rules were written by reading the code patterns (45 distinct shapes once numbers and names are
  masked) and the output was reviewed. Question text and answers are not stored (PHIA is CC BY-NC); ids are `<user>:<row>`, plus a hash.
- Each user is imported with `@askwearables/importers` (`importPhia`), ingested into a fresh store, and every
  mapped spec is run through `compute` at level 3 (`includeRaw`).
- Extraction (what an owner reads off their level 3 view, nothing more):
  - `l2.value`: the finding's value (aggregate statistic; threshold_check day count).
  - `sessions`: the list_sessions level 3 list, optionally kept to one provider activity name (`title`), or
    for sleep to nights that began on given dates (`night_of`), then one of sum/mean/min/max/count, or
    first/last N, or the Nth item. No ratios and no thresholds are computed outside the core.
- Match: agree with the reference to two significant digits (`agree2` in `eval/src/phia-code.ts`).
- The reference is also recomputed from PHIA's released data with an independent reading of its code
  (`evalPhia`), so every mismatch can be attributed: our computation, a definition difference, or the label.

## Results (2026-11-24, PHIA commit c0abed8)

4,000 questions: 1,837 mapped to a supported operation, 2,163 classified unsupported (none answered).

Windows as the questions mean them (anchored on the user's last day; "last N days" = N days, as the
core's planner reads it):

| operation | mapped | match | accuracy | mismatches with a documented cause |
|---|---:|---:|---:|---:|
| aggregate | 349 | 290 | 83.1% | 59 of 59 |
| list_sessions | 1,289 | 1,068 | 82.9% | 221 of 221 |
| threshold_check | 199 | 77 | 38.7% | 122 of 122 |
| **all** | **1,837** | **1,435** | **78.1%** | 402 of 402 |

The same specs with PHIA's effective windows (the windows its reference answers were computed over):

| operation | mapped | match | accuracy | mismatches with a documented cause |
|---|---:|---:|---:|---:|
| aggregate | 349 | 349 | 100.0% | 0 |
| list_sessions | 1,289 | 1,272 | 98.7% | 17 of 17 |
| threshold_check | 199 | 119 | 59.8% | 80 of 80 |
| **all** | **1,837** | **1,740** | **94.7%** | 97 of 97 |

Against the spec's pass mark (at least 90% on mapped questions): **78.1% as the questions are worded; 94.7%
when the windows follow PHIA's reference convention.** Every mismatch in both runs has a cause below; none is
a computation error in the core. Excluding the documented differences, agreement is 100%. Threshold checks on
steps, resting heart rate and HRV match 119 of 119 on PHIA's windows; all 80 remaining threshold mismatches are
sleep thresholds (difference 2).

Unsupported, by reason (100% classified, 0 answered):

| reason | questions |
|---|---:|
| statistic_not_offered (median, std) | 679 |
| composed_query_window_depends_on_another_query | 479 |
| sleep_stage_percentage_not_in_catalogue | 454 |
| active_zone_minutes_not_in_catalogue | 156 |
| workout_filter_on_values_not_offered (e.g. hikes with elevation <= 64) | 98 |
| workout_steps_not_in_catalogue | 73 |
| workout_elevation_not_in_catalogue | 62 |
| answer_is_a_list_of_names_not_a_number | 57 |
| single_sleep_stage_threshold_not_offered | 51 |
| workout_speed_not_in_catalogue | 48 |
| equality_threshold_not_offered (`== 545 minutes`) | 6 |

## Definition differences (documented, not bent into the core)

1. **"Last N days" spans N + 1 days in PHIA's reference answers** (`phia_last_n_days_spans_n_plus_1_days`, 362
   mismatches). PHIA's released `data_utils.py` defines "last N days" as N days ending on the reference date,
   but recomputing the labels from the released data shows they were produced over N + 1 days
   (reference date minus N through the reference date). Tested on all 1,327 questions of the form
   `daily_metrics.during('last N days')[col].<statistic>()`: the N + 1 reading reproduces 1,326 labels; the
   N-day reading reproduces 803. The core (and its
   planner, `findWindow`) uses N days ending today, which is what the question says. Not changed.
2. **The reference date is the last row of the table, not today** (`phia_anchor_is_last_row_of_table_not_today`,
   86). `during()` anchors on the last date of the table it is called on, so for workout questions "last 21 days"
   ends on the date of the user's last workout, not on the last day of data. The labels match the whole-table
   anchor (not the anchor after `.query()` that the released code would use). Our windows end on the user's
   last day of data. Not changed.
3. **`sleep_minutes` is time in bed** (`sleep_minutes_is_time_in_bed`, 122; 80 on PHIA's windows). In every row
   `sleep_minutes = deep + rem + light + awake`, i.e. bed time to wake time. The catalogue's `sleep_duration` is
   time asleep (deep + rem + light). Aggregates of `sleep_minutes` are mapped to the in-bed length of sleep
   sessions (list_sessions), which matches; threshold questions ("less than 329 minutes of sleep") are mapped
   to `threshold_check` on `sleep_duration`, the metric the question names, and disagree by definition.
4. **Nights are filed under the evening they began** (handled in the mapping, no mismatches left). PHIA's
   `datetime` for a sleep row is the date the night started (bed time that evening or just after midnight); the
   core attributes sleep to the wake date. Sleep-column questions select nights with `night_of` (local start
   minus 12 hours) over a spec window one day longer. Short naps that end the same evening (e.g. user 41,
   2023-10-30 21:20-23:00) are why a plain one-day shift is not enough.
5. **A workout with distance 0 is missing distance, not zero** (`phia_zero_distance_counted`, 8; 2 on PHIA's
   windows). PHIA averages a 21-minute run with distance 0.0 into "mean distance"; the importer treats 0 as not
   recorded. Not changed.
6. **"My mean X last run" averages every workout that day in PHIA** (`phia_averages_all_workouts_on_that_day`,
   0 mismatches in this data). Mapped as the last run itself.
7. **Labels not reproducible from PHIA's released code and data** (`label_not_reproducible_from_phia_code`):
   16 of the 1,837 mapped labels (and 18 of 4,000 overall) match neither window convention, e.g. user 41's
   "Aerobic Workout yesterday" counts (label 1, no such workout on that day in `exercise_df_41.csv`) and user
   171's run sums over 26-27 days. These look like labels made from a different version of the exercise files.
   They account for 15 of the 17 list_sessions mismatches on PHIA's windows; the other 2 are difference 5.
8. Rows reported as `ours_unknown` always co-occur with one of the causes above (the window, as defined by us,
   holds no matching session or night).

Other choices worth knowing:

- Workout length is `start + duration`, not PHIA's `endTime`, which is rounded to the minute and sometimes
  disagrees (user 465's run on 2023-10-24: 15.6 minutes, endTime 23 minutes after start).
- PHIA's `distance` column has no documented unit (its speeds imply roughly 47 km/h runs); it is stored as given.
- `heart_rate_variability` is imported as `hrv_rmssd` (Fitbit's daily HRV is RMSSD during sleep).

## Planner finding (informational; core not edited)

The core's rule planner (`planWithRules`, no LLM) was run on the same 4,000 question texts with "today" set
to each user's last day:

- Unsupported questions (2,163): planner refused 0, no rule matched 605 (these go to the LLM), and it returned
  a spec, i.e. **guessed, for 1,558** (latest 618, aggregate 409, correlate 251, threshold_check 223,
  list_sessions 57). The spec requires 100% to return unsupported.
- Mapped questions (1,837): the planner chose the same operation and metric for 276.

Minimal repro (today = 2023-10-31):

```ts
import { planWithRules } from "@askwearables/core";
planWithRules("What were the lowest REM sleep percent last 30 days", "2023-10-31");
// -> ok: { metrics: ["sleep_stages"], operation: "latest", window: 2023-10-02..2023-10-31 }
planWithRules("What is the median of my steps last 14 days?", "2023-10-31");
// -> ok: { metrics: ["steps"], operation: "latest", ... }   (median is not an offered statistic)
planWithRules("What is the standard deviation of my resting heart rate last 7 days?", "2023-10-31");
// -> ok: { metrics: ["resting_hr"], operation: "latest", ... }
```

Causes: "what was/is ..." falls through to `latest` whenever a metric word is found; "lowest/highest" are not
read as min/max; percentages, median and standard deviation are not recognised as outside the catalogue.
`eval/data/results/phia-results.json` (gitignored) holds per-question detail after a run.
