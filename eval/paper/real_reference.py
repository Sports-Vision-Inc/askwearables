"""Reference answers for the "real" benchmark suite (PMData and LifeSnaps), computed from the raw dataset files.

Independent of the AskWearables engine and importers: this script reads the files in eval/data/ directly with pandas
and never imports any project code. Definitions are written out below and in eval/paper/BENCHMARKS.md.

Run:  eval/.venv/bin/python eval/paper/real_reference.py
Writes:
  eval/data/benchmarks/real_reference.json   participants, "today", tasks with accepted answers (derived from the
                                             datasets: kept under eval/data/, which is gitignored)
  eval/paper/benchmarks/real_sample.json     the selection only: participant ids, "today", eligibility counts and the
                                             natural data-quality traps per participant (no daily values)

Definitions (one per metric, used for every participant and every question):
  day          the local calendar date as written in the dataset (PMData: Fitbit wall-clock time, Norway;
               LifeSnaps: `date`, local time with the offset withheld by the publishers).
  steps        PMData: sum of the per-minute values in fitbit/steps.json over the day (duplicate minutes kept once).
               LifeSnaps: the daily `steps` column. A day is MISSING for steps when it has no rows or a total of 0.
  sleep        minutes asleep of the night's main sleep record, filed under the wake date. PMData: fitbit/sleep.json
               record with mainSleep = true, `minutesAsleep`, keyed by `dateOfSleep` (Fitbit's wake date); duplicate
               logIds kept once; if two main records share a date, the one with the longest timeInBed. LifeSnaps:
               `minutesAsleep` on `date`. A night is MISSING when there is no such record or the value is 0.
               Fitbit's minutesAsleep is used rather than the sum of stage minutes; for "stages" logs the two agree,
               for "classic" logs minutesAsleep excludes restless minutes.
  resting HR   PMData: fitbit/resting_heart_rate.json `value.value` on the date of `dateTime` (0 = missing).
               LifeSnaps: `resting_hr` (empty or 0 = missing). Fitbit's own daily estimate in both.
  workouts     PMData only: fitbit/exercise.json records (auto-detected and manual), duplicate logIds kept once,
               counted on the local date of `startTime`. LifeSnaps' CSV variant has no workout sessions, so the
               workout question is not asked of LifeSnaps participants.
  low wear     a day with steps but fewer than 8 distinct hours with any steps (PMData from the minute file,
               LifeSnaps from the hourly file). Low-wear days count as present; a question whose window contains
               one also accepts "unknown" for its steps answers, since a coverage-aware system may decline.
Missing data: a total, average or single-day value over a window with a missing day for that metric has one correct
answer, unknown (as in the synthetic suite). Yes/no, trend and comparison questions follow tasks.ts (see each task).
"today" is the participant's last data date: the latest day with steps, a main sleep or a resting HR.
Questions cover windows ending "yesterday" (today - 1).
"""
import datetime as dt
import glob
import json
import math
import os
import random
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
SEED = 20261124
PER_DATASET = 8
MIN_FULL_DAYS = 45
LOW_WEAR_HOURS = 8


def add_days(day, n):
    return (dt.date.fromisoformat(day) + dt.timedelta(days=n)).isoformat()


def days(start, end):
    d, out = dt.date.fromisoformat(start), []
    while d <= dt.date.fromisoformat(end):
        out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


# ---------------------------------------------------------------- loaders: dict day -> value per metric

def load_pmdata(pid):
    base = os.path.join(DATA, "pmdata", pid, "fitbit")
    steps, hours, sleep, rhr, workouts = {}, {}, {}, {}, {}
    dup = {"steps_minutes": 0, "sleep_logs": 0, "exercise_logs": 0}
    p = os.path.join(base, "steps.json")
    if os.path.exists(p):
        s = pd.read_json(p, dtype={"value": "float64"})
        if len(s):
            s["dateTime"] = s["dateTime"].astype(str)
            n0 = len(s)
            s = s.drop_duplicates("dateTime", keep="first")
            dup["steps_minutes"] = n0 - len(s)
            s["day"] = s["dateTime"].str.slice(0, 10)
            s["hour"] = s["dateTime"].str.slice(0, 13)
            steps = s.groupby("day")["value"].sum().to_dict()
            hours = s[s["value"] > 0].groupby("day")["hour"].nunique().to_dict()
    p = os.path.join(base, "sleep.json")
    if os.path.exists(p):
        logs = json.load(open(p))
        seen = set()
        for r in logs:
            if r["logId"] in seen:
                dup["sleep_logs"] += 1
                continue
            seen.add(r["logId"])
            if not r.get("mainSleep"):
                continue
            d = r["dateOfSleep"]
            if d not in sleep or r["timeInBed"] > sleep[d][1]:
                sleep[d] = (r["minutesAsleep"], r["timeInBed"])
        sleep = {d: v[0] for d, v in sleep.items() if v[0] > 0}
    p = os.path.join(base, "resting_heart_rate.json")
    if os.path.exists(p):
        for r in json.load(open(p)):
            v = (r.get("value") or {}).get("value") or 0
            if v > 0:
                rhr[r["dateTime"][:10]] = float(v)
    p = os.path.join(base, "exercise.json")
    if os.path.exists(p):
        seen = set()
        for r in json.load(open(p)):
            if r["logId"] in seen:
                dup["exercise_logs"] += 1
                continue
            seen.add(r["logId"])
            d = r["startTime"][:10]
            workouts[d] = workouts.get(d, 0) + 1
    steps = {d: float(v) for d, v in steps.items() if v > 0}
    return {"steps": steps, "hours": hours, "sleep": sleep, "rhr": rhr, "workouts": workouts, "has_workouts": bool(workouts), "duplicates": dup}


def load_lifesnaps_all():
    root = os.path.join(DATA, "lifesnaps", "csv", "rais_anonymized", "csv_rais_anonymized")
    daily = pd.read_csv(os.path.join(root, "daily_fitbit_sema_df_unprocessed.csv"), usecols=["id", "date", "steps", "minutesAsleep", "resting_hr"])
    hourly = pd.read_csv(os.path.join(root, "hourly_fitbit_sema_df_unprocessed.csv"), usecols=["id", "date", "hour", "steps"])
    out = {}
    hw = hourly[hourly["steps"] > 0].groupby(["id", "date"])["hour"].nunique()
    for pid, g in daily.groupby("id"):
        dups = int(g.duplicated("date").sum())
        g = g.drop_duplicates("date", keep="first")
        pick = lambda col: {r["date"]: float(r[col]) for _, r in g.iterrows() if pd.notna(r[col]) and r[col] > 0}
        hours = hw.loc[pid].to_dict() if pid in hw.index.get_level_values(0) else {}
        out[pid] = {"steps": pick("steps"), "hours": hours, "sleep": pick("minutesAsleep"), "rhr": pick("resting_hr"), "workouts": {}, "has_workouts": False, "duplicates": {"daily_rows": dups}}
    return out


# ---------------------------------------------------------------- selection

def full_days(d):
    return sorted(set(d["steps"]) & set(d["sleep"]) & set(d["rhr"]))


def last_day(d):
    return max([*d["steps"], *d["sleep"], *d["rhr"]])


def dst_changes(start, end, tz="Europe/Oslo"):
    """Days in [start, end] on which the local UTC offset changes (PMData's zone is assumed by the importer)."""
    from zoneinfo import ZoneInfo
    z, out = ZoneInfo(tz), []
    for day in days(start, end):
        a = dt.datetime.fromisoformat(day + "T00:00").replace(tzinfo=z).utcoffset()
        b = dt.datetime.fromisoformat(day + "T23:59").replace(tzinfo=z).utcoffset()
        if a != b:
            out.append(day)
    return out


def traps(d, dataset, today):
    """Natural data-quality traps, over the participant's whole record and over the 31 days the questions read."""
    first = min([*d["steps"], *d["sleep"], *d["rhr"]])
    yday = add_days(today, -1)
    out = {}
    for label, a in (("record", first), ("question_window", add_days(today, -31))):
        span = days(a, yday)
        out[label] = {
            "days": len(span),
            "missing_steps_days": sum(1 for x in span if x not in d["steps"]),
            "missing_sleep_nights": sum(1 for x in span if x not in d["sleep"]),
            "missing_rhr_days": sum(1 for x in span if x not in d["rhr"]),
            "low_wear_days": sum(1 for x in span if x in d["steps"] and d["hours"].get(x, 0) < LOW_WEAR_HOURS),
            # LifeSnaps withholds UTC offsets, so no time-zone change can be observed. PMData has no offsets either;
            # its importer assumes Europe/Oslo, so daylight-saving transitions are the only zone changes it sees.
            "tz_changes": len(dst_changes(a, yday)) if dataset == "pmdata" else None,
        }
    out["duplicates_dropped"] = d["duplicates"]
    return out


# ---------------------------------------------------------------- tasks (same ten templates as tasks.ts)

def q_floor(sorted_xs, f):
    return sorted_xs[math.floor((len(sorted_xs) - 1) * f)]


def ols(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, 0.0
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a = my - b * mx
    sse = sum((y - a - b * x) ** 2 for x, y in zip(xs, ys))
    se = math.sqrt(sse / (n - 2) / sxx) if n > 2 else 0
    return b, (b / se if se > 0 else (0.0 if b == 0 else math.copysign(math.inf, b)))


def tasks_for(d, pid, today):
    yday = add_days(today, -1)
    win = lambda n: days(add_days(today, -n), yday)  # the n days ending yesterday
    T = []

    def add(tag, question, kind, accept, **why):
        T.append({"id": f"{pid}-{tag}", "person": pid, "tag": tag, "question": question, "kind": kind, "accept": accept, "basis": why})

    def low(window):
        return any(x in d["steps"] and d["hours"].get(x, 0) < LOW_WEAR_HOURS for x in window)

    def with_unknown(labels, flag):
        return labels + ["unknown"] if flag and "unknown" not in labels else labels

    w7 = win(7)
    miss7 = [x for x in w7 if x not in d["steps"]]
    # 1. Total steps, last 7 days ending yesterday. Any missing day: unknown only.
    add("steps_total_7d", "How many steps did I take in total over the last 7 days, ending yesterday?", "number",
        {"labels": ["unknown"]} if miss7 else {"number": sum(d["steps"][x] for x in w7), "tol": 0.02, "labels": with_unknown([], low(w7))},
        missing=miss7, low_wear=low(w7))
    # 2. Average sleep, last 7 nights (wake dates). Any missing night: unknown only.
    s7 = [x for x in w7 if x in d["sleep"]]
    add("sleep_avg_7d", "What was my average sleep per night over the last 7 nights, ending yesterday, in minutes?", "number",
        {"labels": ["unknown"]} if len(s7) < 7 else {"number": sum(d["sleep"][x] for x in s7) / 7, "tol": 0.03, "labels": []}, missing=[x for x in w7 if x not in d["sleep"]])
    # 3. Resting HR yesterday.
    add("rhr_yesterday", "What was my resting heart rate yesterday, in bpm?", "number",
        {"number": d["rhr"][yday], "tol": 1.01 / max(1, d["rhr"][yday]), "labels": []} if yday in d["rhr"] else {"labels": ["unknown"]})
    # 4. Any night under 6 hours in the last 7: yes if a recorded night is; otherwise no, or unknown if a night is missing.
    under = any(d["sleep"][x] < 360 for x in s7)
    add("sleep_under_6h_7d", "Did I sleep less than 6 hours on any night in the last 7 nights, ending yesterday?", "yesno",
        {"labels": ["yes"] if under else (["unknown"] if len(s7) < 7 else ["no"])}, nights=len(s7))
    # 5. Resting HR trend over 4 weeks (the synthetic suite asks about HRV; PMData has no HRV, so both datasets use
    # resting HR). OLS slope over the recorded days; change = slope x 27 days.
    w28 = win(28)
    r28 = [x for x in w28 if x in d["rhr"]]
    if len(r28) < 21:
        acc = {"labels": ["unknown"]}
        change = t = None
    else:
        slope, t = ols([w28.index(x) for x in r28], [d["rhr"][x] for x in r28])
        change = slope * 27
        dirn = "up" if change > 0 else "down"
        if abs(change) < 1.0 or abs(t) < 1.0:
            labels = ["flat"]
        elif abs(change) >= 2.0 and abs(t) >= 2.0:
            labels = [dirn]
        else:
            labels = [dirn, "flat"]
        acc = {"labels": with_unknown(labels, len(r28) < 28)}
    add("rhr_trend_28d", "Over the last 4 weeks, ending yesterday, is my resting heart rate trending up, down, or flat?", "trend", acc,
        recorded=len(r28), change_bpm=change, t=t)
    # 6. Sleeping less than usual, last 3 nights: as tasks.ts (mean of last 3 recorded nights against nights 4-31 days ago).
    l3 = [x for x in win(3) if x in d["sleep"]]
    prior = sorted(d["sleep"][x] for x in days(add_days(today, -31), add_days(today, -4)) if x in d["sleep"])
    if not l3 or len(prior) < 4:
        usual = ["unknown"]
    else:
        m3 = sum(d["sleep"][x] for x in l3) / len(l3)
        usual = ["yes"] if m3 < q_floor(prior, 0.25) else ["no"] if m3 > q_floor(prior, 0.5) else ["yes", "no"]
        usual = with_unknown(usual, len(l3) < 3)
    add("sleep_vs_usual_3d", "Have I been sleeping less than usual over the last 3 nights, ending yesterday?", "yesno", {"labels": usual}, recorded=len(l3), prior=len(prior))
    # 7. Steps, last 7 days vs the 7 before (mean per recorded day), as tasks.ts; missing days add unknown.
    prev = days(add_days(today, -14), add_days(today, -8))
    a = [d["steps"][x] for x in w7 if x in d["steps"]]
    b = [d["steps"][x] for x in prev if x in d["steps"]]
    if not a or not b:
        cmp_acc = ["unknown"]
        rel = None
    else:
        rel = (sum(a) / len(a) - sum(b) / len(b)) / (sum(b) / len(b))
        cmp = "same" if abs(rel) < 0.05 else "higher" if rel > 0 else "lower"
        cmp_acc = (["higher", "same"] if rel > 0 else ["lower", "same"]) if abs(rel) < 0.08 else [cmp]
        cmp_acc = with_unknown(cmp_acc, len(a) < 7 or len(b) < 7 or low(w7) or low(prev))
    add("steps_week_vs_prev", "On average per day, did I walk more, less, or about the same in the last 7 days, ending yesterday, compared with the 7 days before that?", "compare",
        {"labels": cmp_acc}, rel=rel)
    # 8. Workouts, last 14 days (PMData only). A day without steps data may hide a workout: also accept unknown.
    w14 = win(14)
    if d["has_workouts"]:
        n = sum(d["workouts"].get(x, 0) for x in w14)
        add("workouts_14d", "How many workouts did I record in the last 14 days, ending yesterday?", "number",
            {"number": n, "tol": 0.001, "labels": with_unknown([], any(x not in d["steps"] for x in w14))})
    # 9. Average resting HR, last 14 days. Any missing day: unknown only.
    r14 = [x for x in w14 if x in d["rhr"]]
    add("rhr_avg_14d", "What was my average resting heart rate over the last 14 days, ending yesterday, in bpm?", "number",
        {"labels": ["unknown"]} if len(r14) < 14 else {"number": sum(d["rhr"][x] for x in r14) / 14, "tol": 1.01 / 60, "labels": []})
    # 10. Steps yesterday.
    add("steps_yesterday", "How many steps did I take yesterday?", "number",
        {"number": d["steps"][yday], "tol": 0.02, "labels": with_unknown([], low([yday]))} if yday in d["steps"] else {"labels": ["unknown"]})
    for t_ in T:
        if not t_["accept"].get("labels"):
            t_["accept"].pop("labels", None)
    return T


def main():
    rng = random.Random(SEED)
    people, sample = [], {"seed": SEED, "per_dataset": PER_DATASET, "min_full_days": MIN_FULL_DAYS, "low_wear_hours": LOW_WEAR_HOURS, "datasets": {}}
    pm = {os.path.basename(p): None for p in sorted(glob.glob(os.path.join(DATA, "pmdata", "p[0-9][0-9]")))}
    for pid in pm:
        pm[pid] = load_pmdata(pid)
    ls = load_lifesnaps_all()
    for name, allp in (("pmdata", pm), ("lifesnaps", ls)):
        elig = sorted(p for p, d in allp.items() if len(full_days(d)) >= MIN_FULL_DAYS)
        chosen = sorted(rng.sample(elig, min(PER_DATASET, len(elig))))
        sample["datasets"][name] = {"participants": len(allp), "eligible": len(elig), "chosen": []}
        for pid in chosen:
            d = allp[pid]
            today = last_day(d)
            tr = traps(d, name, today)
            tasks = tasks_for(d, pid, today)
            people.append({"dataset": name, "id": pid, "today": today, "full_days": len(full_days(d)), "has_workouts": d["has_workouts"], "traps": tr, "tasks": tasks})
            sample["datasets"][name]["chosen"].append({"id": pid, "today": today, "full_days": len(full_days(d)), "tasks": len(tasks), "traps": tr})
            print(f"{name:9s} {pid[:12]:12s} today {today} full days {len(full_days(d)):3d} tasks {len(tasks)} | last 31 days: "
                  f"missing steps {tr['question_window']['missing_steps_days']}, sleep {tr['question_window']['missing_sleep_nights']}, rhr {tr['question_window']['missing_rhr_days']}, "
                  f"low wear {tr['question_window']['low_wear_days']}, tz {tr['question_window']['tz_changes']}")
    os.makedirs(os.path.join(DATA, "benchmarks"), exist_ok=True)
    os.makedirs(os.path.join(HERE, "benchmarks"), exist_ok=True)
    json.dump({"generated_by": "eval/paper/real_reference.py", "seed": SEED, "people": people}, open(os.path.join(DATA, "benchmarks", "real_reference.json"), "w"), indent=1)
    json.dump(sample, open(os.path.join(HERE, "benchmarks", "real_sample.json"), "w"), indent=1)
    n = sum(len(p["tasks"]) for p in people)
    unk = sum(1 for p in people for t in p["tasks"] if t["accept"].get("labels") == ["unknown"] and "number" not in t["accept"])
    print(f"{len(people)} participants, {n} tasks ({unk} with unknown as the only correct answer)", file=sys.stderr)


if __name__ == "__main__":
    main()
