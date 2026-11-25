"""Tables and figures for the paper, from eval/paper/results/*.jsonl.

Run: eval/.venv/bin/python eval/paper/report.py
Writes eval/paper/out/summary.md (all tables) and eval/paper/out/fig_*.{png,pdf}.
Every number in the paper comes from this script. Runs that ended in a provider error are excluded and counted.
"""
import collections, glob, json, math, os, re, statistics
from scipy.stats import binomtest

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, os.environ.get("EVAL_RESULTS_DIR", "results"))
OUT = os.path.join(HERE, os.environ.get("EVAL_OUT_DIR", "out"))
os.makedirs(OUT, exist_ok=True)
COND = ["A_raw", "B_tools", "C_broker"]
COND_LABEL = {"A_raw": "A: raw data in context", "B_tools": "B: open data tools", "C_broker": "C: AskWearables"}
# Reference palette (dataviz skill), validated: categorical slots 1-3 in fixed order.
COLOR = {"A_raw": "#2a78d6", "B_tools": "#eb6834", "C_broker": "#1baf7a"}
INK, INK2, GRID, SURF = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
MODEL_ORDER = ["llama-3.3-70b", "llama-4-scout", "mistral-small-3.1", "gemma-4-26b", "gpt-oss-20b", "gpt-oss-120b",
               "nemotron-3-ultra-550b", "gemini-4-neon", "gpt-6.2-astra", "claude-fable-5.2"]


def load(suite):
    rows = {}
    errors = collections.Counter()
    for path in sorted(glob.glob(os.path.join(RES, f"{suite}-*.jsonl"))):
        for line in open(path):
            if not line.strip():
                continue
            r = json.loads(line)
            key = (r["condition"], r["model"], r["task"], r["run"])
            if r.get("error") and re.search(r"maximum context length|context window|too many tokens", r["error"], re.I):
                # The input did not fit the model's context window: a failed answer, not a missing run.
                r.update({"answer": None, "correct": False, "context_exceeded": True, "final": "", "leaked": False,
                          "prompt_tokens": 0, "completion_tokens": 0, "cost": 0, "latency_ms": 0, "tool_calls": 0, "transcript_tools": []})
                rows[key] = r
                continue
            if r.get("error"):
                errors[(r["model"], r["condition"])] += 1
                rows[key] = None  # an error or invalidation after a success reopens the key
                continue
            rows[key] = r  # last row wins
    ok = [r for r in rows.values() if r]
    # Strict scoring, applied equally to every condition: an answer counts only on an explicit ANSWER: line.
    for r in ok:
        if "accept" in r and "ANSWER" not in (r.get("final") or "").upper():
            r["answer"], r["correct"] = None, False
    # Scoring correction applied equally to every condition: in comparison questions "up"/"down"/"flat" mean
    # "higher"/"lower"/"same" (the run-time parser only mapped "flat").
    for r in ok:
        if r.get("tag") == "steps_week_vs_prev" and r.get("answer") in ("up", "down", "flat"):
            mapped = {"up": "higher", "down": "lower", "flat": "same"}[r["answer"]]
            r["correct"] = mapped in (r.get("accept", {}).get("labels") or [])
    missing = sum(1 for r in rows.values() if r is None)
    return ok, missing, errors


# Workers AI list prices, USD per million input/output tokens (developers.cloudflare.com/workers-ai/platform/pricing,
# read 2026-11-25). OpenRouter rows carry the provider-reported cost.
WAI_PRICE = {"inkling-2-small": (0.3, 1.0), "gpt-oss-120b": (0.35, 0.75), "gpt-oss-20b": (0.2, 0.3), "llama-3.3-70b": (0.293, 2.253),
             "llama-4-scout": (0.27, 0.85), "gemma-4-26b": (0.1, 0.3), "mistral-small-3.1": (0.351, 0.555)}
PLANNER_PRICE = WAI_PRICE["llama-3.3-70b"]
_pu = os.path.join(OUT, "planner_usage.json")
PLANNER_CALL = json.load(open(_pu)) if os.path.exists(_pu) else {"mean_prompt": 1817, "mean_completion": 47}


def usage(r):
    """(agent_tokens, planner_tokens, cost_usd, estimated) for one run. Planner = the broker's own LLM planner (C only)."""
    total = r["prompt_tokens"] + r["completion_tokens"]
    if r.get("planner"):
        pl = r["planner"]
        ptok = pl["prompt"] + pl["completion"]
        pcost = (pl["prompt"] * PLANNER_PRICE[0] + pl["completion"] * PLANNER_PRICE[1]) / 1e6
        est = False
        pin, pout = pl["prompt"], pl["completion"]
    elif r["condition"] == "C_broker":
        n = sum(1 for t in (r.get("transcript_tools") or []) if t["name"] == "ask_wearables")
        pin, pout = n * PLANNER_CALL["mean_prompt"], n * PLANNER_CALL["mean_completion"]
        ptok = pin + pout
        pcost = (pin * PLANNER_PRICE[0] + pout * PLANNER_PRICE[1]) / 1e6
        est = True
    else:
        pin = pout = ptok = 0
        pcost = 0.0
        est = False
    ain, aout = max(0, r["prompt_tokens"] - pin), max(0, r["completion_tokens"] - pout)
    if r["provider"] == "openrouter":
        acost = r["cost"] - (r["planner"]["cost"] if r.get("planner") else 0)
    else:
        pr = WAI_PRICE.get(r["model"], (0, 0))
        acost = (ain * pr[0] + aout * pr[1]) / 1e6
    return ain + aout, ptok, acost + pcost, est


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"),) * 3
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, c - h, c + h


def mcnemar(pairs):
    """Exact McNemar on paired booleans [(a, b)]: tests whether a and b differ."""
    b = sum(1 for x, y in pairs if x and not y)
    c = sum(1 for x, y in pairs if y and not x)
    if b + c == 0:
        return b, c, 1.0
    return b, c, binomtest(min(b, c), b + c, 0.5).pvalue


def models_in(rows):
    seen = {r["model"] for r in rows}
    return [m for m in MODEL_ORDER if m in seen] + sorted(seen - set(MODEL_ORDER))


md = ["# AskWearables evaluation: results", "", "Generated by `eval/paper/report.py`. Accuracy is scored against each synthetic person's ground truth, never against the broker's output.", ""]

# ---------------------------------------------------------------- accuracy
acc, acc_missing, acc_err = load("accuracy")
if acc:
    models = models_in(acc)
    by = collections.defaultdict(list)
    for r in acc:
        by[(r["model"], r["condition"])].append(r)
    md += ["## Accuracy by model and condition", "", f"Runs scored: {len(acc)}; runs still missing after provider errors: {acc_missing}.", "",
           "| Model | " + " | ".join(COND_LABEL[c] for c in COND) + " | C vs A (McNemar p) | C vs B (McNemar p) |", "|---|" + "---|" * (len(COND) + 2)]
    fig_data = {}
    for m in models:
        cells = []
        for c in COND:
            rs = by[(m, c)]
            k = sum(r["correct"] for r in rs)
            p, lo, hi = wilson(k, len(rs))
            fig_data[(m, c)] = (p, lo, hi, len(rs))
            cells.append(f"{100*p:.0f}% [{100*lo:.0f}, {100*hi:.0f}] (n={len(rs)})" if rs else "–")
        tests = []
        for other in ["A_raw", "B_tools"]:
            ca = {r["task"]: r["correct"] for r in by[(m, "C_broker")]}
            oa = {r["task"]: r["correct"] for r in by[(m, other)]}
            pairs = [(ca[t], oa[t]) for t in ca if t in oa]
            b, c_, pv = mcnemar(pairs)
            tests.append(f"{pv:.3g} (C-only {b}, {other[0]}-only {c_})" if pairs else "–")
        md.append(f"| {m} | " + " | ".join(cells) + " | " + " | ".join(tests) + " |")
    md.append("")

    # Data exposure: how much of the user's record reached the agent model per question.
    _ea = os.path.join(OUT, "exposure_a.json")
    if os.path.exists(_ea):
        exp_a = json.load(open(_ea))
        def exposure(r):
            if r["condition"] == "A_raw":
                return exp_a[r["task"].split("-")[0]]["chars"]
            return sum(t["result_chars"] for t in (r.get("transcript_tools") or []))
        md += ["## Data exposure: health data delivered to the agent model per question", "",
               "Characters of the user's health data the agent model received to answer one question (median): the whole per-device export in A "
               "(conservative: the workout list is not counted), everything the open tools returned in B, and only the packets in C. "
               "Ratio = median exposure divided by C's. Answers are the same questions; accuracy is in the table above. "
               "Volume is only half of exposure: what the model *could reach* differs too. In A the whole record is delivered; in B the whole record "
               "is reachable on request (any metric, any range, workout titles and notes); in C only the granted metrics, window and level are reachable, "
               "enforced by the gate. B's delivered volume is similar to C's; its exposure risk is in reach, which the privacy suite measures. "
               "B runs with 0 characters are answers given without calling any tool.", "",
               "| Model | A: raw | B: tools | C: AskWearables | A / C | B / C | B runs with no tool call |", "|---|---|---|---|---|---|---|"]
        pooled = {c: [] for c in COND}
        for m in models:
            med = {}
            for c in COND:
                v = [exposure(r) for r in by[(m, c)]]
                pooled[c] += v
                med[c] = statistics.median(v) if v else float("nan")
            nb = by[(m, "B_tools")]
            notool = sum(1 for r in nb if r["tool_calls"] == 0)
            md.append(f"| {m} | {med['A_raw']:,.0f} | {med['B_tools']:,.0f} | {med['C_broker']:,.0f} | {med['A_raw']/med['C_broker']:.1f}× | {med['B_tools']/med['C_broker']:.1f}× | {notool}/{len(nb)} |")
        pm = {c: statistics.median(v) for c, v in pooled.items() if v}
        md += [f"| **all models** | **{pm['A_raw']:,.0f}** | **{pm['B_tools']:,.0f}** | **{pm['C_broker']:,.0f}** | **{pm['A_raw']/pm['C_broker']:.1f}×** | **{pm['B_tools']/pm['C_broker']:.1f}×** | |", "",
               "| | A: raw | B: tools | C: AskWearables |", "|---|---|---|---|",
               "| Reachable by the model | whole record, delivered | whole record, on request | granted metrics, window and level only |",
               "| Precision of what is delivered | raw per-device daily values | raw per-device daily values, titles, notes | values or buckets at the granted level; no free text below level 3 |", ""]
        export_exposure = {c: pm[c] for c in pm}
    else:
        export_exposure = None

    # pooled by trap
    md += ["## Accuracy by data-quality trap (all models pooled)", "", "| Trap | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
    traps = sorted({r["trap"] for r in acc})
    for t in traps:
        cells = []
        for c in COND:
            rs = [r for r in acc if r["trap"] == t and r["condition"] == c]
            k = sum(r["correct"] for r in rs)
            cells.append(f"{100*k/max(1,len(rs)):.0f}% (n={len(rs)})")
        md.append(f"| {t} | " + " | ".join(cells) + " |")
    md.append("")

    # pooled by question type
    md += ["## Accuracy by question (all models pooled)", "", "| Question | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
    for tag in sorted({r["tag"] for r in acc}):
        cells = []
        for c in COND:
            rs = [r for r in acc if r["tag"] == tag and r["condition"] == c]
            cells.append(f"{100*sum(r['correct'] for r in rs)/max(1,len(rs)):.0f}%")
        md.append(f"| {tag} | " + " | ".join(cells) + " |")
    md.append("")

    # honesty: tasks where only "unknown" is acceptable
    md += ["## Honest refusal: questions the data cannot answer", "", "Tasks whose only accepted answer is `unknown` (missing days, stale sync). Rate = answered unknown; the rest gave a number or label.", "",
           "| Model | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
    for m in models:
        cells = []
        for c in COND:
            rs = [r for r in by[(m, c)] if (r["accept"].get("labels") == ["unknown"] and r["accept"].get("number") is None)]
            k = sum(r["answer"] == "unknown" for r in rs)
            cells.append(f"{k}/{len(rs)}")
        md.append(f"| {m} | " + " | ".join(cells) + " |")
    md.append("")

    # Headline table: accuracy first, then context length (input tokens the model reads), then cost.
    md += ["## Accuracy, context length and cost per question", "",
           "Accuracy against ground truth with Wilson 95% interval. Bold marks the highest point estimate per model; where intervals overlap the difference is not significant (see the McNemar tests above). "
           "Context length = input tokens per question (median): what the agent model had to read, plus, in C, what the broker's planner read (llama-3.3-70b). "
           "Cost = mean USD per question (OpenRouter-reported for frontier models; Workers AI list prices for open models; planner included in C). "
           "Cost per correct answer = total cost / correct answers. "
           f"Planner usage in C runs recorded before it was logged separately is estimated from measured per-call usage ({PLANNER_CALL['mean_prompt']:.0f} input, {PLANNER_CALL['mean_completion']:.0f} output tokens per call).", "",
           "| Model | Condition | Accuracy [95% CI] | Context, agent (input tokens) | Context, planner (input tokens) | Output tokens | Cost / question (USD) | Cost / correct answer (USD) |", "|---|---|---|---|---|---|---|---|"]

    def split_usage(r):
        if r.get("planner"):
            pin, pout = r["planner"]["prompt"], r["planner"]["completion"]
        elif r["condition"] == "C_broker":
            n = sum(1 for t in (r.get("transcript_tools") or []) if t["name"] == "ask_wearables")
            pin, pout = n * PLANNER_CALL["mean_prompt"], n * PLANNER_CALL["mean_completion"]
        else:
            pin = pout = 0
        return max(0, r["prompt_tokens"] - pin), pin, max(0, r["completion_tokens"] - pout) + pout

    for m in models:
        accs = {c: (sum(r["correct"] for r in by[(m, c)]) / len(by[(m, c)]) if by[(m, c)] else -1) for c in COND}
        best = max(accs.values())
        for c in COND:
            rs = by[(m, c)]
            if not rs:
                continue
            k = sum(r["correct"] for r in rs)
            p, lo, hi = wilson(k, len(rs))
            sp = [split_usage(r) for r in rs]
            costs = [usage(r)[2] for r in rs]
            free = m.endswith("550b")
            acc_s = f"{100*p:.0f}% [{100*lo:.0f}, {100*hi:.0f}]"
            if accs[c] == best:
                acc_s = f"**{acc_s}**"
            cost_q = "free tier" if free else f"{sum(costs)/len(rs):.5f}"
            cost_c = "free tier" if free else (f"{sum(costs)/k:.5f}" if k else "–")
            md.append(f"| {m} | {COND_LABEL[c]} | {acc_s} | {statistics.median(x[0] for x in sp):,.0f} | {statistics.median(x[1] for x in sp):,.0f} | {statistics.median(x[2] for x in sp):,.0f} | {cost_q} | {cost_c} |")
    md.append("")

    # ---- figure: accuracy grouped bars
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "text.color": INK})
    fig, ax = plt.subplots(figsize=(max(6.5, 0.9 * len(models) + 1.5), 3.4), dpi=200, facecolor=SURF)
    ax.set_facecolor(SURF)
    w = 0.26
    for i, c in enumerate(COND):
        xs = [j + (i - 1) * (w + 0.02) for j in range(len(models))]
        vals = [100 * fig_data.get((m, c), (0,))[0] for m in models]
        err_lo = [100 * (fig_data[(m, c)][0] - fig_data[(m, c)][1]) if (m, c) in fig_data else 0 for m in models]
        err_hi = [100 * (fig_data[(m, c)][2] - fig_data[(m, c)][0]) if (m, c) in fig_data else 0 for m in models]
        ax.bar(xs, vals, w, color=COLOR[c], label=COND_LABEL[c], zorder=2)
        clean = lambda v: 0 if (v != v or v < 0) else v
        vals = [clean(v) for v in vals]
        ax.errorbar(xs, vals, yerr=[[clean(v) for v in err_lo], [clean(v) for v in err_hi]], fmt="none", ecolor=INK2, elinewidth=0.8, capsize=0, zorder=3)
        for x, v in zip(xs, vals):
            ax.text(x, v + 1.5, f"{v:.0f}", ha="center", va="bottom", fontsize=6.5, color=INK2)
    ax.set_xticks(range(len(models)))
    ax.set_xticklabels(models, rotation=30, ha="right")
    ax.set_ylim(0, 112)
    ax.set_ylabel("Accuracy against ground truth (%)")
    ax.yaxis.grid(True, color=GRID, linewidth=0.6, zorder=0)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.13))
    fig.tight_layout()
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(OUT, f"fig_accuracy.{ext}"), facecolor=SURF)
    plt.close(fig)

# ---------------------------------------------------------------- second iteration of C (planner v2)
v2, _, _ = load("accuracy_v2")
if v2 and acc:
    c1 = {(r["model"], r["task"]): r for r in acc if r["condition"] == "C_broker"}
    md += ["## Second iteration of AskWearables (planner v2)", "",
           "After the main study, three planner faults found in its error analysis were fixed: threshold units written as words (\"hours\") were rejected by "
           "validation; the sensitive-category pre-check read an ordinary \"period\" as cycle tracking; requests for each day's values were refused instead of "
           "planned as an aggregate. Condition C was then rerun with the same agent models, people and questions. v1 is the condition reported everywhere else.", "",
           "| Model | C v1 accuracy | C v2 accuracy | v2-only correct | v1-only correct | McNemar p |", "|---|---|---|---|---|---|"]
    for m in models_in(v2):
        rs2 = {r["task"]: r for r in v2 if r["model"] == m}
        pairs = [(rs2[t]["correct"], c1[(m, t)]["correct"]) for t in rs2 if (m, t) in c1]
        b, c_, pv = mcnemar(pairs)
        k1 = sum(c1[(m, t)]["correct"] for t in rs2 if (m, t) in c1)
        k2 = sum(rs2[t]["correct"] for t in rs2 if (m, t) in c1)
        n = len(pairs)
        md.append(f"| {m} | {100*k1/max(1,n):.0f}% | {100*k2/max(1,n):.0f}% | {b} | {c_} | {pv:.3g} |")
    md.append("")

# ---------------------------------------------------------------- privacy
pv, pv_missing, _ = load("privacy")
if pv:
    models = models_in(pv)
    scen = sorted({r["scenario"] for r in pv})
    md += ["## Privacy: leak rate by scenario and condition", "", f"A leak is scored deterministically from the agent's final text (see eval/paper/privacy.py). Runs missing after errors: {pv_missing}.", "",
           "| Scenario | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
    fig_p = {}
    for s in scen:
        cells = []
        for c in COND:
            rs = [r for r in pv if r["scenario"] == s and r["condition"] == c]
            k = sum(r["leaked"] for r in rs)
            p, lo, hi = wilson(k, len(rs))
            fig_p[(s, c)] = (p, lo, hi)
            cells.append(f"{100*p:.0f}% ({k}/{len(rs)})")
        md.append(f"| {s} | " + " | ".join(cells) + " |")
    md += ["", "| Model | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
    for m in models:
        cells = []
        for c in COND:
            rs = [r for r in pv if r["model"] == m and r["condition"] == c]
            cells.append(f"{sum(r['leaked'] for r in rs)}/{len(rs)}")
        md.append(f"| {m} | " + " | ".join(cells) + " |")
    md += ["", "Leak detail (all models): weight value disclosed / resting-HR values disclosed / sleep numbers in a manager message.", ""]
    for c in COND:
        rs = [r for r in pv if r["condition"] == c]
        md.append(f"- {COND_LABEL[c]}: weight {sum(r['weight_value'] for r in rs)}/{len(rs)}, resting HR {sum(r['rhr_values'] > 0 for r in rs)}/{len(rs)}, sleep numbers {sum(r['sleep_numbers'] for r in rs if r['scenario']=='ci_manager_message')}/{sum(1 for r in rs if r['scenario']=='ci_manager_message')}")
    md.append("")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(6.5, 3.0), dpi=200, facecolor=SURF)
    ax.set_facecolor(SURF)
    w = 0.26
    for i, c in enumerate(COND):
        xs = [j + (i - 1) * (w + 0.02) for j in range(len(scen))]
        vals = [100 * fig_p[(s, c)][0] for s in scen]
        ax.bar(xs, vals, w, color=COLOR[c], label=COND_LABEL[c], zorder=2)
        for x, v in zip(xs, vals):
            ax.text(x, v + 1.5, f"{v:.0f}", ha="center", va="bottom", fontsize=6.5, color=INK2)
    ax.set_xticks(range(len(scen)))
    ax.set_xticklabels([s.replace("_", " ") for s in scen])
    ax.set_ylim(0, 112)
    ax.set_ylabel("Runs that leaked (%)")
    ax.yaxis.grid(True, color=GRID, linewidth=0.6, zorder=0)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.15))
    fig.tight_layout()
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(OUT, f"fig_privacy.{ext}"), facecolor=SURF)
    plt.close(fig)

# ---------------------------------------------------------------- repeatability
rp, rp_missing, _ = load("repeat")
if rp:
    models = models_in(rp)
    md += ["## Repeatability", "", "Same question, same data, repeated runs. Agreement = share of questions where every run gave the same parsed answer (TARa@N). Consistent-correct = every run correct.", "",
           "| Model | " + " | ".join(f"{COND_LABEL[c]} agreement / consistent-correct" for c in COND) + " |", "|---|" + "---|" * len(COND)]
    for m in models:
        cells = []
        for c in COND:
            g = collections.defaultdict(list)
            for r in rp:
                if r["model"] == m and r["condition"] == c:
                    g[r["task"]].append(r)
            full = [v for v in g.values() if len(v) >= 3]
            agree = sum(len({json.dumps(r["answer"]) for r in v}) == 1 for v in full)
            cc = sum(all(r["correct"] for r in v) for v in full)
            cells.append(f"{agree}/{len(full)} / {cc}/{len(full)}")
        md.append(f"| {m} | " + " | ".join(cells) + " |")
    md.append("")

# ---------------------------------------------------------------- benchmark suites (eval/paper/BENCHMARKS.md)
BENCH_TITLE = {"phia": "PHIA objective questions (PHIA's labels)", "real": "Real Fitbit data (PMData and LifeSnaps)"}
bench_export = {}


def acc_table(rows, key, title, note):
    """Per-model accuracy per condition (Wilson 95%), with exact McNemar tests of C against A and B on paired tasks."""
    by = collections.defaultdict(dict)
    for r in rows:
        by[(r["model"], r["condition"])][r["task"]] = bool(r[key])
    out = [f"**{title}.** {note}", "", "| Model | " + " | ".join(COND_LABEL[c] for c in COND) + " | C vs A (McNemar p) | C vs B (McNemar p) |", "|---|" + "---|" * (len(COND) + 2)]
    cells_out = []
    for m in models_in(rows):
        cells = []
        for c in COND:
            d = by[(m, c)]
            k = sum(d.values())
            p, lo, hi = wilson(k, len(d))
            cells.append(f"{100*p:.0f}% [{100*lo:.0f}, {100*hi:.0f}] (n={len(d)})" if d else "–")
            if d:
                cells_out.append({"model": m, "condition": c, "metric": key, "correct": k, "n": len(d), "rate": p, "ci": [lo, hi]})
        tests = []
        for other in ["A_raw", "B_tools"]:
            ca, oa = by[(m, "C_broker")], by[(m, other)]
            pairs = [(ca[t], oa[t]) for t in ca if t in oa]
            b, c_, pv = mcnemar(pairs)
            tests.append(f"{pv:.3g} (C-only {b}, {other[0]}-only {c_})" if pairs else "–")
            if pairs:
                cells_out.append({"model": m, "test": f"C_vs_{other}", "metric": key, "c_only": b, "other_only": c_, "p": pv, "pairs": len(pairs)})
        out.append(f"| {m} | " + " | ".join(cells) + " | " + " | ".join(tests) + " |")
    return out + [""], cells_out


def exposure_of(r):
    if r["condition"] == "A_raw":
        return r.get("a_export_chars") or 0
    return sum(t["result_chars"] for t in (r.get("transcript_tools") or []))


for suite in ("phia", "real"):
    rows, missing, errs = load(suite)
    if not rows:
        continue
    for r in rows:  # the strict ANSWER-line rule in load() applies to every correctness field
        if r.get("answer") is None:
            for k in ("correct", "correct_phia", "correct_as_worded", "correct_2pct", "label_match"):
                if k in r:
                    r[k] = False
    ex = {"runs": len(rows), "missing_after_errors": missing, "accuracy": [], "refusal": [], "exposure_median_chars": {}, "by_question": [], "by_trap": []}
    md += [f"## Benchmark: {BENCH_TITLE[suite]}", "",
           f"Runs scored: {len(rows)}; runs still missing after provider errors: {missing}. Each task is anchored on the user's last data day (\"today\"). "
           "Definitions, sampling and licences: eval/paper/BENCHMARKS.md.", ""]
    if suite == "phia":
        ans = [r for r in rows if r.get("stratum") == "answerable"]
        uns = [r for r in rows if r.get("stratum") == "unsupported"]
        t1, c1 = ([], []) if not ans else acc_table(ans, "correct_phia", "Answerable questions, scored against PHIA's label",
                           "Two-significant-digit agreement with PHIA's reference answer (as `npm run eval:phia`). PHIA's labels use an N + 1-day window for \"last N days\" (eval/phia/NOTES.md).")
        t2, c2 = ([], []) if not ans else acc_table(ans, "correct_as_worded", "Answerable questions, scored as worded",
                           "The same answers against PHIA's code re-run with \"last N days\" read as N days ending today.")
        t3, c3 = ([], []) if not ans else acc_table(ans, "correct_2pct", "Answerable questions, PHIA's label within 2%", "Robustness check: 2% relative tolerance instead of two significant digits.")
        md += t1 + t2 + t3
        ex["accuracy"] += c1 + c2 + c3
        wd = [r for r in ans if r.get("window_differs")]
        md += [f"Answerable runs on questions whose label differs between the two window conventions: {len(wd)} of {len(ans)}; "
               f"sleep-threshold runs (PHIA counts time in bed, the catalogue time asleep): {sum(1 for r in ans if 'sleep_minutes_is_time_in_bed' in (r.get('definition_notes') or []))}.", ""]
        if uns:
            t4, c4 = acc_table(uns, "correct", "Unsupported questions: answered unknown",
                               "Questions outside AskWearables' operation set; the scored behaviour is to say unknown or that it cannot be answered.")
            md += t4
            ex["accuracy"] += c4
            md += ["**Unsupported questions by kind** (answered unknown / gave a number matching PHIA's label / n). *Computable* = the data A and B see could answer it "
                   "(median, standard deviation, a window set by another query, an equality threshold), so a matching number there is a real answer, not a guess; "
                   "*not in data* = the needed field (zone minutes, stage percentages, workout speed/steps/elevation) is not in any condition's view.", "",
                   "| Model | Kind | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|---|" + "---|" * len(COND)]
            for m in models_in(uns):
                for kind in ("phia_unsupported_computable", "phia_unsupported_not_in_data"):
                    cells = []
                    for c in COND:
                        rs = [r for r in uns if r["model"] == m and r["condition"] == c and r["trap"] == kind]
                        cells.append(f"{sum(r['answer'] == 'unknown' for r in rs)} / {sum(bool(r.get('label_match')) for r in rs)} / {len(rs)}")
                        ex["refusal"].append({"model": m, "condition": c, "kind": kind, "unknown": sum(r["answer"] == "unknown" for r in rs), "label_match": sum(bool(r.get("label_match")) for r in rs), "n": len(rs)})
                    md.append(f"| {m} | {kind.replace('phia_unsupported_', '').replace('_', ' ')} | " + " | ".join(cells) + " |")
            md.append("")
    else:
        t1, c1 = acc_table(rows, "correct", "Accuracy against references computed from the raw files", "References by eval/paper/real_reference.py, independent of the engine.")
        md += t1
        ex["accuracy"] += c1
        md += ["**Honest refusal** on questions whose only correct answer is `unknown` (a missing day in the window). Rate = answered unknown.", "",
               "| Model | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
        for m in models_in(rows):
            cells = []
            for c in COND:
                rs = [r for r in rows if r["model"] == m and r["condition"] == c and r["accept"].get("labels") == ["unknown"] and r["accept"].get("number") is None]
                k = sum(r["answer"] == "unknown" for r in rs)
                cells.append(f"{k}/{len(rs)}")
                ex["refusal"].append({"model": m, "condition": c, "unknown": k, "n": len(rs)})
            md.append(f"| {m} | " + " | ".join(cells) + " |")
        md += ["", "**Accuracy by natural data-quality trap** (all models pooled; trap = the participant's dominant issue in the 31 days the questions read).", "",
               "| Trap | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
        for t in sorted({r["trap"] for r in rows}):
            cells = []
            for c in COND:
                rs = [r for r in rows if r["trap"] == t and r["condition"] == c]
                k = sum(r["correct"] for r in rs)
                cells.append(f"{100*k/max(1,len(rs)):.0f}% (n={len(rs)})")
                ex["by_trap"].append({"trap": t, "condition": c, "correct": k, "n": len(rs)})
            md.append(f"| {t} | " + " | ".join(cells) + " |")
        md.append("")
    # by question, pooled
    key = "correct_phia" if suite == "phia" else "correct"
    md += ["**Accuracy by question (all models pooled).**", "", "| Question | " + " | ".join(COND_LABEL[c] for c in COND) + " |", "|---|" + "---|" * len(COND)]
    for tag in sorted({r["tag"] for r in rows}):
        cells = []
        for c in COND:
            rs = [r for r in rows if r["tag"] == tag and r["condition"] == c]
            k = sum(bool(r.get(key, r["correct"])) for r in rs)
            cells.append(f"{100*k/max(1,len(rs)):.0f}% (n={len(rs)})")
            ex["by_question"].append({"question": tag, "condition": c, "correct": k, "n": len(rs)})
        md.append(f"| {tag} | " + " | ".join(cells) + " |")
    md.append("")
    # data exposure, as in the accuracy section
    md += ["**Data exposure**: characters of health data delivered to the agent model per question (median): the whole export in A, everything the open tools returned in B, the packets in C.", "",
           "| Model | A: raw | B: tools | C: AskWearables | A / C | B / C |", "|---|---|---|---|---|---|"]
    pooled = {c: [] for c in COND}
    for m in models_in(rows):
        med = {}
        for c in COND:
            v = [exposure_of(r) for r in rows if r["model"] == m and r["condition"] == c]
            pooled[c] += v
            med[c] = statistics.median(v) if v else float("nan")
        ratio = lambda a, b: f"{a/b:.1f}×" if b and b == b and a == a else "–"
        md.append(f"| {m} | {med['A_raw']:,.0f} | {med['B_tools']:,.0f} | {med['C_broker']:,.0f} | {ratio(med['A_raw'], med['C_broker'])} | {ratio(med['B_tools'], med['C_broker'])} |")
    ex["exposure_median_chars"] = {c: statistics.median(v) for c, v in pooled.items() if v}
    md.append("")
    bench_export[suite] = ex

# ---------------------------------------------------------------- planner on PHIA
pp = os.path.join(RES, "planner-phia.jsonl")
if os.path.exists(pp):
    mp = {e["id"]: e for e in json.load(open(os.path.join(HERE, "..", "phia", "mapping.json")))["entries"]}
    rows = [json.loads(l) for l in open(pp) if l.strip()]
    byp = collections.defaultdict(list)
    for r in rows:
        e = mp[r["id"]]
        r["direct"] = e["status"] == "mapped" and e.get("extract", {}).get("from") == "l2.value"
        r["basis"] = e.get("window_basis")
        byp[r["planner"]].append(r)
    md += ["## Planner on PHIA objective questions (stratified sample)", "",
           "Unsupported = PHIA questions outside the operation set (must be refused). Answerable = questions a packet answers directly (aggregate and threshold values).", "",
           "| Planner model | n | Refused unsupported | Guessed on unsupported | Refused answerable | Operation + metric match | + window match | Median latency (s) |", "|---|---|---|---|---|---|---|---|"]
    for p_, rs in sorted(byp.items()):
        u = [r for r in rs if r["mapping"] == "unsupported"]
        a = [r for r in rs if r["direct"]]
        ref = sum(r["status"] == "unsupported" for r in u)
        over = sum(r["status"] == "unsupported" for r in a)
        same = sum(r["same_op_metric"] for r in a)
        win = sum(r["same_op_metric"] and r["window"] == r["basis"] for r in a)
        md.append(f"| {p_} | {len(rs)} | {100*ref/max(1,len(u)):.1f}% | {len(u)-ref} | {100*over/max(1,len(a)):.1f}% | {100*same/max(1,len(a)):.1f}% | {100*win/max(1,len(a)):.1f}% | {statistics.median(r['ms'] for r in rs)/1000:.1f} |")
    md.append("")

open(os.path.join(OUT, "summary.md"), "w").write("\n".join(md))
print("\n".join(md))

# ---------------------------------------------------------------- machine-readable export (site and paper)
def cells(rows, key):
    out = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        k = key(r)
        out[k][1] += 1
        out[k][0] += int(bool(r.get("correct", r.get("leaked"))))
    return out

export = {"generated_note": "from eval/paper/results/*.jsonl by eval/paper/report.py; partial until runs finish", "conditions": COND_LABEL, "accuracy": [], "by_trap": [], "by_question": [], "privacy": [], "efficiency": [], "examples": []}
if acc:
    for (m, c), (k, n) in cells(acc, lambda r: (r["model"], r["condition"])).items():
        p, lo, hi = wilson(k, n)
        export["accuracy"].append({"model": m, "condition": c, "correct": k, "n": n, "rate": p, "ci": [lo, hi]})
    for (t, c), (k, n) in cells(acc, lambda r: (r["trap"], r["condition"])).items():
        export["by_trap"].append({"trap": t, "condition": c, "correct": k, "n": n})
    for (t, c), (k, n) in cells(acc, lambda r: (r["tag"], r["condition"])).items():
        export["by_question"].append({"question": t, "condition": c, "correct": k, "n": n})
    g = collections.defaultdict(list)
    for r in acc:
        g[(r["model"], r["condition"])].append(r)
    for (m, c), rs in g.items():
        u = [usage(r) for r in rs]
        k = sum(r["correct"] for r in rs)
        tc = sum(x[2] for x in u)
        pA, loA, hiA = wilson(k, len(rs))
        export["efficiency"].append({"model": m, "condition": c, "accuracy": k / len(rs), "accuracy_ci": [loA, hiA], "n": len(rs),
                                     "median_agent_input_tokens": statistics.median(max(0, r["prompt_tokens"] - ((r.get("planner") or {}).get("prompt") or (sum(1 for t in (r.get("transcript_tools") or []) if t["name"] == "ask_wearables") * PLANNER_CALL["mean_prompt"] if r["condition"] == "C_broker" else 0))) for r in rs),
                                     "median_agent_tokens": statistics.median(x[0] for x in u), "median_planner_tokens": statistics.median(x[1] for x in u),
                                     "median_total_tokens": statistics.median(x[0] + x[1] for x in u), "median_prompt_tokens": statistics.median(r["prompt_tokens"] for r in rs),
                                     "median_completion_tokens": statistics.median(r["completion_tokens"] for r in rs), "median_latency_s": statistics.median(r["latency_ms"] for r in rs) / 1000,
                                     "mean_cost_usd": tc / len(rs), "cost_per_correct_usd": (tc / k if k else None), "planner_usage_estimated": any(x[3] for x in u)})
    # Worked examples: same task and model, where conditions disagree. Final text only (synthetic data).
    bytask = collections.defaultdict(dict)
    for r in acc:
        bytask[(r["model"], r["task"])][r["condition"]] = r
    for (m, t), d in sorted(bytask.items()):
        if len(d) == 3 and d["C_broker"]["correct"] and (not d["A_raw"]["correct"] or not d["B_tools"]["correct"]):
            export["examples"].append({"model": m, "task": t, "trap": d["A_raw"]["trap"], "question_tag": d["A_raw"]["tag"], "accept": d["A_raw"]["accept"],
                                       "runs": {c: {"answer": d[c]["answer"], "correct": d[c]["correct"], "final": (d[c].get("final") or "")[-500:], "tool_calls": d[c]["tool_calls"], "prompt_tokens": d[c]["prompt_tokens"]} for c in COND}})
if pv:
    for (s_, c), (k, n) in cells(pv, lambda r: (r["scenario"], r["condition"])).items():
        export["privacy"].append({"scenario": s_, "condition": c, "leaked": k, "n": n})
export["exposure_median_chars"] = export_exposure if acc else None
export["benchmarks"] = bench_export
json.dump(export, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=str)

# ---------------------------------------------------------------- additional figures for the paper
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "text.color": INK})
MARK = {"A_raw": "o", "B_tools": "s", "C_broker": "D"}


def save(fig, name):
    fig.tight_layout()
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(OUT, f"{name}.{ext}"), facecolor=SURF)
    plt.close(fig)


if acc:
    models_all = models_in(acc)
    # Fig: accuracy vs cost per correct answer, small multiples (one panel per model, three conditions each).
    paid = [m for m in models_all if not m.endswith("550b")]
    ncol = 5
    nrow = (len(paid) + ncol - 1) // ncol
    fig, axes = plt.subplots(nrow, ncol, figsize=(8.6, 2.0 * nrow + 0.6), dpi=200, facecolor=SURF, squeeze=False)
    for idx, m in enumerate(paid):
        ax = axes[idx // ncol][idx % ncol]
        ax.set_facecolor(SURF)
        for c in COND:
            rs = by[(m, c)]
            k = sum(r["correct"] for r in rs)
            cost = sum(usage(r)[2] for r in rs)
            if not rs or k == 0 or cost <= 0:
                continue
            x, y = cost / k, 100 * k / len(rs)
            ax.scatter(x, y, s=30, color=COLOR[c], marker=MARK[c], edgecolor=SURF, linewidth=0.8, zorder=3)
            ax.annotate(c[0], (x, y), xytext=(4, -3), textcoords="offset points", fontsize=6.5, color=INK2)
        from matplotlib.ticker import FuncFormatter, MaxNLocator
        ax.xaxis.set_major_locator(MaxNLocator(3))
        ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"${v:.3f}" if v >= 0.01 else f"${v:.4f}"))
        ax.margins(x=0.25)
        ax.set_ylim(40, 103)
        ax.set_title(m, fontsize=7.5, color=INK, loc="left")
        ax.tick_params(labelsize=6)
        ax.yaxis.grid(True, color=GRID, linewidth=0.5)
        ax.spines[["top", "right"]].set_visible(False)
    for idx in range(len(paid), nrow * ncol):
        axes[idx // ncol][idx % ncol].axis("off")
    fig.supxlabel("Cost per correct answer (USD; each panel has its own range). Up and to the left is better.", fontsize=7.5, color=INK2)
    fig.supylabel("Accuracy (%)", fontsize=7.5, color=INK2)
    handles = [plt.Line2D([], [], color=COLOR[c], marker=MARK[c], linestyle="", markersize=5) for c in COND]
    fig.legend(handles, [COND_LABEL[c] for c in COND], loc="upper center", ncol=3, frameon=False, fontsize=7.5, bbox_to_anchor=(0.5, 1.0))
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(OUT, f"fig_accuracy_cost.{ext}"), facecolor=SURF)
    plt.close(fig)

    # Fig: context exposure per condition (median characters of health data per question), log scale bars.
    if export_exposure:
        fig, ax = plt.subplots(figsize=(5.2, 2.4), dpi=200, facecolor=SURF)
        ax.set_facecolor(SURF)
        ys = list(range(len(COND)))[::-1]
        vals = [export_exposure.get(c, 0) for c in COND]
        ax.barh(ys, vals, color=[COLOR[c] for c in COND], height=0.55, zorder=2)
        for y, v, c in zip(ys, vals, COND):
            ax.text(v * 1.05, y, f"{v:,.0f} chars", va="center", fontsize=7.5, color=INK2)
        ax.set_yticks(ys)
        ax.set_yticklabels([COND_LABEL[c] for c in COND])
        ax.set_xscale("log")
        ax.set_xlim(100, max(vals) * 4)
        ax.set_xlabel("Health data delivered to the agent model per question (median characters, log scale)")
        ax.xaxis.grid(True, color=GRID, linewidth=0.6, zorder=0)
        ax.spines[["top", "right"]].set_visible(False)
        save(fig, "fig_exposure")

    # Fig: accuracy by trap x condition, heatmap (sequential single hue; text shows value).
    traps = sorted({r["trap"] for r in acc})
    import numpy as np
    from matplotlib.colors import LinearSegmentedColormap
    M = np.array([[100 * sum(r["correct"] for r in acc if r["trap"] == t and r["condition"] == c) / max(1, sum(1 for r in acc if r["trap"] == t and r["condition"] == c)) for c in COND] for t in traps])
    cmap = LinearSegmentedColormap.from_list("seq", ["#cde2fb", "#2a78d6", "#104281"])
    fig, ax = plt.subplots(figsize=(5.2, 0.32 * len(traps) + 1.0), dpi=200, facecolor=SURF)
    ax.imshow(M, cmap=cmap, vmin=50, vmax=100, aspect="auto")
    for i in range(len(traps)):
        for j in range(len(COND)):
            ax.text(j, i, f"{M[i, j]:.0f}", ha="center", va="center", fontsize=7.5, color="#ffffff" if M[i, j] > 80 else INK)
    ax.set_xticks(range(len(COND)))
    ax.set_xticklabels([COND_LABEL[c] for c in COND], fontsize=7.5)
    ax.set_yticks(range(len(traps)))
    ax.set_yticklabels([t.replace("_", " ") for t in traps], fontsize=7.5)
    ax.tick_params(length=0)
    for s_ in ax.spines.values():
        s_.set_visible(False)
    ax.set_title("Accuracy (%) by data-quality trap, all models pooled", fontsize=8.5, color=INK2, loc="left")
    save(fig, "fig_traps")

    # Fig: what went wrong in C (all models): planner refused vs packet released but answer wrong vs correct.
    cr = [r for r in acc if r["condition"] == "C_broker"]
    def c_kind(r):
        if r["correct"]:
            return "correct"
        lv = r.get("packet_levels") or []
        if lv and all(x == "unsupported" for x in lv):
            return "planner refused every ask"
        if lv and any(x == "denied" for x in lv):
            return "gate denied"
        return "packet released, answer wrong"
    kinds = collections.Counter(c_kind(r) for r in cr)
    order = ["correct", "packet released, answer wrong", "planner refused every ask", "gate denied"]
    shades = {"correct": COLOR["C_broker"], "packet released, answer wrong": "#eda100", "planner refused every ask": "#e34948", "gate denied": "#6250d6"}
    tot = sum(kinds.values())
    rows_ = [(k, kinds.get(k, 0)) for k in order if kinds.get(k, 0)]
    fig, ax = plt.subplots(figsize=(6.2, 0.42 * len(rows_) + 0.8), dpi=200, facecolor=SURF)
    ax.set_facecolor(SURF)
    ys = list(range(len(rows_)))[::-1]
    ax.barh(ys, [v for _, v in rows_], color=[shades[k] for k, _ in rows_], height=0.55, zorder=2)
    for y, (k, v) in zip(ys, rows_):
        ax.text(v * 1.08, y, f"{v} ({100*v/tot:.1f}%)", va="center", fontsize=7, color=INK2)
    ax.set_yticks(ys)
    ax.set_yticklabels([k for k, _ in rows_], fontsize=7.5)
    ax.set_xscale("log")
    ax.set_xlim(1, tot * 4)
    ax.set_xlabel(f"Runs (log scale), condition C, all models, n = {tot}", fontsize=7.5)
    ax.xaxis.grid(True, color=GRID, linewidth=0.6, zorder=0)
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, "fig_c_outcomes")

# Fig: planner on PHIA (selection and held-out samples).
for name in ("planner-phia.jsonl", "planner-phia-heldout.jsonl"):
    pth = os.path.join(RES, name)
    if not os.path.exists(pth):
        continue
mp_all = None
rowsets = []
for name, label in (("planner-phia.jsonl", "selection sample"), ("planner-phia-heldout.jsonl", "held-out sample")):
    pth = os.path.join(RES, name)
    if os.path.exists(pth):
        rowsets.append((label, [json.loads(l) for l in open(pth) if l.strip()]))
if rowsets:
    mp_all = {e["id"]: e for e in json.load(open(os.path.join(HERE, "..", "phia", "mapping.json")))["entries"]}
    bars = []
    for label, rows in rowsets:
        byp = collections.defaultdict(list)
        for r in rows:
            byp[r["planner"]].append(r)
        for p_, rs in sorted(byp.items()):
            u = [r for r in rs if r["mapping"] == "unsupported"]
            a = [r for r in rs if mp_all[r["id"]]["status"] == "mapped" and mp_all[r["id"]].get("extract", {}).get("from") == "l2.value"]
            bars.append((f"{p_}\n({label})", 100 * sum(r["status"] == "unsupported" for r in u) / max(1, len(u)), 100 * sum(r["same_op_metric"] for r in a) / max(1, len(a))))
    fig, ax = plt.subplots(figsize=(6.4, 0.55 * len(bars) + 1.0), dpi=200, facecolor=SURF)
    ax.set_facecolor(SURF)
    ys = list(range(len(bars)))[::-1]
    ax.barh([y + 0.18 for y in ys], [b[1] for b in bars], height=0.34, color="#6250d6", label="refused unsupported questions (%)")
    ax.barh([y - 0.18 for y in ys], [b[2] for b in bars], height=0.34, color="#2a78d6", label="right operation and metric on answerable (%)")
    for y, b in zip(ys, bars):
        ax.text(b[1] + 1, y + 0.18, f"{b[1]:.0f}", va="center", fontsize=6.5, color=INK2)
        ax.text(b[2] + 1, y - 0.18, f"{b[2]:.0f}", va="center", fontsize=6.5, color=INK2)
    ax.set_yticks(ys)
    ax.set_yticklabels([b[0] for b in bars], fontsize=7)
    ax.set_xlim(0, 112)
    ax.xaxis.grid(True, color=GRID, linewidth=0.6)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, fontsize=7, loc="lower right")
    save(fig, "fig_planner_phia")

# Fig: repeatability, share of tasks with identical answers across runs, per model and condition.
if rp:
    models_r = models_in(rp)
    fig, ax = plt.subplots(figsize=(6.5, 3.0), dpi=200, facecolor=SURF)
    ax.set_facecolor(SURF)
    w = 0.26
    for i, c in enumerate(COND):
        vals = []
        for m in models_r:
            g = collections.defaultdict(list)
            for r in rp:
                if r["model"] == m and r["condition"] == c:
                    g[r["task"]].append(json.dumps(r["answer"]))
            full = [v for v in g.values() if len(v) >= 3]
            vals.append(100 * sum(len(set(v)) == 1 for v in full) / max(1, len(full)))
        xs = [j + (i - 1) * (w + 0.02) for j in range(len(models_r))]
        ax.bar(xs, vals, w, color=COLOR[c], label=COND_LABEL[c], zorder=2)
        for x, v in zip(xs, vals):
            ax.text(x, v + 1.5, f"{v:.0f}", ha="center", fontsize=6.5, color=INK2)
    ax.set_xticks(range(len(models_r)))
    ax.set_xticklabels(models_r, rotation=30, ha="right")
    ax.set_ylim(0, 112)
    ax.set_ylabel("Questions with identical answers across runs (%)")
    ax.yaxis.grid(True, color=GRID, linewidth=0.6, zorder=0)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.15))
    save(fig, "fig_repeat")
