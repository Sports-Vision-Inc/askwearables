# Benchmark suites: PHIA and real Fitbit data

The study's A/B/C comparison (A: the per-device daily export in the prompt; B: unrestricted data tools; C: the
AskWearables broker with its LLM planner) was first run on a synthetic cohort whose ground truth the generator
knows. Two further suites run the same comparison on a standard benchmark and on real devices. The conditions,
prompts, tools, broker, grant and agent loop are unchanged (`eval/paper/conditions.ts`); the suites only supply
different stores, questions and a per-task "today".

| Suite | Data | Users | Tasks | Ground truth |
|---|---|---|---|---|
| `phia` | PHIA synthetic wearable users (Fitbit-like daily summaries and workouts) | 4 | 180 (120 answerable, 60 unsupported) | PHIA's own reference answers (`label`) |
| `real` | PMData (Fitbit Versa 2, Norway 2019-20) and LifeSnaps (Fitbit Sense, 2021-22) | 16 (8 + 8) | 152 | `eval/paper/real_reference.py`, from the raw files |

Code: `eval/paper/bench.ts` (task sources, stores, scoring, packet reader), `eval/paper/run.ts --suite phia|real`,
`eval/paper/benchdry.ts` (dry run), `eval/paper/real_reference.py` (real references), `eval/paper/report.py`
(sections "Benchmark: ..."; `results.json` key `benchmarks`). Selections: `eval/paper/benchmarks/`.

## "Today"

Each task is anchored on its user's last data day: PHIA's `userToday` (the last date in the user's summary or
exercise table; 2023-10-31 for all four users), and for the real participants the latest day with steps, a main
sleep or a resting heart rate. `runAgent(..., { today })` puts it in the answer rules ("today is ..., yesterday
was ...") and passes it to the broker (`brokerAsk(..., today)`: the planner's date and the packet's `now`). Without
the option both behave exactly as before (the synthetic `TODAY`).

Stores are built from the existing importers (`importPhia`, `importPmdata`, `importLifeSnapsDaily/Hourly`) into an
in-memory store per user, as `buildStore` does for the synthetic people. A source's `last_sync_at` is set to the end
of its newest record. Ingest rejected 0 records in both suites.

## Suite 1: `phia`

PHIA (Merrill et al., github.com/yahskapar/personal-health-insights-agent, commit c0abed8) publishes 4,000
objective questions over 4 synthetic users, each with a reference answer and the pandas code that defines it.
`eval/phia/mapping.json` already classifies every question (see `eval/phia/NOTES.md`).

**Sampling** (fixed seed 20261124; `eval/paper/benchmarks/phia_sample.json` lists the ids):

- *Answerable*, 120: entries with `status: "mapped"` and `extract.from: "l2.value"`, i.e. questions a packet's value
  answers directly (aggregate statistics of steps, resting HR and HRV; threshold day counts on sleep). 548 are
  eligible (every one has a numeric label that PHIA's own code reproduces). Stratified by user × operation,
  proportional allocation. Drawn: aggregate 77 (HRV 27, resting HR 25, steps 25), threshold_check 43 (all sleep).
- *Unsupported*, 60: entries with `status: "unsupported"` (2,163), stratified by reason with at least 2 per reason.
  26 are *computable* from what A and B can see (median or standard deviation, a window set by another query, an
  equality threshold) and 34 need a field no condition sees (zone minutes, stage percentages, workout speed, steps
  or elevation, a list of names).
- Within each stratum, items are ordered by sha256(`seed:id`) and the first k are taken, so the draw does not depend
  on file order.

**Scoring.**

- Answerable: a number agrees with PHIA's label to two significant digits (`agree2`, the comparison
  `npm run eval:phia` uses). Also recorded per run: `correct_as_worded` (the same comparison against PHIA's code
  re-run with "last N days" read as N days ending today, convention `{span: "n", anchor: "base"}`), and
  `correct_2pct` (2% relative, a robustness check against the two-digit rounding boundary).
  PHIA's labels were computed over N + 1 days for "last N days" (NOTES.md, difference 1); in the sample 25 of the 120
  answerable items have a label that differs between the two conventions (16 of them sleep thresholds).
- PHIA's statistics skip missing days (pandas `NaN`); its users have a few days without values. The label is
  over the recorded days, and that is the answer scored, even when an agent's rules would say "unknown".
- Sleep thresholds: PHIA's `sleep_minutes` is time in bed; the catalogue's sleep duration (and every condition's
  export) is time asleep (NOTES.md, difference 3). Kept as PHIA defines it; rows carry `definition_notes`.
- Unsupported: correct only if the answer is `unknown`. `label_match` records whether a numeric answer matched
  PHIA's label anyway. On *computable* items a matching number is a legitimate answer that A or B can reach and C
  by design cannot, so the report shows refusal and label matches by kind rather than treating every number as a
  failure of honesty.

**Licence.** PHIA is CC BY-NC 4.0. Committed files hold ids, question hashes and flags only. Run rows in
`eval/paper/results/phia-*.jsonl` keep the parsed answer, correctness flags, the final `ANSWER:` line, hashed
tool arguments and packet levels; no question text, label, packet or model text. The full rows (final text, tool
arguments, released packets) go to `eval/data/results/phia-<models>.full.jsonl`, which is gitignored.

## Suite 2: `real`

**Participants.** Eligible: at least 45 days with steps, a main sleep and a resting heart rate on the same day
(PMData 13 of 16, LifeSnaps 44 of 71). Eight drawn per dataset with `random.Random(20261124)` over the sorted ids.
The PMData participants' "today" is 2020-03-31 or 2020-04-01; LifeSnaps' range from 2021-07-25 to 2022-01-21.

**Questions.** The ten templates of `tasks.ts`, worded identically, with two changes: the HRV trend becomes a
resting-HR trend (PMData has no HRV; one metric for both datasets), and the workout count is asked only of PMData
(LifeSnaps' CSV variant has no workout sessions). 10 tasks per PMData participant, 9 per LifeSnaps participant.

**Reference definitions** (`eval/paper/real_reference.py`; reads the raw files with pandas, imports nothing from the
project):

| Item | Definition |
|---|---|
| Day | The local date as written (PMData: Fitbit wall-clock time; LifeSnaps: `date`, offsets withheld). |
| Steps | PMData: sum of the per-minute values in `steps.json` for the day, duplicate timestamps kept once. LifeSnaps: daily `steps`. Missing: no rows or a total of 0. |
| Sleep | Fitbit `minutesAsleep` of the night's main sleep record, filed under the wake date. PMData: `sleep.json`, `mainSleep` true, keyed by `dateOfSleep`, duplicate `logId`s once, longest `timeInBed` if two; LifeSnaps: `minutesAsleep` on `date`. Missing: no record or 0. Chosen over the sum of stage minutes (they agree for "stages" logs; for "classic" logs `minutesAsleep` excludes restless time). |
| Resting HR | Fitbit's daily estimate: PMData `resting_heart_rate.json` `value.value` (0 = missing); LifeSnaps `resting_hr`. |
| Workouts | PMData `exercise.json` records (auto-detected and manual), duplicate `logId`s once, on the local date of `startTime`. |
| Low wear | A day with steps but fewer than 8 distinct hours with any steps. Present, but the window's steps answers also accept `unknown`. |

Per question (W7 = the 7 days ending yesterday, and so on):

| Question | Reference |
|---|---|
| steps_total_7d | Sum over W7. Any missing day: `unknown` only. |
| sleep_avg_7d | Mean over the 7 nights. Any missing night: `unknown` only. Tolerance 3%. |
| rhr_yesterday | Yesterday's value ±1 bpm; missing: `unknown`. |
| sleep_under_6h_7d | `yes` if a recorded night is under 360 min; else `unknown` if a night is missing; else `no`. |
| rhr_trend_28d | OLS over the recorded days of W28; change = slope × 27. Fewer than 21 days: `unknown`. `flat` if \|change\| < 1 bpm or \|t\| < 1; the direction if \|change\| ≥ 2 bpm and \|t\| ≥ 2; both in between. Missing days also accept `unknown`. |
| sleep_vs_usual_3d | As tasks.ts: mean of the last 3 recorded nights against the nights 4-31 days ago; below the 25th percentile `yes`, above the median `no`, between either; fewer than 3 nights adds `unknown`. |
| steps_week_vs_prev | As tasks.ts: mean per recorded day, W7 against the 7 days before; within 5% `same`, 5-8% the direction or `same`; missing or low-wear days add `unknown`. |
| workouts_14d | Count over W14 (exact); a day without steps data also accepts `unknown`. |
| rhr_avg_14d | Mean over W14 ±1 bpm. Any missing day: `unknown` only. |
| steps_yesterday | Yesterday's total ±2%; missing: `unknown`; low wear also accepts `unknown`. |

Numbers are scored by `tasks.ts` `score()` (the synthetic suite's tolerance rule). 8 of the 152 tasks have
`unknown` as their only correct answer.

**Natural traps.** Real data has no injected traps; `real_sample.json` counts them per participant, over the whole
record and over the 31 days the questions read: missing steps days, missing nights, missing resting-HR days, low-wear
days, time-zone changes, and duplicates dropped. Neither dataset carries UTC offsets. LifeSnaps' publishers withheld
them, so no zone change can be observed there; PMData's importer assumes Europe/Oslo, so the daylight-saving change
on 2020-03-29 falls in every PMData participant's question window. On that day p01's `steps.json` repeats 226 minute
timestamps (Fitbit's export across the clock change): the reference keeps each minute once, the importer adds
both. In the question windows: p03 has 5 missing steps days, 19 missing nights, 12 missing resting-HR days and 12
low-wear days; p14 1 missing steps day, 7 missing nights, 3 missing resting-HR days and 7 low-wear days; the others 0-5 missing nights and 0-3 other gaps. The
report groups participants by their dominant trap (`pmdata:dst`, `pmdata:missing_days+low_wear+dst`,
`lifesnaps:clean`, ...).

**Licences.** PMData: CC BY-NC 4.0 per the dataset's own `license.txt` (non-commercial; see `docs/datasets.md`).
LifeSnaps: CC BY 4.0. Data stay in `eval/data/` (gitignored). The reference file with derived answers is written to
`eval/data/benchmarks/`; committed files hold participant ids, dates and trap counts. Run rows in
`eval/paper/results/real-*.jsonl` follow the accuracy suite's format (including final text and packets), which
contains derived values (e.g. a week's step total) of these participants, as the synthetic rows do of synthetic people.

## Dry run

`npx tsx eval/paper/benchdry.ts --suite phia|real [--planner llm|none]` prints, for every task, the C packet's
statement next to the reference, with no agent model. The packet is also read directly at level 3 (the finding's
value for numbers, its flag for yes/no, its direction for trends and comparisons; for the real suite, a number over
a window the packet reports as incomplete reads as `unknown`, the references' missing-day rule) and scored.
`--planner llm` uses the deployed planner (llama-3.3-70b on Workers AI), exactly as C does; `--planner none` uses a
fixed spec per task (PHIA: the mapping's spec; real: one hand-written spec per template) and needs no API.
Summaries: `eval/paper/out/benchdry_<suite>_<planner>.json`; per-task detail: `eval/data/benchmarks/`.

Results (2026-11-24):

| Suite | Fixed specs (`--planner none`) | LLM planner, as in C (`--planner llm`) |
|---|---|---|
| real | 145 / 152 (95.4%) | 124 / 152 (81.6%) |
| phia, against PHIA's label | 144 / 180 (80.0%): answerable 84 / 120, unsupported 60 / 60 | 119 / 180 (66.1%): answerable 59 / 120, unsupported 60 / 60 |
| phia, as worded | 163 / 180 (90.6%): answerable 103 / 120 | 131 / 180 (72.8%): answerable 71 / 120 |

With fixed specs the references and importers agree except where a definition differs on purpose:

- real (7 mismatches): the engine's "about the same" for week-vs-week and its trend call scale by the IQR and require
  |t| ≥ 2.5, where the references use relative change and an OLS band (4); the engine's "less than usual" counts
  nights below range, the reference compares the 3-night mean with the 25th percentile (2); p01's duplicate minute
  timestamps on the DST day, counted twice by the importer (1: 61,356 against 58,996 steps).
- phia (36 mismatches on the label): PHIA's N + 1-day window (20, all correct as worded), PHIA's sleep in bed
  against the catalogue's sleep asleep in threshold questions (15), and one resting-HR total on the two-digit rounding
  boundary (345 against 344.94). No computation error.

With the LLM planner, the additional mismatches are the planner's: windows not as worded (real 18: "the last 4 weeks"
planned as about 8 weeks, and several LifeSnaps questions around a year boundary planned over the wrong dates),
"how many workouts" planned as total workout minutes (7 of 8), PHIA resting-HR statistics planned on
`heart_rate`, which the grant does not include, so the gate denies them (12), and 10 answerable PHIA sleep
thresholds refused as outside the catalogue. All 60 unsupported PHIA questions were refused.

## Running

```sh
eval/.venv/bin/pip install pandas                     # once
eval/.venv/bin/python eval/paper/real_reference.py    # real references and selection
npx tsx eval/paper/benchdry.ts --suite phia --planner none   # writes benchmarks/phia_sample.json; no API calls
npx tsx eval/paper/run.ts --suite phia --models open
npx tsx eval/paper/run.ts --suite real --models open
npx tsx eval/paper/run.ts --suite phia --models frontier
npx tsx eval/paper/run.ts --suite real --models frontier
eval/.venv/bin/python eval/paper/report.py
```

Results go to `eval/paper/results/{phia,real}-<models>.jsonl` (one row per condition × model × task, with a
`benchmark` field); resume and error handling are those of the accuracy suite (error rows reopen the key).
Sizes per model: phia 540 runs, real 456 runs.
