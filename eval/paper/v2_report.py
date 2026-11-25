"""Second iteration (docs/paper/v2-preregistration.md): tables and macros for the paper.

Reads eval/paper/results/v2/ (second-iteration runs) and eval/paper/results/final/ (the study), with the study's
rules: last row per key wins, an infrastructure error reopens the key, a context-window refusal is a failed answer,
the first turn-limit outcome is final and scored as no answer, and an answer counts only with an ANSWER: line.
Writes docs/paper/tex/v2-macros.tex and docs/paper/tex/tables/tab_v2_*.tex.
Usage: eval/.venv/bin/python eval/paper/v2_report.py
"""
import collections, glob, json, math, os, re
from scipy.stats import binomtest

HERE = os.path.dirname(os.path.abspath(__file__))
V2 = os.path.join(HERE, "results", "v2")
FINAL = os.path.join(HERE, "results", "final")
TEX = os.path.join(HERE, "..", "..", "docs", "paper", "tex")
TAB = os.path.join(TEX, "tables")
COND = ["A_raw", "B_tools", "C_broker"]
CL = {"A_raw": "A", "B_tools": "B", "C_broker": "C"}
OPEN = ["llama-3.3-70b", "llama-4-scout", "mistral-small-3.1", "gemma-4-26b", "gpt-oss-20b", "gpt-oss-120b"]
FRONTIER = ["gemini-4-neon", "gpt-6.2-astra", "claude-fable-5.2"]
KEY = {"llama-3.3-70b": "LlamaThree", "llama-4-scout": "LlamaScout", "mistral-small-3.1": "Mistral", "gemma-4-26b": "Gemma",
       "gpt-oss-20b": "OssSmall", "gpt-oss-120b": "OssLarge", "gemini-4-neon": "Gemini", "gpt-6.2-astra": "Astra", "claude-fable-5.2": "Fable"}
CTX = re.compile(r"maximum context length|context window|too many tokens", re.I)


def load(d, suite):
    rows, step = {}, set()
    for path in sorted(glob.glob(os.path.join(d, f"{suite}-*.jsonl"))):
        for line in open(path):
            if not line.strip():
                continue
            r = json.loads(line)
            k = (r["condition"], r["model"], r["task"], r["run"])
            if k in step:
                continue
            e = r.get("error")
            if e == "max_steps":
                r.update(answer=None, correct=False, correct_phia=False, correct_as_worded=False, leaked=False, final="")
                rows[k] = r; step.add(k)
            elif e and CTX.search(e):
                r.update(answer=None, correct=False, correct_phia=False, correct_as_worded=False, leaked=False, final="")
                rows[k] = r
            else:
                rows[k] = None if e else r
    ok = [r for r in rows.values() if r]
    for r in ok:
        if "accept" in r and "ANSWER" not in (r.get("final") or "").upper():
            r["answer"] = None
            for f in ("correct", "correct_phia", "correct_as_worded"):
                if f in r:
                    r[f] = False
        if r.get("tag") == "steps_week_vs_prev" and r.get("answer") in ("up", "down", "flat"):
            r["correct"] = {"up": "higher", "down": "lower", "flat": "same"}[r["answer"]] in ((r.get("accept") or {}).get("labels") or [])
    missing = sum(1 for v in rows.values() if v is None)
    return ok, missing


def wilson(k, n, z=1.959964):
    if not n:
        return (0, 0, 0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, max(0, c - h), min(1, c + h)


def mcnemar(a, b):
    """Exact McNemar on paired booleans: returns (only_a, only_b, p)."""
    oa = sum(1 for x, y in zip(a, b) if x and not y)
    ob = sum(1 for x, y in zip(a, b) if y and not x)
    p = binomtest(oa, oa + ob, 0.5).pvalue if oa + ob else 1.0
    return oa, ob, p


def pct(x):
    return f"{100 * x:.0f}\\%"


def fp(p):
    return "$<$0.001" if p < 0.001 else f"{p:.3f}" if p < 0.01 else f"{p:.2f}"


M = {}


def mac(k, v):
    M[k] = v


def ok_(r, field):
    return r.get("answer") is not None and bool(r.get(field))


# ---------------------------------------------------------------- fresh PHIA, open-weight models
phia, phia_missing = load(V2, "phia")
by = collections.defaultdict(dict)
for r in phia:
    by[(r["model"], r["condition"])][r["task"]] = r
SC = [("Worded", "answerable", "correct_as_worded"), ("Label", "answerable", "correct_phia"), ("Unsup", "unsupported", "correct")]
lines, pool = [], collections.defaultdict(lambda: [0, 0])
for m in OPEN:
    cells = []
    for sk, st, field in SC:
        for c in COND:
            rs = [r for r in by[(m, c)].values() if (r.get("stratum") == "unsupported") == (st == "unsupported")]
            k = sum(ok_(r, field) for r in rs)
            pool[(sk, c)][0] += k; pool[(sk, c)][1] += len(rs)
            cells.append(f"{100 * k / len(rs):.0f}" if rs else "--")
            if rs:
                mac(f"vtwo{sk}{KEY[m]}{CL[c]}", pct(k / len(rs)))
    # McNemar, C vs A, answerable as worded, paired by task
    ta = {t: r for t, r in by[(m, "A_raw")].items() if r.get("stratum") == "answerable"}
    tc = {t: r for t, r in by[(m, "C_broker")].items() if r.get("stratum") == "answerable"}
    common = sorted(set(ta) & set(tc))
    oc, oa, p = mcnemar([ok_(tc[t], "correct_as_worded") for t in common], [ok_(ta[t], "correct_as_worded") for t in common])
    mac(f"vtwoMcn{KEY[m]}", f"{fp(p)} ({oc}/{oa})")
    cells.append(f"{fp(p)} ({oc}/{oa})")
    lines.append(f"\\code{{{m}}} & " + " & ".join(cells) + r" \\")
lines.append(r"\midrule")
cells = []
for sk, st, field in SC:
    for c in COND:
        k, n = pool[(sk, c)]
        cells.append(f"{100 * k / n:.0f}" if n else "--")
        mac(f"vtwo{sk}Pooled{CL[c]}", pct(k / n) if n else "--")
lines.append("All open-weight models & " + " & ".join(cells) + r" & \\")
open(os.path.join(TAB, "tab_v2_phia.tex"), "w").write("% generated by eval/paper/v2_report.py; do not edit\n" + "\n".join(lines) + "\n")
mac("vtwoPhiaRuns", f"{len(phia):,}".replace(",", "{,}"))
mac("vtwoPhiaMissing", str(phia_missing))

# The study's PHIA numbers for the same six models, for the gap comparison.
study_phia, _ = load(FINAL, "phia")
sp = collections.defaultdict(lambda: [0, 0])
for r in study_phia:
    if r["model"] in OPEN and r.get("stratum") == "answerable":
        sp[r["condition"]][0] += ok_(r, "correct_as_worded"); sp[r["condition"]][1] += 1
    if r["model"] in OPEN and r.get("stratum") == "unsupported":
        sp["U" + r["condition"]][0] += bool(r.get("correct")); sp["U" + r["condition"]][1] += 1
for c in COND:
    mac(f"vtwoStudyWorded{CL[c]}", pct(sp[c][0] / sp[c][1]))
    mac(f"vtwoStudyUnsup{CL[c]}", pct(sp["U" + c][0] / sp["U" + c][1]))
gap_study = sp["C_broker"][0] / sp["C_broker"][1] - sp["A_raw"][0] / sp["A_raw"][1]
gap_v2 = pool[("Worded", "C_broker")][0] / max(1, pool[("Worded", "C_broker")][1]) - pool[("Worded", "A_raw")][0] / max(1, pool[("Worded", "A_raw")][1])
mac("vtwoGapStudy", f"{100 * gap_study:+.0f}".replace("+", "$+$").replace("-", "$-$"))
mac("vtwoGapNew", f"{100 * gap_v2:+.0f}".replace("+", "$+$").replace("-", "$-$"))

# Threshold-count release and heart-rate hints in the fresh C runs.
cr = [r for r in phia if r["condition"] == "C_broker"]
lv = collections.Counter(l for r in cr for l in (r.get("packet_levels") or []))
mac("vtwoCDenied", str(lv.get("denied", 0)))
mac("vtwoCUnsupportedAsks", str(lv.get("unsupported", 0)))
thr = [r for r in cr if r.get("stratum") == "answerable" and (r.get("tag") or "").startswith("threshold_check")]
mac("vtwoThrN", str(len(thr)))
mac("vtwoThrAcc", pct(sum(ok_(r, "correct_as_worded") for r in thr) / len(thr)) if thr else "--")
thrA = [r for r in phia if r["condition"] == "A_raw" and r.get("stratum") == "answerable" and (r.get("tag") or "").startswith("threshold_check")]
mac("vtwoThrAccA", pct(sum(ok_(r, "correct_as_worded") for r in thrA) / len(thrA)) if thrA else "--")

# ---------------------------------------------------------------- regression: C (study) vs C2 (second iteration)
def regression(suite, models, field="correct", leak=False):
    new, _ = load(V2, suite)
    old, _ = load(FINAL, suite)
    nb = {(r["model"], r["task"], r["run"]): r for r in new if r["condition"] == "C_broker"}
    ob = {(r["model"], r["task"], r["run"]): r for r in old if r["condition"] == "C_broker"}
    out = []
    for m in models:
        keys = sorted(k for k in nb if k[0] == m and k in ob)
        if not keys:
            continue
        f = (lambda r: bool(r.get("leaked"))) if leak else (lambda r: bool(r.get(field)))
        a = [f(nb[k]) for k in keys]; b = [f(ob[k]) for k in keys]
        o2, o1, p = mcnemar(a, b)
        out.append((m, len(keys), sum(b), sum(a), o2, o1, p))
    return out


def reg_table(name, rows, leak=False):
    lines = []
    tn = tc1 = tc2 = 0
    for m, n, c1, c2, o2, o1, p in rows:
        tn += n; tc1 += c1; tc2 += c2
        lines.append(f"\\code{{{m}}} & {n} & {100 * c1 / n:.0f} & {100 * c2 / n:.0f} & {o2} & {o1} & {fp(p)} \\\\")
    if rows:
        lines.append(r"\midrule")
        lines.append(f"All & {tn} & {100 * tc1 / tn:.0f} & {100 * tc2 / tn:.0f} & & & \\\\")
    open(os.path.join(TAB, f"tab_v2_{name}.tex"), "w").write("% generated by eval/paper/v2_report.py; do not edit\n" + "\n".join(lines) + "\n")
    return tn, tc1, tc2


for suite, models, leak in (("accuracy", OPEN + FRONTIER, False), ("privacy", OPEN + FRONTIER, True), ("real", OPEN, False)):
    rows = regression(suite, models, leak=leak)
    tn, c1, c2 = reg_table(suite, rows, leak)
    k = suite.capitalize()
    mac(f"vtwoReg{k}N", f"{tn:,}".replace(",", "{,}"))
    mac(f"vtwoReg{k}Old", (f"{c1}/{tn}" if leak else pct(c1 / tn)) if tn else "--")
    mac(f"vtwoReg{k}New", (f"{c2}/{tn}" if leak else pct(c2 / tn)) if tn else "--")
    for m, n, a, b, o2, o1, p in rows:
        mac(f"vtwoReg{k}{KEY[m]}", f"{100 * a / n:.0f}\\% $\\to$ {100 * b / n:.0f}\\%" if not leak else f"{a}/{n} $\\to$ {b}/{n}")
    sig = [(m, o2, o1, p) for m, n, a, b, o2, o1, p in rows if p < 0.05]
    mac(f"vtwoReg{k}Sig", ", ".join(f"\\code{{{m}}} ({'up' if o2 > o1 else 'down'}, {fp(p)})" for m, o2, o1, p in sig) or "none")

# Denials with a granted alternative: did the agent model ask again and receive a packet? (full PHIA rows, local)
ids = {"phia" + i["id"].replace(":", "_") for i in json.load(open(os.path.join(HERE, "benchmarks", "phia_sample_v2.json")))["items"]}
fr = {}
for f in [os.path.join(HERE, "..", "data", "results", "phia-open.full.jsonl")] + sorted(glob.glob(os.path.join(HERE, "..", "data", "results", "v2", "phia-*.full.jsonl"))):
    if os.path.exists(f):
        for l in open(f):
            r = json.loads(l)
            if r["task"] in ids and r["condition"] == "C_broker":
                fr[(r["model"], r["task"], r["run"])] = r
den = [r for r in fr.values() if "denied" in (r.get("packet_levels") or [])]
followed = sum(1 for r in den if any(x not in ("denied", "unsupported") for x in r["packet_levels"][r["packet_levels"].index("denied") + 1:]))
with_alt = sum(1 for r in den if any("granted_alternative" in x for pr in (r.get("packet_reasons") or []) if pr for x in pr))
mac("vtwoDeniedRuns", str(len(den))); mac("vtwoDeniedWithAlt", str(with_alt)); mac("vtwoDeniedFollowed", str(followed))

# Synthetic C vs C2 by question: where the second-iteration planner changed accuracy.
new_acc, _ = load(V2, "accuracy"); old_acc, _ = load(FINAL, "accuracy")
nb = {(r["model"], r["task"]): r for r in new_acc if r["condition"] == "C_broker"}
ob = {(r["model"], r["task"]): r for r in old_acc if r["condition"] == "C_broker"}
for tag, key in (("steps_week_vs_prev", "Week"), ("sleep_vs_usual_3d", "Usual")):
    ks = [k for k in nb if k in ob and nb[k].get("tag") == tag]
    mac(f"vtwoRegQ{key}N", str(len(ks)))
    mac(f"vtwoRegQ{key}Old", str(sum(bool(ob[k]["correct"]) for k in ks))); mac(f"vtwoRegQ{key}New", str(sum(bool(nb[k]["correct"]) for k in ks)))

out = ["% generated by eval/paper/v2_report.py; do not edit"] + [f"\\newcommand{{\\{k}}}{{{v}}}" for k, v in sorted(M.items())]
open(os.path.join(TEX, "v2-macros.tex"), "w").write("\n".join(out) + "\n")
print(f"wrote {len(M)} macros; fresh PHIA rows {len(phia)} (open infra gaps {phia_missing})")
for k in ("vtwoWordedPooledA", "vtwoWordedPooledB", "vtwoWordedPooledC", "vtwoUnsupPooledC", "vtwoGapStudy", "vtwoGapNew",
          "vtwoRegAccuracyOld", "vtwoRegAccuracyNew", "vtwoRegPrivacyOld", "vtwoRegPrivacyNew", "vtwoRegRealOld", "vtwoRegRealNew"):
    print(k, M.get(k))
