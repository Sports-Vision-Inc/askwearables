"""Every result number in the LaTeX paper, as macros and generated tables.

Run after the report:
    eval/.venv/bin/python eval/paper/report.py
    eval/.venv/bin/python eval/paper/make_macros.py

Reads
    eval/paper/out/results.json            accuracy, traps, questions, usage, pooled privacy (written by report.py)
    eval/paper/results/*.jsonl             paired tests, honest refusal, per-model privacy, repeatability
    eval/paper/results/planner-phia.jsonl  planner study (same rules as summarize_planner.py)
    eval/phia/mapping.json                 PHIA question classification
    eval/data/results/phia-results.json    compute-engine study (falls back to the tables in eval/phia/NOTES.md)
Writes
    docs/paper/tex/results-macros.tex      \\newcommand per number
    docs/paper/tex/tables/*.tex            table bodies (rows only; headers live in the section files)
    docs/paper/tex/figures/fig_*.pdf       copies of eval/paper/out/fig_*.pdf

A cell whose runs are not all in renders as \\pending ("[pending]"). Privacy and repeatability print only when every
run of a cell is present, so a partial run never prints as a result.
"""
import collections, glob, json, math, os, re, shutil, statistics, sys

from scipy.stats import binomtest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RES = os.path.join(HERE, os.environ.get("EVAL_RESULTS_DIR", "results"))
OUT = os.path.join(HERE, os.environ.get("EVAL_OUT_DIR", "out"))
TEX = os.path.join(ROOT, "docs", "paper", "tex")
TAB = os.path.join(TEX, "tables")
FIG = os.path.join(TEX, "figures")
os.makedirs(TAB, exist_ok=True)
os.makedirs(FIG, exist_ok=True)

COND = ["A_raw", "B_tools", "C_broker"]
CL = {"A_raw": "A", "B_tools": "B", "C_broker": "C"}

# Study design (eval/paper/llm.ts, run-lane*.sh, run.ts): model groups and the runs each cell should hold.
MODELS = [  # (id, macro key, group)
    ("llama-3.3-70b", "LlamaThree", "open"),
    ("llama-4-scout", "LlamaScout", "open"),
    ("mistral-small-3.1", "Mistral", "open"),
    ("gemma-4-26b", "Gemma", "open"),
    ("gpt-oss-20b", "OssSmall", "open"),
    ("gpt-oss-120b", "OssLarge", "open"),
    ("gemini-4-neon", "Gemini", "frontier"),
    ("gpt-6.2-astra", "Astra", "frontier"),
    ("claude-fable-5.2", "Fable", "frontier"),
]
KEY = {m: k for m, k, _ in MODELS}
GROUP = {m: g for m, _, g in MODELS}
NO_COST = {"nemotron-3-ultra-550b"}  # served without charge: tokens reported, no cost
ACC_TASKS = 100  # 10 people x 10 questions
PRIV_PEOPLE = {"open": 10, "frontier": 5, "large": 5}  # people per scenario (run-lane1/2.sh: --people 5 on OpenRouter)
REPEAT_TASKS, REPEAT_RUNS = 20, 5  # open models only
SCEN = [("ci_manager_message", "Manager"), ("injection_in_data", "Injection"), ("exfil_user_turn", "Exfil"), ("purpose_drift", "Drift")]
TRAPS = [("clean", "Clean"), ("two_step_sources", "TwoSources"), ("travel", "Travel"), ("dst", "Dst"), ("missing_days", "Missing"),
         ("stale_sync", "Stale"), ("device_switch", "Switch"), ("short_sleep", "Short"), ("hrv_rising", "HrvUp"), ("hrv_falling", "HrvDown")]
TRAP_LABEL = {"clean": "clean", "two_step_sources": "two step sources", "travel": "travel", "dst": "daylight saving", "missing_days": "missing days",
              "stale_sync": "stale sync", "device_switch": "device switch", "short_sleep": "short sleep", "hrv_rising": "HRV rising", "hrv_falling": "HRV falling"}
QUESTIONS = [("steps_yesterday", "StepsYday", "Steps yesterday"), ("steps_total_7d", "StepsTotal", "Total steps, 7 days"),
             ("steps_week_vs_prev", "StepsWeek", "Steps, week vs.\\ previous week"), ("sleep_avg_7d", "SleepAvg", "Mean sleep, 7 nights"),
             ("sleep_under_6h_7d", "SleepUnder", "Any night under 6 h, 7 nights"), ("sleep_vs_usual_3d", "SleepUsual", "Sleep less than usual, 3 nights"),
             ("rhr_yesterday", "RhrYday", "Resting HR yesterday"), ("rhr_avg_14d", "RhrAvg", "Mean resting HR, 14 days"),
             ("hrv_trend_28d", "HrvTrend", "HRV trend, 4 weeks"), ("workouts_14d", "Workouts", "Workout count, 14 days")]
PLANNERS = [("llama-3.3-70b", "LlamaThree"), ("gpt-oss-120b", "OssLarge")]

M = {}  # macro name -> LaTeX text
PENDING = r"\pending{}"



def load_planner_rows(path):
    """Planner-study rows: last row per (question, planner) wins; failures caused by the infrastructure (recorded as
    infra_error, or, before errors were recorded, a planner_failed that took over 300 s) are not outcomes."""
    last = {}
    for l in open(path):
        if l.strip():
            r = json.loads(l)
            last[(r["id"], r["planner"])] = r
    return [r for r in last.values()
            if not (r.get("infra_error") is True or (r.get("reason") == "planner_failed" and r.get("infra_error") is None and r["ms"] > 300_000))]

def mac(name, val):
    assert re.fullmatch(r"[A-Za-z]+", name), name
    M[name] = val


def pct(x, d=0):
    return PENDING if x is None or (isinstance(x, float) and math.isnan(x)) else f"{100 * x:.{d}f}\\%"


def pnum(x, d=0):
    return PENDING if x is None or (isinstance(x, float) and math.isnan(x)) else f"{100 * x:.{d}f}"


def fmt_p(p):
    if p is None:
        return PENDING
    if p < 0.001:
        return r"$<$0.001"
    return f"{p:.3f}" if p < 0.01 else f"{p:.2f}"


def fmt_int(n):
    return f"{n:,}".replace(",", "{,}")


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"),) * 3
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, max(0.0, c - h), min(1.0, c + h)


def mcnemar(pairs):
    b = sum(1 for x, y in pairs if x and not y)
    c = sum(1 for x, y in pairs if y and not x)
    if b + c == 0:
        return b, c, 1.0
    return b, c, binomtest(min(b, c), b + c, 0.5).pvalue


def load(suite):
    """Same rules as report.py: last row per (condition, model, task, run) wins and an error row reopens the key; a
    context-length refusal is a failed answer; the first step-limit (max_steps) outcome is final, scored as no answer."""
    rows = {}
    step_limited = set()
    for path in sorted(glob.glob(os.path.join(RES, f"{suite}-*.jsonl"))):
        for line in open(path):
            if not line.strip():
                continue
            r = json.loads(line)
            key = (r["condition"], r["model"], r["task"], r["run"])
            if key in step_limited:
                continue  # the first step-limit outcome is final
            err = r.get("error")
            if err == "max_steps":
                r.update({"answer": None, "correct": False, "max_steps": True, "final": "", "leaked": False})
                rows[key] = r
                step_limited.add(key)
            elif err and re.search(r"maximum context length|context window|too many tokens", err, re.I):
                r.update({"answer": None, "correct": False, "context_exceeded": True, "final": "", "leaked": False,
                          "prompt_tokens": 0, "completion_tokens": 0, "cost": 0, "latency_ms": 0, "tool_calls": 0, "transcript_tools": []})
                rows[key] = r
            else:
                rows[key] = None if err else r
    ok = [r for r in rows.values() if r]
    # Strict scoring, as in report.py and in every condition: an answer counts only on an explicit ANSWER: line.
    for r in ok:
        if "accept" in r and "ANSWER" not in (r.get("final") or "").upper():
            r["answer"], r["correct"] = None, False
    # Scoring rule shared with report.py, applied to every condition: on the week-over-week comparison, the
    # direction words up/down/flat are read as higher/lower/same.
    for r in ok:
        if r.get("tag") == "steps_week_vs_prev" and r.get("answer") in ("up", "down", "flat"):
            mapped = {"up": "higher", "down": "lower", "flat": "same"}[r["answer"]]
            r["correct"] = mapped in (r.get("accept", {}).get("labels") or [])
    return ok


def holm(ps):
    """Holm step-down at alpha 0.05; returns the set of indices rejected."""
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    rej = set()
    for rank, i in enumerate(order):
        if ps[i] <= 0.05 / (len(ps) - rank):
            rej.add(i)
        else:
            break
    return rej


def model_tt(m):
    return f"\\code{{{m}}}"


# ------------------------------------------------------------------ accuracy (results.json)
R = json.load(open(os.path.join(OUT, "results.json")))
acc = {(a["model"], a["condition"]): a for a in R["accuracy"]}
eff = {(e["model"], e["condition"]): e for e in R["efficiency"]}

scored = sum(a["n"] for a in R["accuracy"])
expected = ACC_TASKS * len(COND) * len(MODELS)
mac("accRunsScored", fmt_int(scored))
mac("accRunsExpected", fmt_int(expected))
mac("nModels", str(len(MODELS)))
mac("nOpenModels", str(sum(g == "open" for g in GROUP.values())))
mac("nFrontierModels", str(sum(g == "frontier" for g in GROUP.values())))
mac("nTasks", str(ACC_TASKS))
complete_models = [m for m, _, _ in MODELS if all(acc.get((m, c), {}).get("n") == ACC_TASKS for c in COND)]
mac("nModelsComplete", str(len(complete_models)))
mac("accComplete", "1" if scored == expected else "0")

for m, k, _ in MODELS:
    for c in COND:
        a = acc.get((m, c))
        base = f"acc{k}{CL[c]}"
        if a and a["n"]:
            mac(base, pct(a["rate"]))
            mac(base + "Lo", pnum(a["ci"][0]))
            mac(base + "Hi", pnum(a["ci"][1]))
            mac(base + "N", str(a["n"]))
        else:
            for s in ("", "Lo", "Hi", "N"):
                mac(base + s, PENDING)

# Paired tests from the per-run rows (same tasks in both conditions).
rows_acc = load("accuracy")
by = collections.defaultdict(dict)
for r in rows_acc:
    by[(r["model"], r["condition"])][r["task"]] = r
tests = {}  # (model, other) -> (wins, losses, p, npairs)
for m, k, _ in MODELS:
    for other in ("A_raw", "B_tools"):
        cr, orr = by.get((m, "C_broker"), {}), by.get((m, other), {})
        pairs = [(cr[t]["correct"], orr[t]["correct"]) for t in cr if t in orr]
        base = f"mcn{k}C{CL[other]}"
        if pairs:
            b, c_, p = mcnemar(pairs)
            tests[(m, other)] = (b, c_, p, len(pairs))
            mac(base, fmt_p(p))
            mac(base + "P", r"$p<0.001$" if p < 0.001 else f"$p={fmt_p(p)}$")
            mac(base + "Wins", str(b))
            mac(base + "Losses", str(c_))
            mac(base + "Pairs", str(len(pairs)))
        else:
            for s in ("", "Wins", "Losses", "Pairs", "P"):
                mac(base + s, PENDING)

# Which models improve, which do not (raw p < 0.05, and Holm over all tests run).
keys = list(tests)
ps = [tests[k_][2] for k_ in keys]
rej = holm(ps) if ps else set()
for other in ("A_raw", "B_tools"):
    L = CL[other]
    up = [m for (m, o) in keys if o == other and tests[(m, o)][2] < 0.05 and tests[(m, o)][0] > tests[(m, o)][1]]
    down = [m for (m, o) in keys if o == other and tests[(m, o)][2] < 0.05 and tests[(m, o)][0] < tests[(m, o)][1]]
    ns = [m for (m, o) in keys if o == other and tests[(m, o)][2] >= 0.05]
    up_h = [m for i, (m, o) in enumerate(keys) if o == other and i in rej and tests[(m, o)][0] > tests[(m, o)][1]]
    mac(f"nSigC{L}", str(len(up)))
    mac(f"nSigWorseC{L}", str(len(down)))
    mac(f"nNoDiffC{L}", str(len(ns)))
    mac(f"nTestedC{L}", str(sum(1 for (_, o) in keys if o == other)))
    mac(f"nHolmC{L}", str(len(up_h)))
mac("nTestsHolm", str(len(ps)))

# Pooled accuracy per condition over models with complete data in all three conditions.
for c in COND:
    k_ = sum(acc[(m, c)]["correct"] for m in complete_models)
    n_ = sum(acc[(m, c)]["n"] for m in complete_models)
    mac(f"accPooled{CL[c]}", pct(k_ / n_) if n_ else PENDING)
# Range of C accuracy across models with complete data, and the lowest A and B.
if complete_models:
    cs = [acc[(m, "C_broker")]["rate"] for m in complete_models]
    mac("accCMin", pct(min(cs)))
    mac("accCMax", pct(max(cs)))
    for c in ("A_raw", "B_tools"):
        v = [acc[(m, c)]["rate"] for m in complete_models]
        mac(f"acc{CL[c]}Min", pct(min(v)))
        mac(f"acc{CL[c]}Max", pct(max(v)))

# Accuracy table body.
lines = []
for m, k, g in MODELS:
    cells = []
    for c in COND:
        a = acc.get((m, c))
        cells.append(f"{100 * a['rate']:.0f} [{100 * a['ci'][0]:.0f}, {100 * a['ci'][1]:.0f}]" + ("" if a["n"] == ACC_TASKS else f"$^{{n={a['n']}}}$")
                     if a and a["n"] else "--")
    tcell = []
    for other in ("A_raw", "B_tools"):
        t = tests.get((m, other))
        tcell.append(f"{fmt_p(t[2])} ({t[0]}/{t[1]})" if t else "--")
    lines.append(f"{model_tt(m)} & " + " & ".join(cells) + " & " + " & ".join(tcell) + r" \\")
    if m in ("inkling-2-small", "nemotron-3-ultra-550b"):
        lines.append(r"\midrule")
open(os.path.join(TAB, "tab_accuracy.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

# ------------------------------------------------------------------ main results: accuracy, context length, output, cost
# Planner input tokens per question are not in results.json; computed here with report.py's rule: the logged planner
# usage, or, for C runs recorded before it was logged, asks x measured mean input tokens per planner call.
_pu = os.path.join(OUT, "planner_usage.json")
PLANNER_CALL = json.load(open(_pu)) if os.path.exists(_pu) else None


def planner_input(r):
    if r["condition"] != "C_broker":
        return 0
    if r.get("planner"):
        return r["planner"]["prompt"]
    asks = sum(1 for t in (r.get("transcript_tools") or []) if t["name"] == "ask_wearables")
    return asks * PLANNER_CALL["mean_prompt"] if PLANNER_CALL else float("nan")


lines = []
for m, k, g in MODELS:
    first = True
    present = [c for c in COND if (m, c) in eff]
    best = max((eff[(m, c)]["accuracy"] for c in present), default=None)
    for c in COND:
        e = eff.get((m, c))
        base = f"{k}{CL[c]}"
        if not e:
            for s_ in ("tok", "cpc", "cost", "lat", "ptok", "itok", "otok"):
                mac(s_ + base, PENDING)
            continue
        pin = statistics.median(planner_input(r) for r in by.get((m, c), {}).values()) if by.get((m, c)) else 0
        mac("tok" + base, fmt_int(round(e["median_total_tokens"])))
        mac("itok" + base, fmt_int(round(e["median_agent_input_tokens"])))
        mac("ptok" + base, fmt_int(round(pin)))
        mac("otok" + base, fmt_int(round(e["median_completion_tokens"])))
        mac("lat" + base, f"{e['median_latency_s']:.1f}")
        if m in NO_COST:
            cost = cpc = "free tier"
        else:
            cost = f"{e['mean_cost_usd']:.5f}"
            cpc = f"{e['cost_per_correct_usd']:.5f}" if e.get("cost_per_correct_usd") is not None else "--"
        mac("cost" + base, cost)
        mac("cpc" + base, cpc)
        name = model_tt(m) if first else ""
        first = False
        ci = e.get("accuracy_ci") or list(wilson(round(e["accuracy"] * e["n"]), e["n"])[1:])
        a = f"{100 * e['accuracy']:.0f} [{100 * ci[0]:.0f}, {100 * ci[1]:.0f}]"
        if e["n"] != ACC_TASKS:
            a += f"$^{{n={e['n']}}}$"
        if len(present) > 1 and e["accuracy"] == best:
            a = f"\\textbf{{{a}}}"
        est = r"$^{\dagger}$" if e.get("planner_usage_estimated") else ""
        ptxt = (fmt_int(round(pin)) + est) if c == "C_broker" else "--"
        lines.append(f"{name} & {CL[c]} & {a} & {fmt_int(round(e['median_agent_input_tokens']))} & {ptxt} & "
                     f"{fmt_int(round(e['median_completion_tokens']))} & {cost} & {cpc} \\\\")
    if present and m != MODELS[-1][0]:
        lines.append(r"\midrule")
open(os.path.join(TAB, "tab_usage.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
if PLANNER_CALL:
    mac("plannerCallIn", fmt_int(round(PLANNER_CALL["mean_prompt"])))
    mac("plannerCallOut", fmt_int(round(PLANNER_CALL["mean_completion"])))
    mac("plannerCalls", str(PLANNER_CALL["calls"]))

# ------------------------------------------------------------------ data exposure (characters of health data delivered)
# Pooled medians from results.json (exposure_median_chars); per-model medians with report.py's rule: the whole
# per-device export in A (eval/paper/out/exposure_a.json), the characters every tool returned in B and C.
EXP = R.get("exposure_median_chars") or {}
for c in COND:
    mac(f"exp{CL[c]}", fmt_int(round(EXP[c])) if c in EXP else PENDING)
for o in ("A_raw", "B_tools"):
    mac(f"expRatio{CL[o]}C", f"{EXP[o] / EXP['C_broker']:.1f}" if o in EXP and EXP.get("C_broker") else PENDING)
_ea = os.path.join(OUT, "exposure_a.json")
exp_a = json.load(open(_ea)) if os.path.exists(_ea) else None
lines = []
for m, k, g in MODELS:
    if not exp_a:
        break
    med = {}
    for c in COND:
        rs = list(by.get((m, c), {}).values())
        v = [exp_a[r["task"].split("-")[0]]["chars"] if c == "A_raw" else sum(t["result_chars"] for t in (r.get("transcript_tools") or [])) for r in rs]
        med[c] = statistics.median(v) if v else None
    nb = list(by.get((m, "B_tools"), {}).values())
    notool = sum(1 for r in nb if r["tool_calls"] == 0)
    mac(f"noTool{k}B", f"{notool}" if nb else PENDING)
    mac(f"noTool{k}BN", f"{len(nb)}" if nb else PENDING)
    cells = [fmt_int(round(med[c])) if med[c] is not None else "--" for c in COND]
    rat = [f"{med[o] / med['C_broker']:.1f}" if med[o] is not None and med["C_broker"] else "--" for o in ("A_raw", "B_tools")]
    lines.append(f"{model_tt(m)} & " + " & ".join(cells) + " & " + " & ".join(rat) + f" & {notool}/{len(nb)} \\\\" if nb else f"{model_tt(m)} & " + " & ".join(cells) + " & " + " & ".join(rat) + " & -- \\\\")
if EXP:
    lines.append(r"\midrule")
    lines.append(f"All models (pooled median) & {fmt_int(round(EXP['A_raw']))} & {fmt_int(round(EXP['B_tools']))} & {fmt_int(round(EXP['C_broker']))} & "
                 f"{EXP['A_raw'] / EXP['C_broker']:.1f} & {EXP['B_tools'] / EXP['C_broker']:.1f} & \\\\")
open(os.path.join(TAB, "tab_exposure.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

# Token ratios: median total tokens of C relative to A, over models with complete data.
ratios = [eff[(m, "C_broker")]["median_total_tokens"] / eff[(m, "A_raw")]["median_total_tokens"] for m in complete_models if (m, "A_raw") in eff and (m, "C_broker") in eff]
mac("tokRatioCAMin", f"{min(ratios):.2f}" if ratios else PENDING)
mac("tokRatioCAMax", f"{max(ratios):.2f}" if ratios else PENDING)
cr_ = [eff[(m, "C_broker")]["median_agent_input_tokens"] / eff[(m, "A_raw")]["median_agent_input_tokens"] for m in complete_models]
mac("ctxRatioCAMin", f"{min(cr_):.2f}" if cr_ else PENDING)
mac("ctxRatioCAMax", f"{max(cr_):.2f}" if cr_ else PENDING)
fr = [m for m in complete_models if GROUP[m] == "frontier"]
cheaper = [m for m in fr if eff[(m, "C_broker")]["cost_per_correct_usd"] < min(eff[(m, "A_raw")]["cost_per_correct_usd"], eff[(m, "B_tools")]["cost_per_correct_usd"])]
mac("nFrontierCheaperC", str(len(cheaper)))
mac("nFrontierComplete", str(len(fr)))

# ------------------------------------------------------------------ traps and questions (pooled)
# Pooled over the models with complete runs in all three conditions (equal n per cell).
def _pool(field):
    out = collections.defaultdict(lambda: {"correct": 0, "n": 0})
    for m in complete_models:
        for c in COND:
            for r in by.get((m, c), {}).values():
                out[(r[field], c)]["n"] += 1
                out[(r[field], c)]["correct"] += int(bool(r["correct"]))
    return out


bt = _pool("trap")
lines = []
for t, k in TRAPS:
    cells = []
    for c in COND:
        x = bt.get((t, c))
        v = pct(x["correct"] / x["n"]) if x and x["n"] else PENDING
        mac(f"trap{k}{CL[c]}", v)
        cells.append(f"{100 * x['correct'] / x['n']:.0f}" if x and x["n"] else "--")
    lines.append(f"{TRAP_LABEL[t]} & " + " & ".join(cells) + r" \\")
trap_c = [bt[(t, "C_broker")]["correct"] / bt[(t, "C_broker")]["n"] for t, _ in TRAPS if bt.get((t, "C_broker"), {}).get("n")]
mac("trapCMin", pct(min(trap_c)) if trap_c else PENDING)
mac("trapCMax", pct(max(trap_c)) if trap_c else PENDING)
open(os.path.join(TAB, "tab_traps.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

bq = _pool("tag")
lines = []
for q, k, label in QUESTIONS:
    cells = []
    for c in COND:
        x = bq.get((q, c))
        mac(f"q{k}{CL[c]}", pct(x["correct"] / x["n"]) if x and x["n"] else PENDING)
        cells.append(f"{100 * x['correct'] / x['n']:.0f}" if x and x["n"] else "--")
    lines.append(f"{label} & " + " & ".join(cells) + r" \\")
open(os.path.join(TAB, "tab_questions.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

# ------------------------------------------------------------------ honest refusal
def unknown_only(r):
    return r["accept"].get("labels") == ["unknown"] and r["accept"].get("number") is None

lines = []
pool = collections.defaultdict(lambda: [0, 0])
for m, k, g in MODELS:
    cells = []
    for c in COND:
        rs = [r for r in by.get((m, c), {}).values() if unknown_only(r)]
        kk = sum(r["answer"] == "unknown" for r in rs)
        mac(f"ref{k}{CL[c]}", f"{kk}/{len(rs)}" if rs else PENDING)
        cells.append(f"{kk}/{len(rs)}" if rs else "--")
        if m in complete_models:
            pool[c][0] += kk
            pool[c][1] += len(rs)
    if any(c != "--" for c in cells):
        lines.append(f"{model_tt(m)} & " + " & ".join(cells) + r" \\")
for c in COND:
    k_, n_ = pool[c]
    mac(f"refPooled{CL[c]}", f"{k_}/{n_}" if n_ else PENDING)
    mac(f"refPooledPct{CL[c]}", pct(k_ / n_) if n_ else PENDING)
nunk = len({r["task"] for r in rows_acc if unknown_only(r)})
mac("nUnknownTasks", str(nunk))
open(os.path.join(TAB, "tab_refusal.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

# ------------------------------------------------------------------ where C goes wrong (from the per-run packet log)
crs = [r for r in rows_acc if r["condition"] == "C_broker"]
cbad = [r for r in crs if not r["correct"]]


def c_err_kind(r):
    lv = r.get("packet_levels") or []
    if not lv:
        return "NoCall"
    if all(x in ("unsupported", "denied") for x in lv):
        return "Refused"
    return "Released"


kinds = collections.Counter(c_err_kind(r) for r in cbad)
mac("cRuns", fmt_int(len(crs)))
mac("cErr", str(len(cbad)))
for k_ in ("NoCall", "Refused", "Released"):
    mac(f"cErr{k_}", str(kinds.get(k_, 0)))
asks = sum(len(r.get("packet_levels") or []) for r in crs)
reasons = collections.Counter(x[0] for r in crs for x in (r.get("packet_reasons") or []) if x)
mac("cAsks", fmt_int(asks))
mac("cAsksReleased", fmt_int(sum(1 for r in crs for x in (r.get("packet_levels") or []) if isinstance(x, int))))
mac("cAsksOutside", str(reasons.get("outside_catalogue", 0)))
mac("cAsksPlannerFailed", str(reasons.get("planner_failed", 0)))
mac("cAsksSensitive", str(reasons.get("sensitive_category_not_in_catalogue", 0)))
# Which word tripped the sensitive-category pre-check (planner.ts SENSITIVE) on the agent's rephrased question.
SENS_RE = re.compile(r"\b(glucose|blood sugar|periods?|menstrua\w*|cycle tracking|pregnan\w*|ecg|ekg|afib|atrial\w*|arrhythm\w*|apnea|apnoea)\b")
period_hits = 0
for r in crs:
    for t, rs_ in zip(r.get("transcript_tools") or [], r.get("packet_reasons") or []):
        if rs_ and rs_[0] == "sensitive_category_not_in_catalogue":
            mt = SENS_RE.search(t["args"].lower())
            period_hits += bool(mt and mt.group(0).startswith("period"))
mac("cAsksSensitivePeriod", str(period_hits))
mac("cOneAsk", pct(sum(len(r.get("packet_levels") or []) == 1 for r in crs) / len(crs)) if crs else PENDING)

# ------------------------------------------------------------------ privacy
# Three scorings, reported side by side: the original detector (privacy.ts scoreLeak, the stored "leaked" field),
# hand labels on a stratified sample of 160 rows (eval/paper/out/leak_audit_labels.jsonl, design-weighted), and the
# corrected detector (leak_audit.py score_fixed), written with that sample in view and checked by hand on the 38
# rows outside the sample where its verdict differs. Cells print with their n; the section is marked provisional
# until every planned run is in.
import importlib.util
_spec = importlib.util.spec_from_file_location("leak_audit", os.path.join(HERE, "leak_audit.py"))
LA = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(LA)

rows_pv = load("privacy")
for r in rows_pv:
    r["leaked_fixed"] = bool(LA.score_fixed(r["scenario"], r["person"], r.get("final")))
pv = collections.defaultdict(list)
for r in rows_pv:
    pv[(r["model"], r["condition"], r["scenario"])].append(r)
priv_models = [m for m, _, _ in MODELS]
priv_expected = sum(PRIV_PEOPLE[GROUP[m]] * len(SCEN) * len(COND) for m in priv_models)
all_done = len(rows_pv) >= priv_expected

labels = [json.loads(l) for l in open(os.path.join(OUT, "leak_audit_labels.jsonl")) if l.strip()]


def conf(rows, pred):
    tp = sum(1 for r in rows if pred(r) and r["label"] == "leak")
    fp = sum(1 for r in rows if pred(r) and r["label"] != "leak")
    fn = sum(1 for r in rows if not pred(r) and r["label"] == "leak")
    tn = len(rows) - tp - fp - fn
    n = len(rows)
    po = (tp + tn) / n
    pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n)
    kappa = (po - pe) / (1 - pe) if pe < 1 else float("nan")
    prec = tp / (tp + fp) if tp + fp else None
    rec = tp / (tp + fn) if tp + fn else None
    return tp, fp, fn, tn, prec, rec, kappa


def f2(x):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.2f}"


def esc(s_):
    return s_.replace("_", "\\_")


decided = [r for r in labels if r["label"] in ("leak", "no_leak")]
mac("auditN", str(len(labels)))
mac("auditDecided", str(len(decided)))
mac("auditAmbiguous", str(len(labels) - len(decided)))
tp, fp, fn, tn, prec, rec, kap = conf(decided, lambda r: r["detector_leaked"])
mac("auditPrec", f2(prec)); mac("auditRec", f2(rec)); mac("auditKappa", f2(kap)); mac("auditFP", str(fp)); mac("auditFN", str(fn))
tpF, fpF, fnF, tnF, precF, recF, kapF = conf(decided, lambda r: LA.score_fixed(r["scenario"], r["person"], r["final"]))
mac("auditFixedPrec", f2(precF)); mac("auditFixedRec", f2(recF)); mac("auditFixedKappa", f2(kapF))
lines = []
for s_, sk in SCEN:
    rs = [r for r in decided if r["scenario"] == s_]
    t = conf(rs, lambda r: r["detector_leaked"])
    lines.append(f"\\code{{{esc(s_)}}} & {len(rs)} & {t[0]} & {t[1]} & {t[2]} & {t[3]} & {f2(t[4])} & {f2(t[5])} & {f2(t[6])} \\\\")
    mac(f"audit{sk}Kappa", f2(t[6]))
lines.append(r"\midrule")
lines.append(f"All scenarios & {len(decided)} & {tp} & {fp} & {fn} & {tn} & {f2(prec)} & {f2(rec)} & {f2(kap)} \\\\")
open(os.path.join(TAB, "tab_leak_audit.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
# Condition-C positives of the original detector, and how many the hand labels confirm.
cpos = [r for r in rows_pv if r["condition"] == "C_broker" and r["leaked"]]
mac("auditCPositives", str(len(cpos)))
lab_by_key = {r["key"]: r for r in labels}
cpos_lab = [lab_by_key.get(f'{r["condition"]}|{r["model"]}|{r["task"]}|{r["run"]}') for r in cpos]
mac("auditCPosAudited", str(sum(1 for x in cpos_lab if x)))
mac("auditCPosReal", str(sum(1 for x in cpos_lab if x and x["label"] == "leak")))


def human_rate(rows):
    w = sum(r["weight"] for r in rows)
    return sum(r["weight"] for r in rows if r["label"] == "leak") / w if w else None


def p0(x):
    return "--" if x is None else f"{100 * x:.0f}"


lines = []
for s_, sk in SCEN:
    cells = []
    for c in COND:
        rs = [r for r in rows_pv if r["scenario"] == s_ and r["condition"] == c]
        n_ = len(rs)
        k0 = sum(r["leaked"] for r in rs)
        k1 = sum(r["leaked_fixed"] for r in rs)
        hr = human_rate([r for r in decided if r["scenario"] == s_ and r["condition"] == c])
        if n_:
            mac(f"leak{sk}{CL[c]}", pct(k1 / n_)); mac(f"leak{sk}{CL[c]}Frac", f"{k1}/{n_}")
            mac(f"leakOrig{sk}{CL[c]}", pct(k0 / n_)); mac(f"leakHuman{sk}{CL[c]}", pct(hr) if hr is not None else PENDING)
            cells += [f"{100 * k1 / n_:.0f} ({k1}/{n_})"]
        else:
            for pre in ("leak", "leakOrig", "leakHuman"):
                mac(f"{pre}{sk}{CL[c]}", PENDING)
            mac(f"leak{sk}{CL[c]}Frac", PENDING)
            cells += [PENDING]
    lines.append(f"\\code{{{esc(s_)}}} & " + " & ".join(cells) + r" \\")
lines.append(r"\midrule")
cells = []
for c in COND:
    rs = [r for r in rows_pv if r["condition"] == c]
    hr = human_rate([r for r in decided if r["condition"] == c])
    k1, k0 = sum(r["leaked_fixed"] for r in rs), sum(r["leaked"] for r in rs)
    mac(f"leakPooled{CL[c]}", pct(k1 / len(rs), 1) if rs else PENDING)
    mac(f"leakPooledOrig{CL[c]}", pct(k0 / len(rs), 1) if rs else PENDING)
    mac(f"leakPooledHuman{CL[c]}", pct(hr, 1) if hr is not None else PENDING)
    mac(f"leakPooledN{CL[c]}", str(len(rs)))
    cells += [f"{100 * k1 / len(rs):.1f} ({k1}/{len(rs)})" if rs else PENDING]
lines.append("All scenarios & " + " & ".join(cells) + r" \\")
open(os.path.join(TAB, "tab_privacy.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

lines = []
for m, k, g in MODELS:
    cells = []
    for c in COND:
        rs = [r for s_, _ in SCEN for r in pv.get((m, c, s_), [])]
        v = f"{sum(r['leaked_fixed'] for r in rs)}/{len(rs)}" if rs else "--"
        mac(f"leak{k}{CL[c]}", v if rs else PENDING)
        cells.append(v)
    lines.append(f"{model_tt(m)} & " + " & ".join(cells) + r" \\")
open(os.path.join(TAB, "tab_privacy_models.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
for c in COND:
    rs = [r for r in rows_pv if r["condition"] == c]
    mac(f"leakWeight{CL[c]}", f"{sum(r['weight_value'] for r in rs)}/{len(rs)}" if rs else PENDING)
    mac(f"leakRhr{CL[c]}", f"{sum(r['rhr_values'] > 0 for r in rs)}/{len(rs)}" if rs else PENDING)
mac("privCDenied", str(sum(1 for r in rows_pv if r["condition"] == "C_broker" for x in (r.get("packet_levels") or []) if x == "denied")))
mac("privCRunsWithDenial", str(sum(1 for r in rows_pv if r["condition"] == "C_broker" and "denied" in (r.get("packet_levels") or []))))
mac("privPeopleOpen", str(PRIV_PEOPLE["open"]))
mac("privPeopleOther", str(PRIV_PEOPLE["frontier"]))
mac("privRunsScored", fmt_int(len(rows_pv)))
mac("privRunsExpected", fmt_int(priv_expected))

# ------------------------------------------------------------------ repeatability (open models)
rows_rp = load("repeat")
rp = collections.defaultdict(lambda: collections.defaultdict(list))
for r in rows_rp:
    rp[(r["model"], r["condition"])][r["task"]].append(r)
rep_expected = sum(1 for _, _, g in MODELS if g == "open") * len(COND) * REPEAT_TASKS * REPEAT_RUNS
rep_done = len(rows_rp) >= rep_expected
lines = []
pool_rep = collections.defaultdict(lambda: [0, 0, 0])
for m, k, g in MODELS:
    if g != "open":
        continue
    cells = []
    for c in COND:
        tasks = {t: v for t, v in rp.get((m, c), {}).items() if len(v) >= 3}
        if tasks:
            agree = sum(len({json.dumps(r["answer"]) for r in v}) == 1 for v in tasks.values())
            cc = sum(all(r["correct"] for r in v) for v in tasks.values())
            mac(f"rep{k}{CL[c]}", f"{agree}/{len(tasks)}")
            mac(f"repCorrect{k}{CL[c]}", f"{cc}/{len(tasks)}")
            cells += [f"{agree}/{len(tasks)}", f"{cc}/{len(tasks)}"]
            pool_rep[c][0] += agree
            pool_rep[c][1] += cc
            pool_rep[c][2] += len(tasks)
        else:
            mac(f"rep{k}{CL[c]}", PENDING)
            mac(f"repCorrect{k}{CL[c]}", PENDING)
            cells += ["--", "--"]
    lines.append(f"{model_tt(m)} & " + " & ".join(cells) + r" \\")
open(os.path.join(TAB, "tab_repeat.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
for c in COND:
    a_, cc_, n_ = pool_rep[c]
    mac(f"repPooled{CL[c]}", pct(a_ / n_) if n_ else PENDING)
    mac(f"repPooledCorrect{CL[c]}", pct(cc_ / n_) if n_ else PENDING)
mac("repTasks", str(REPEAT_TASKS))
mac("repRuns", str(REPEAT_RUNS))
mac("repRunsScored", fmt_int(len(rows_rp)))
mac("repRunsExpected", fmt_int(rep_expected))

# ------------------------------------------------------------------ planner on PHIA (same rules as summarize_planner.py)
mp_doc = json.load(open(os.path.join(ROOT, "eval", "phia", "mapping.json")))
mp = {e["id"]: e for e in mp_doc["entries"]}
mac("phiaTotal", fmt_int(len(mp)))
mac("phiaMapped", fmt_int(sum(e["status"] == "mapped" for e in mp.values())))
mac("phiaUnsupported", fmt_int(sum(e["status"] == "unsupported" for e in mp.values())))
mac("phiaDirect", fmt_int(sum(e["status"] == "mapped" and (e.get("extract") or {}).get("from") == "l2.value" for e in mp.values())))
mac("phiaSessions", fmt_int(sum(e["status"] == "mapped" and (e.get("extract") or {}).get("from") == "sessions" for e in mp.values())))
pp = os.path.join(RES, "planner-phia.jsonl")
prow = load_planner_rows(pp) if os.path.exists(pp) else []
byp = collections.defaultdict(list)
for r in prow:
    e = mp[r["id"]]
    r["direct"] = e["status"] == "mapped" and (e.get("extract") or {}).get("from") == "l2.value"
    r["map_window"] = e.get("window_basis") or r["map_window"]
    byp[r["planner"]].append(r)
lines = []
for p, k in PLANNERS:
    rs = byp.get(p, [])
    if not rs:
        for s in ("N", "NUnsup", "NAns", "RefUnsup", "Guess", "OverRef", "OpMetric", "Window", "Lat", "LatNinety"):
            mac(f"pl{k}{s}", PENDING)
        continue
    u = [r for r in rs if r["mapping"] == "unsupported"]
    a = [r for r in rs if r["mapping"] == "mapped" and r["direct"]]
    ref = sum(r["status"] == "unsupported" for r in u)
    over = sum(r["status"] == "unsupported" for r in a)
    same = sum(r["same_op_metric"] for r in a)
    win = sum(r["same_op_metric"] and r["window"] == r["map_window"] for r in a)
    ms = sorted(r["ms"] for r in rs)
    vals = {"N": str(len(rs)), "NUnsup": str(len(u)), "NAns": str(len(a)), "RefUnsup": pct(ref / len(u), 1), "Guess": str(len(u) - ref),
            "OverRef": pct(over / len(a), 1), "OpMetric": pct(same / len(a), 1), "Window": pct(win / len(a), 1),
            "Lat": f"{statistics.median(ms) / 1000:.1f}", "LatNinety": f"{ms[int(.9 * len(ms)) - 1] / 1000:.1f}"}
    for s, v in vals.items():
        mac(f"pl{k}{s}", v)
    lines.append(f"{model_tt(p)} & {len(rs)} & {len(u)} & {vals['RefUnsup']} & {vals['Guess']} & {len(a)} & {vals['OverRef']} & {vals['OpMetric']} & {vals['Window']} & {vals['Lat']} \\\\")
open(os.path.join(TAB, "tab_planner.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
mac("plSample", str(len(byp.get(PLANNERS[0][0], []))) if byp else PENDING)
mac("phiaCommit", mp_doc.get("phia_commit", "")[:7] or PENDING)

# ------------------------------------------------------------------ compute engine on PHIA
OPS = [("aggregate", "Aggregate"), ("list_sessions", "Sessions"), ("threshold_check", "Threshold")]
pr_path = os.path.join(ROOT, "eval", "data", "results", "phia-results.json")
tables = {}
if os.path.exists(pr_path):
    PR = json.load(open(pr_path))
    for name, key in (("table", "Worded"), ("reference_table", "Ref")):
        tables[key] = {r["operation"]: (r["mapped"], r["match"]) for r in PR[name]["rows"]}
    rp_planner = PR.get("planner", {})
else:  # the tables in NOTES.md, same numbers as phia-results.json
    notes = open(os.path.join(ROOT, "eval", "phia", "NOTES.md")).read()
    blocks = re.findall(r"\| operation \| mapped \| match.*?\n((?:\|.*\n)+)", notes)
    for key, block in zip(("Worded", "Ref"), blocks):
        t = {}
        for line in block.splitlines():
            cells = [c.strip().strip("*").replace(",", "") for c in line.strip("|").split("|")]
            if cells[0] in ("aggregate", "list_sessions", "threshold_check"):
                t[cells[0]] = (int(cells[1]), int(cells[2]))
        tables[key] = t
    rp_planner = {}
lines = []
for key in ("Worded", "Ref"):
    t = tables.get(key, {})
    tot_n = sum(v[0] for v in t.values())
    tot_k = sum(v[1] for v in t.values())
    mac(f"phiaAcc{key}", pct(tot_k / tot_n, 1) if tot_n else PENDING)
    mac(f"phiaMatch{key}", fmt_int(tot_k) if tot_n else PENDING)
    for op, ok in OPS:
        if op in t:
            mac(f"phia{ok}{key}", pct(t[op][1] / t[op][0], 1))
            mac(f"phia{ok}N", fmt_int(t[op][0]))
        else:
            mac(f"phia{ok}{key}", PENDING)
for op, ok in OPS:
    w, rf = tables.get("Worded", {}).get(op), tables.get("Ref", {}).get(op)
    if w and rf:
        lines.append(f"\\code{{{op.replace('_', '\\_')}}} & {fmt_int(w[0])} & {fmt_int(w[1])} & {100 * w[1] / w[0]:.1f} & {fmt_int(rf[1])} & {100 * rf[1] / rf[0]:.1f} \\\\")
w, rf = tables.get("Worded", {}), tables.get("Ref", {})
if w and rf:
    nw, kw = sum(v[0] for v in w.values()), sum(v[1] for v in w.values())
    kr = sum(v[1] for v in rf.values())
    lines.append(r"\midrule")
    lines.append(f"All mapped & {fmt_int(nw)} & {fmt_int(kw)} & {100 * kw / nw:.1f} & {fmt_int(kr)} & {100 * kr / nw:.1f} \\\\")
open(os.path.join(TAB, "tab_phia.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
if rp_planner:
    mac("rulesGuessed", fmt_int(rp_planner["guessed"]))
    mac("rulesRefused", fmt_int(rp_planner["refused"]))
else:
    mac("rulesGuessed", PENDING)
    mac("rulesRefused", PENDING)

# ------------------------------------------------------------------ run handling (all rows, in file order)
hist = collections.defaultdict(list)
for path in sorted(glob.glob(os.path.join(RES, "accuracy-*.jsonl"))):
    for line in open(path):
        if line.strip():
            r = json.loads(line)
            hist[(r["condition"], r["model"], r["task"], r["run"])].append(r)
err_rows = collections.Counter()
inval = collections.Counter()
for rs in hist.values():
    for r in rs:
        e = r.get("error")
        if not e:
            continue
        if e.startswith("invalidated"):
            inval["text" if "tool call written as text" in e else "c_unsupported" if "unsupported packet" in e else "other"] += 1
        else:
            err_rows[r["condition"]] += 1
for c in COND:
    mac(f"errRows{CL[c]}", fmt_int(err_rows.get(c, 0)))
mac("invalText", str(inval.get("text", 0)))
mac("invalCUnsupported", str(inval.get("c_unsupported", 0)))
mac("accMissing", str(sum(1 for rs in hist.values() if rs[-1].get("error"))))
text_recovered = collections.Counter(r["condition"] for r in rows_acc if (r.get("text_tool_calls") or 0) > 0)
for c in COND:
    mac(f"textRecovered{CL[c]}", str(text_recovered.get(c, 0)))
noans = collections.Counter(r["condition"] for r in rows_acc if "ANSWER" not in (r.get("final") or "").upper())
for c in COND:
    mac(f"noAnswer{CL[c]}", str(noans.get(c, 0)))

# ------------------------------------------------------------------ paired question-level test: the threshold question
def pooled_pairs(tag, other, models):
    pairs = []
    for m in models:
        cr, orr = by.get((m, "C_broker"), {}), by.get((m, other), {})
        pairs += [(cr[t]["correct"], orr[t]["correct"]) for t in cr if t in orr and cr[t]["tag"] == tag]
    return pairs


for q, k, _ in QUESTIONS:
    for other in ("A_raw", "B_tools"):
        b_, c_, p_ = mcnemar(pooled_pairs(q, other, complete_models))
        mac(f"qp{k}C{CL[other]}Wins", str(b_))
        mac(f"qp{k}C{CL[other]}Losses", str(c_))
        mac(f"qp{k}C{CL[other]}P", r"$p<0.001$" if p_ < 0.001 else f"$p={fmt_p(p_)}$")

# ------------------------------------------------------------------ over-refusal: "unknown" where a value was answerable
for c in COND:
    rs = [r for m in complete_models for r in by.get((m, c), {}).values() if "unknown" not in (r["accept"].get("labels") or [])]
    k_ = sum(r["answer"] == "unknown" for r in rs)
    mac(f"overRef{CL[c]}", f"{k_}/{len(rs)}")
    mac(f"overRefPct{CL[c]}", pct(k_ / len(rs), 1) if rs else PENDING)

# ------------------------------------------------------------------ C decomposition: released vs refused, perfect-planner bound
crs_c = [r for m in complete_models for r in by.get((m, "C_broker"), {}).values()]
rel = [r for r in crs_c if any(isinstance(x, int) for x in (r.get("packet_levels") or []))]
ref = [r for r in crs_c if (r.get("packet_levels") or []) and not any(isinstance(x, int) for x in r["packet_levels"])]
mac("cReleasedN", fmt_int(len(rel)))
mac("cReleasedAcc", pct(sum(r["correct"] for r in rel) / len(rel), 1) if rel else PENDING)
mac("cRefusedN", str(len(ref)))
mac("cRefusedAcc", pct(sum(r["correct"] for r in ref) / len(ref), 1) if ref else PENDING)
cur = sum(r["correct"] for r in crs_c)
bound = cur + sum(1 for r in ref if not r["correct"])
mac("cAccNow", pct(cur / len(crs_c), 1) if crs_c else PENDING)
mac("cAccPerfectPlanner", pct(bound / len(crs_c), 1) if crs_c else PENDING)
su = [r for r in crs if r["tag"] == "sleep_under_6h_7d" and not r["correct"]]
mac("suErr", str(len(su)))
mac("suErrRefused", str(sum(1 for r in su if c_err_kind(r) == "Refused")))
mac("suErrReleased", str(sum(1 for r in su if c_err_kind(r) == "Released")))
per_tag = collections.Counter()
for r in crs:
    for t, rs_ in zip(r.get("transcript_tools") or [], r.get("packet_reasons") or []):
        if rs_ and rs_[0] == "sensitive_category_not_in_catalogue":
            mt = SENS_RE.search(t["args"].lower())
            if mt and mt.group(0).startswith("period"):
                per_tag[r["tag"]] += 1
mac("periodOnWeek", str(per_tag.get("steps_week_vs_prev", 0)))
mac("periodElsewhere", str(sum(v for k_, v in per_tag.items() if k_ != "steps_week_vs_prev")))
# The deficit on the threshold question: refusals there, and how many were planner validation failures.
pf = collections.Counter()
for r in crs:
    for x in (r.get("packet_reasons") or []):
        if x and x[0] == "planner_failed":
            pf[r["tag"]] += 1
mac("plannerFailedSleepUnder", str(pf.get("sleep_under_6h_7d", 0)))
mac("plannerFailedAll", str(sum(pf.values())))

# ------------------------------------------------------------------ person-clustered bootstrap of accuracy differences
import random
RNG = random.Random(20261125)
B_REPS = 2000


def person_of(task):
    return task.split("-")[0]


def boot_diff(models, other):
    """Accuracy difference C - other on paired tasks, resampling people (clusters) with replacement."""
    cells = collections.defaultdict(list)  # person -> list of (c, o)
    for m in models:
        cr, orr = by.get((m, "C_broker"), {}), by.get((m, other), {})
        for t in cr:
            if t in orr:
                cells[person_of(t)].append((cr[t]["correct"], orr[t]["correct"]))
    people_ = sorted(cells)
    if not people_:
        return None
    allp = [x for p_ in people_ for x in cells[p_]]
    est = sum(a - b for a, b in allp) / len(allp)
    reps = []
    for _ in range(B_REPS):
        pick = [x for p_ in (RNG.choice(people_) for _ in people_) for x in cells[p_]]
        reps.append(sum(a - b for a, b in pick) / len(pick))
    reps.sort()
    return est, reps[int(0.025 * B_REPS)], reps[int(0.975 * B_REPS) - 1]


def pp(x):
    return f"{100 * x:+.0f}".replace("+", "$+$").replace("-", "$-$")


lines = []
for m, k, g in MODELS:
    cells_ = []
    for other in ("A_raw", "B_tools"):
        bd = boot_diff([m], other) if (m, "C_broker") in acc and (m, other) in acc else None
        if bd:
            mac(f"boot{k}C{CL[other]}", f"{pp(bd[0])} [{pp(bd[1])}, {pp(bd[2])}]")
            cells_.append(f"{pp(bd[0])} [{pp(bd[1])}, {pp(bd[2])}]")
        else:
            mac(f"boot{k}C{CL[other]}", PENDING)
            cells_.append("--")
    lines.append(f"{model_tt(m)} & " + " & ".join(cells_) + r" \\")
for other in ("A_raw", "B_tools"):
    bd = boot_diff(complete_models, other)
    mac(f"bootPooledC{CL[other]}", f"{pp(bd[0])} [{pp(bd[1])}, {pp(bd[2])}]" if bd else PENDING)
lines.append(r"\midrule")
lines.append(f"Pooled, {len(complete_models)} complete models & {M['bootPooledCA']} & {M['bootPooledCB']} \\\\")
open(os.path.join(TAB, "tab_bootstrap.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
mac("bootReps", fmt_int(B_REPS))

# ------------------------------------------------------------------ planner selection: every candidate, both samples
PLANNER_FILES = [  # (file, sample, prompt version)
    # Planner selection was made during development (prompt v1), before the study was frozen; those files live in the
    # development results directory and are labelled "dev v1". The final rows are the frozen study's re-measurement.
    ("planner-phia-v1-llama-gptoss-mistral.jsonl", "selection", "dev v1"),
    ("planner-phia-v1-mixed-gemma-inkling.jsonl", "selection", "dev v1"),
    ("planner-phia.jsonl", "selection", "final"),
    ("planner-phia-heldout.jsonl", "held-out", "final"),
]
PLANNER_FILES += [(os.path.basename(f), "held-out" if "heldout" in f else "selection", "v2") for f in sorted(glob.glob(os.path.join(RES, "planner-phia*v2*.jsonl")))]


def planner_metrics(rs):
    for r in rs:
        e = mp[r["id"]]
        r["direct"] = e["status"] == "mapped" and (e.get("extract") or {}).get("from") == "l2.value"
        r["map_window"] = e.get("window_basis") or r["map_window"]
    u = [r for r in rs if r["mapping"] == "unsupported"]
    a = [r for r in rs if r["mapping"] == "mapped" and r["direct"]]
    ms = sorted(r["ms"] for r in rs)
    return u, a, ms


lines = []
sel = {}
for fname, sample, ver in PLANNER_FILES:
    pth = os.path.join(RES, fname)
    if ver == "dev v1":
        pth = os.path.join(HERE, "results", fname)
    if not os.path.exists(pth):
        continue
    byp_ = collections.defaultdict(list)
    for r in load_planner_rows(pth):
        byp_[r["planner"]].append(r)
    for p_, rs in sorted(byp_.items()):
        u, a, ms = planner_metrics(rs)
        ref_ = sum(r["status"] == "unsupported" for r in u)
        over = sum(r["status"] == "unsupported" for r in a)
        same = sum(r["same_op_metric"] for r in a)
        win = sum(r["same_op_metric"] and r["window"] == r["map_window"] for r in a)
        _, lo, hi = wilson(same, len(a))
        sel[(p_, sample, ver)] = {r["id"]: r for r in a}
        lines.append(f"{model_tt(p_)} & {ver} & {sample} & {len(rs)} & {pct(ref_ / max(1, len(u)), 1)} & {len(u) - ref_} & "
                     f"{pct(over / max(1, len(a)), 1)} & {100 * same / max(1, len(a)):.0f} [{100 * lo:.0f}, {100 * hi:.0f}] & "
                     f"{pct(win / max(1, len(a)), 1)} & {(f'{statistics.median(ms) / 1000:.1f}' if ver == 'dev v1' else '--')} \\\\")
        key_ = {"llama-3.3-70b": "LlamaThree", "gpt-oss-120b": "OssLarge"}.get(p_)
        if key_ and sample == "held-out" and ver == "final":
            mac(f"plHeld{key_}RefUnsup", pct(ref_ / max(1, len(u)), 1)); mac(f"plHeld{key_}OverRef", pct(over / max(1, len(a)), 1))
            mac(f"plHeld{key_}OpMetric", pct(same / max(1, len(a)), 1)); mac(f"plHeld{key_}NAns", str(len(a)))
            mac(f"plHeld{key_}Guess", str(len(u) - ref_)); mac(f"plHeld{key_}NUnsup", str(len(u)))
open(os.path.join(TAB, "tab_planner_all.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
mac("plCandidates", str(len({p_ for (p_, s_, v_) in sel if s_ == "selection"})))
for nm in ("plHeldLlamaThreeRefUnsup", "plHeldLlamaThreeOverRef", "plHeldLlamaThreeOpMetric", "plHeldLlamaThreeNAns", "plHeldLlamaThreeGuess", "plHeldLlamaThreeNUnsup"):
    M.setdefault(nm, PENDING)
for nm in ("v2", ):
    pass
v2held = [k_ for k_ in sel if k_[2] == "v2" and k_[1] == "held-out"]
mac("plVtwoAvailable", "1" if v2held else "0")
# paired op+metric test, final prompt, selection sample: llama-3.3-70b vs gpt-oss-120b
la, go = sel.get(("llama-3.3-70b", "selection", "final"), {}), sel.get(("gpt-oss-120b", "selection", "final"), {})
pairs = [(la[i]["same_op_metric"], go[i]["same_op_metric"]) for i in la if i in go]
if pairs:
    b_, c_, p_ = mcnemar(pairs)
    mac("plPairWins", str(b_)); mac("plPairLosses", str(c_)); mac("plPairP", f"$p={fmt_p(p_)}$" if p_ >= 0.001 else r"$p<0.001$")
else:
    for nm in ("plPairWins", "plPairLosses", "plPairP"):
        mac(nm, PENDING)

# ------------------------------------------------------------------ second iteration of C (planner v2)
v2 = load("accuracy_v2")
lines = []
v2pool = [0, 0, 0]
for m, k, g in MODELS:
    rs2 = {r["task"]: r for r in v2 if r["model"] == m and r["condition"] == "C_broker"}
    c1 = by.get((m, "C_broker"), {})
    pairs = [(rs2[t]["correct"], c1[t]["correct"]) for t in rs2 if t in c1]
    if not pairs:
        continue
    b_, c_, p_ = mcnemar(pairs)
    k1 = sum(c1[t]["correct"] for t in rs2 if t in c1)
    k2 = sum(rs2[t]["correct"] for t in rs2 if t in c1)
    v2pool[0] += k1; v2pool[1] += k2; v2pool[2] += len(pairs)
    lines.append(f"{model_tt(m)} & {len(pairs)} & {100 * k1 / len(pairs):.0f} & {100 * k2 / len(pairs):.0f} & {b_} & {c_} & {fmt_p(p_)} \\\\")
if not lines:
    lines = [r"\multicolumn{7}{c}{\pending{}} \\"]
open(os.path.join(TAB, "tab_v2.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
mac("vtwoRuns", fmt_int(len(v2)) if v2 else PENDING)
mac("vtwoAccOne", pct(v2pool[0] / v2pool[2]) if v2pool[2] else PENDING)
mac("vtwoAccTwo", pct(v2pool[1] / v2pool[2]) if v2pool[2] else PENDING)

# ------------------------------------------------------------------ new benchmark suites (PHIA end to end; real data)
for suite, key_ in (("phia", "Phia"), ("real", "Real")):
    rows_s = load(suite)
    bys = collections.defaultdict(list)
    for r in rows_s:
        bys[(r["model"], r["condition"])].append(r)
    lines = []
    for m, k, g in MODELS:
        if not any((m, c) in bys for c in COND):
            continue
        cells_ = []
        for c in COND:
            rs = bys.get((m, c), [])
            if rs:
                kk = sum(bool(r.get("correct")) for r in rs)
                _, lo, hi = wilson(kk, len(rs))
                cells_.append(f"{100 * kk / len(rs):.0f} [{100 * lo:.0f}, {100 * hi:.0f}]$^{{n={len(rs)}}}$")
            else:
                cells_.append("--")
        lines.append(f"{model_tt(m)} & " + " & ".join(cells_) + r" \\")
    if not lines:
        lines = [r"\multicolumn{4}{c}{\pending{}} \\"]
    open(os.path.join(TAB, f"tab_bench_{suite}.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")
    mac(f"bench{key_}Runs", fmt_int(len(rows_s)) if rows_s else PENDING)
    if suite == "phia":
        # PHIA split by stratum: answerable items scored as worded (primary) and against PHIA's labels, and unsupported
        # items scored as refusal (answering unknown). An answer counts only with an ANSWER: line (strict rule).
        def ok_(r, field):
            return r.get("answer") is not None and bool(r.get(field))
        SCORES = [("answerable", "correct_as_worded", "Worded"), ("answerable", "correct_phia", "Label"), ("unsupported", "correct", "Unsup")]
        lines = []
        pool = collections.defaultdict(lambda: [0, 0])
        for m, k, g in MODELS:
            cells_ = []
            for stratum, field, sk in SCORES:
                for c in COND:
                    rs = [r for r in bys.get((m, c), []) if (r.get("stratum") == "unsupported") == (stratum == "unsupported")]
                    kk = sum(ok_(r, field) for r in rs)
                    pool[(sk, c)][0] += kk; pool[(sk, c)][1] += len(rs)
                    cells_.append(f"{100 * kk / len(rs):.0f}" if rs else "--")
                    if rs:
                        mac(f"phia{sk}{k}{CL[c]}", pct(kk / len(rs)))
            lines.append(f"{model_tt(m)} & " + " & ".join(cells_) + r" \\")
        lines.append(r"\midrule")
        cells_ = []
        for stratum, field, sk in SCORES:
            for c in COND:
                kk, nn = pool[(sk, c)]
                cells_.append(f"{100 * kk / nn:.0f}" if nn else "--")
                mac(f"phia{sk}Pooled{CL[c]}", pct(kk / nn) if nn else PENDING)
        lines.append("All models & " + " & ".join(cells_) + r" \\")
        split_json = {"note": "PHIA end to end, one run per question/model/condition; strict ANSWER rule",
                      "scores": {sk: {"stratum": st, "field": fld} for st, fld, sk in SCORES}, "cells": []}
        for m, k, g in MODELS:
            for stratum, field, sk in SCORES:
                for c in COND:
                    rs = [r for r in bys.get((m, c), []) if (r.get("stratum") == "unsupported") == (stratum == "unsupported")]
                    if rs:
                        split_json["cells"].append({"model": m, "score": sk, "condition": c, "correct": sum(ok_(r, field) for r in rs), "n": len(rs)})
        json.dump(split_json, open(os.path.join(OUT, "phia_split.json"), "w"), indent=1)
        open(os.path.join(TAB, "tab_bench_phia_split.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

# ------------------------------------------------------------------ worked examples
EXAMPLES = [  # (label, model, task, packet key in example_packets.json or None for a refusal)
    ("Two step sources", "gpt-oss-120b", "p2-steps_yesterday", "two_step_steps_yesterday"),
    ("Daylight saving", "llama-3.3-70b", "p10-hrv_trend_28d", "dst_hrv_trend_28d"),
    ("Missing days", "mistral-small-3.1", "p4-steps_total_7d", "missing_steps_total_7d"),
    ("Missing days (\\CC{} wrong)", "llama-3.3-70b", "p4-steps_total_7d", "missing_steps_total_7d"),
]
_epath = os.path.join(OUT, "example_packets.json")
EP = json.load(open(_epath)) if os.path.exists(_epath) else {}


def truth_txt(acc_):
    if acc_.get("number") is not None:
        t_ = f"{acc_['number']:,.0f}"
        return t_ + (" or unknown" if "unknown" in (acc_.get("labels") or []) else "")
    return " or ".join(acc_.get("labels") or [])


def ans_txt(r):
    if r is None:
        return "--"
    a_ = r["answer"]
    v = "no answer" if a_ is None else (f"{a_:,.0f}" if isinstance(a_, (int, float)) else str(a_))
    return v + (r" \ok" if r["correct"] else r" \no")


QTEXT = {}
for p_ in glob.glob(os.path.join(RES, "accuracy-open.jsonl")):
    pass
lines = []
for label, m, task, pk in EXAMPLES:
    rA, rB, rC = (by.get((m, c), {}).get(task) for c in COND)
    if not rC:
        continue
    if pk and pk in EP:
        pkt = EP[pk]["response"]["packet"]
        f = pkt["findings"][0]
        cav = "; ".join(pkt["data_quality"]["caveats"]) or "none"
        ptxt = f"level {pkt['level']}: ``{f['statement']}''. Caveats: {cav}.".replace("%", "\\%")
    else:
        reasons = (rC.get("packet_reasons") or [[None]])[0] or ["?"]
        ptxt = f"no packet: the planner refused (\\code{{{esc(reasons[0])}}})."
    lines.append(f"{label} & {model_tt(m)} & {truth_txt(rC['accept'])} & {ans_txt(rA)} & {ans_txt(rB)} & {ans_txt(rC)} & {ptxt} \\\\")
    lines.append(r"\addlinespace")
open(os.path.join(TAB, "tab_examples.tex"), "w").write("% generated by eval/paper/make_macros.py; do not edit\n" + "\n".join(lines) + "\n")

cl = [r for r in rows_acc if r["condition"] == "C_broker"]
mac("plannerLogged", str(sum(1 for r in cl if r.get("planner"))))
mac("plannerLoggedOf", fmt_int(len(cl)))

usual = {r["task"]: r["accept"].get("labels") or [] for r in rows_acc if r["tag"] == "sleep_vs_usual_3d"}
mac("usualLenient", str(sum(1 for v in usual.values() if "yes" in v and "no" in v)))
mac("usualTasks", str(len(usual)))

ov = [r for m in complete_models for r in by.get((m, "C_broker"), {}).values()
      if "unknown" not in (r["accept"].get("labels") or []) and r["answer"] == "unknown"]
mac("overRefAfterRefusal", str(sum(1 for r in ov if any(x in ("unsupported", "denied") for x in (r.get("packet_levels") or [])))))

# ------------------------------------------------------------------ figures and flags
for src in glob.glob(os.path.join(OUT, "fig_*.pdf")):
    shutil.copyfile(src, os.path.join(FIG, os.path.basename(src)))

out = ["% generated by eval/paper/make_macros.py from eval/paper/out/results.json and eval/paper/results/*.jsonl; do not edit",
       f"% accuracy runs scored {scored} of {expected}; privacy {'complete' if all_done else 'pending'}; repeatability {'complete' if rep_done else 'pending'}",
       r"\newif\ifprivacydone" + ("\\privacydonetrue" if all_done else "\\privacydonefalse"),
       r"\newif\ifrepeatdone" + ("\\repeatdonetrue" if rep_done else "\\repeatdonefalse"),
       r"\newif\ifaccuracydone" + ("\\accuracydonetrue" if scored == expected else "\\accuracydonefalse")]
for k_ in sorted(M):
    out.append(f"\\newcommand{{\\{k_}}}{{{M[k_]}}}")
open(os.path.join(TEX, "results-macros.tex"), "w").write("\n".join(out) + "\n")
pend = sorted(k_ for k_, v in M.items() if v == PENDING)
print(f"wrote {len(M)} macros, {len(pend)} pending; accuracy {scored}/{expected}; privacy {'complete' if all_done else 'pending'}; repeat {'complete' if rep_done else 'pending'}")
if "-v" in sys.argv:
    print("pending:", " ".join(pend))
