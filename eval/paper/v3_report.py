"""Third revision (planner prompt only; docs/paper/v2-preregistration.md, addendum): macros and a table for the paper.

Condition C only, on the same tasks as the second iteration. Compares C3 (results/v3) with the study's C
(results/final) and the second iteration's C2 (results/v2); on fresh PHIA, A and B come from the second iteration
(same questions, unaffected by the broker). Same loading rules as v2_report.py.
Writes docs/paper/tex/v3-macros.tex and docs/paper/tex/tables/tab_v3.tex.
Usage: eval/.venv/bin/python eval/paper/v3_report.py
"""
import collections, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
_spec = importlib.util.spec_from_file_location("v2r", os.path.join(os.path.dirname(os.path.abspath(__file__)), "v2_report.py"))
# v2_report.py runs on import and rewrites the second iteration's outputs from the same data, which is harmless.
v2 = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(v2)

HERE = v2.HERE
V3 = os.path.join(HERE, "results", "v3")
load, mcnemar, wilson, fp, pct, ok_ = v2.load, v2.mcnemar, v2.wilson, v2.fp, v2.pct, v2.ok_
OPEN, FRONTIER, KEY = v2.OPEN, v2.FRONTIER, v2.KEY
M = {}


def mac(k, v):
    M[k] = v


def cmap(d, suite, models):
    rows, _ = load(d, suite)
    return {(r["model"], r["task"], r["run"]): r for r in rows if r["condition"] == "C_broker" and r["model"] in models}


def paired(a, b, f):
    ks = sorted(set(a) & set(b))
    return ks, [f(a[k]) for k in ks], [f(b[k]) for k in ks]


lines = []
corr = lambda r: bool(r.get("correct"))
for suite, models, label in (("accuracy", OPEN + FRONTIER, "Synthetic questions"), ("real", OPEN, "Real data")):
    c1, c2, c3 = cmap(v2.FINAL, suite, models), cmap(v2.V2, suite, models), cmap(V3, suite, models)
    ks = sorted(set(c1) & set(c2) & set(c3))
    if not ks:
        continue
    a1 = sum(corr(c1[k]) for k in ks); a2 = sum(corr(c2[k]) for k in ks); a3 = sum(corr(c3[k]) for k in ks)
    _, x, y = paired({k: c3[k] for k in ks}, {k: c1[k] for k in ks}, corr)
    o3, o1, p = mcnemar(x, y)
    K = "Acc" if suite == "accuracy" else "Real"
    mac(f"vthree{K}N", f"{len(ks):,}".replace(",", "{,}"))
    for n_, v in (("One", a1), ("Two", a2), ("Three", a3)):
        mac(f"vthree{K}{n_}", pct(v / len(ks)) if ks else "--")
    mac(f"vthree{K}P", fp(p)); mac(f"vthree{K}Pairs", f"{o3}/{o1}")
    lines.append(f"{label} & {len(ks)} & {100 * a1 / len(ks):.0f} & {100 * a2 / len(ks):.0f} & {100 * a3 / len(ks):.0f} & {fp(p)} ({o3}/{o1}) \\\\")
    if suite == "accuracy":
        wk = [k for k in ks if c3[k].get("tag") == "steps_week_vs_prev"]
        mac("vthreeWeekN", str(len(wk)))
        for n_, c in (("One", c1), ("Two", c2), ("Three", c3)):
            mac(f"vthreeWeek{n_}", str(sum(corr(c[k]) for k in wk)))
        sig = []
        for m in models:
            mk = [k for k in ks if k[0] == m]
            _, x, y = paired({k: c3[k] for k in mk}, {k: c1[k] for k in mk}, corr)
            o3m, o1m, pm = mcnemar(x, y)
            if pm < 0.05:
                sig.append(f"\\code{{{m}}} ({'up' if o3m > o1m else 'down'}, {fp(pm)})")
        mac("vthreeAccSig", ", ".join(sig) or "none")
    else:
        # Real data: C3 against the study's raw context (A is unaffected by the broker), and against the study's C, per model.
        rA, _ = load(v2.FINAL, suite)
        A = {(r["model"], r["task"], r["run"]): r for r in rA if r["condition"] == "A_raw" and r["model"] in models}
        up, worse = [], []
        for m in models:
            mk = [k for k in ks if k[0] == m and k in A]
            _, x, y = paired({k: c3[k] for k in mk}, {k: A[k] for k in mk}, corr)
            o3m, oam, pm = mcnemar(x, y)
            mac(f"vthreeReal{KEY[m]}", pct(sum(x) / len(mk))); mac(f"vthreeReal{KEY[m]}A", pct(sum(y) / len(mk)))
            mac(f"vthreeRealMcnA{KEY[m]}", f"{fp(pm)} ({o3m}/{oam})")
            _, x, y = paired({k: c3[k] for k in mk}, {k: c1[k] for k in mk}, corr)
            o3m, o1m, pm = mcnemar(x, y)
            if pm < 0.05:
                up.append(f"\\code{{{m}}}" if o3m > o1m else f"\\code{{{m}}} (down)")
        mac("vthreeRealSig", ", ".join(up) or "none")

# Privacy: leaks by the detector, C (study), C2, C3 on the same runs.
lk = lambda r: bool(r.get("leaked"))
p1, p2, p3 = cmap(v2.FINAL, "privacy", OPEN + FRONTIER), cmap(v2.V2, "privacy", OPEN + FRONTIER), cmap(V3, "privacy", OPEN + FRONTIER)
ks = sorted(set(p1) & set(p2) & set(p3))
mac("vthreePrivN", str(len(ks)) if ks else "0")
for n_, c in (("One", p1), ("Two", p2), ("Three", p3)):
    mac(f"vthreePriv{n_}", f"{sum(lk(c[k]) for k in ks)}/{len(ks)}")
lines.append(f"Privacy (leaks) & {len(ks)} & {sum(lk(p1[k]) for k in ks)} & {sum(lk(p2[k]) for k in ks)} & {sum(lk(p3[k]) for k in ks)} & \\\\")

# Fresh PHIA: C3 against C2 and against A (A from the second iteration, same questions).
ph2, _ = load(v2.V2, "phia")
ph3, _ = load(V3, "phia")
A = {(r["model"], r["task"]): r for r in ph2 if r["condition"] == "A_raw" and r["model"] in OPEN}
C2 = {(r["model"], r["task"]): r for r in ph2 if r["condition"] == "C_broker" and r["model"] in OPEN}
C3 = {(r["model"], r["task"]): r for r in ph3 if r["condition"] == "C_broker" and r["model"] in OPEN}
ans = sorted(k for k in C3 if C3[k].get("stratum") == "answerable" and k in C2 and k in A)
uns = sorted(k for k in C3 if C3[k].get("stratum") == "unsupported" and k in C2 and k in A)
w = lambda r: ok_(r, "correct_as_worded")
lab = lambda r: ok_(r, "correct_phia")
for n_, f in (("Worded", w), ("Label", lab)):
    mac(f"vthreePhia{n_}A", pct(sum(f(A[k]) for k in ans) / len(ans)) if ans else "--")
    mac(f"vthreePhia{n_}Two", pct(sum(f(C2[k]) for k in ans) / len(ans)) if ans else "--")
    mac(f"vthreePhia{n_}Three", pct(sum(f(C3[k]) for k in ans) / len(ans)) if ans else "--")
    _, x, y = paired({k: C3[k] for k in ans}, {k: A[k] for k in ans}, f)
    o3, oa, p = mcnemar(x, y)
    mac(f"vthreePhia{n_}P", fp(p)); mac(f"vthreePhia{n_}Pairs", f"{o3}/{oa}")
    _, x, y = paired({k: C3[k] for k in ans}, {k: C2[k] for k in ans}, f)
    o3, o2, p = mcnemar(x, y)
    mac(f"vthreePhia{n_}PvsTwo", fp(p))
rf = lambda r: bool(r.get("correct"))
mac("vthreePhiaUnsupTwo", pct(sum(rf(C2[k]) for k in uns) / len(uns)) if uns else "--")
mac("vthreePhiaUnsupThree", pct(sum(rf(C3[k]) for k in uns) / len(uns)) if uns else "--")
mac("vthreePhiaUnsupA", pct(sum(rf(A[k]) for k in uns) / len(uns)) if uns else "--")
mac("vthreePhiaN", str(len(ans) + len(uns)))
lines.append(f"Fresh PHIA, answerable, as worded & {len(ans)} & -- & {M['vthreePhiaWordedTwo'].replace(chr(92) + '%', '')} & {M['vthreePhiaWordedThree'].replace(chr(92) + '%', '')} & \\\\")
lines.append(f"Fresh PHIA, unsupported refused & {len(uns)} & -- & {M['vthreePhiaUnsupTwo'].replace(chr(92) + '%', '')} & {M['vthreePhiaUnsupThree'].replace(chr(92) + '%', '')} & \\\\")
per = []
for m in OPEN:
    mk = [k for k in ans if k[0] == m]
    if mk:
        mac(f"vthreePhiaWorded{KEY[m]}", pct(sum(w(C3[k]) for k in mk) / len(mk)))
        mac(f"vthreePhiaWorded{KEY[m]}A", pct(sum(w(A[k]) for k in mk) / len(mk)))
        _, x, y = paired({k: C3[k] for k in mk}, {k: A[k] for k in mk}, w)
        o3, oa, p = mcnemar(x, y)
        mac(f"vthreePhiaMcn{KEY[m]}", f"{fp(p)} ({o3}/{oa})")

open(os.path.join(v2.TAB, "tab_v3.tex"), "w").write("% generated by eval/paper/v3_report.py; do not edit\n" + "\n".join(lines) + "\n")
out = ["% generated by eval/paper/v3_report.py; do not edit"] + [f"\\newcommand{{\\{k}}}{{{v}}}" for k, v in sorted(M.items())]
open(os.path.join(v2.TEX, "v3-macros.tex"), "w").write("\n".join(out) + "\n")
print(f"wrote {len(M)} third-revision macros")
for k in sorted(M):
    if not k.startswith("vthreePhiaMcn") and "Worded" not in k[11:] or k in ("vthreePhiaWordedA", "vthreePhiaWordedTwo", "vthreePhiaWordedThree"):
        print(k, M[k])
