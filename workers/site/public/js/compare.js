// "Three ways to give an agent your wearable data": the A/B/C comparison on the landing page.
// Every figure is computed here from /data/results.json (shared with results.js through window.awResults), so the
// section follows the study when the results file is refreshed. Rows are aligned across the three columns and use
// one shared scale per row. Model text is shown with textContent only.
"use strict";
(function () {
  const CONDS = ["A_raw", "B_tools", "C_broker"];
  const CLS = { A_raw: "a", B_tools: "b", C_broker: "c" };
  const QUESTIONS = {
    rhr_yesterday: "Resting heart rate yesterday", rhr_avg_14d: "Average resting heart rate, 14 days", hrv_trend_28d: "HRV trend over 4 weeks",
    sleep_avg_7d: "Average sleep, last 7 nights", sleep_under_6h_7d: "Any night under 6 hours, last 7", sleep_vs_usual_3d: "Last 3 nights vs usual",
    steps_total_7d: "Total steps, last 7 days", steps_week_vs_prev: "Steps this week vs last week", steps_yesterday: "Steps yesterday", workouts_14d: "Workouts in the last 14 days",
  };
  const TRAP = { two_step_sources: "phone and watch both counting steps", missing_days: "days with no data", stale_sync: "a stale sync", device_switch: "a new device", travel: "a time-zone change", dst: "a clock change", clean: "clean data" };
  // Which kind of miss to show for each route, in order of preference: the trap that route is known to trip on.
  // Each entry is [trap, question]: a miss where the trap explains the wrong answer in one glance.
  const FAILURE_PREF = {
    A_raw: [["two_step_sources", "steps_yesterday"], ["two_step_sources", "steps_total_7d"], ["missing_days", "steps_total_7d"], ["stale_sync", "rhr_yesterday"]],
    B_tools: [["missing_days", "steps_total_7d"], ["two_step_sources", "steps_yesterday"], ["stale_sync", "steps_yesterday"], ["stale_sync", "rhr_yesterday"]],
    C_broker: [],
  };
  const SEES_NOTE = { A_raw: "the whole export, every question", B_tools: "small replies, but the whole record on request", C_broker: "only what the grant allows" };

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const pct = (x) => (x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1) + "%";
  const int = (x) => Math.round(x).toLocaleString("en-US");
  const usd = (x) => "$" + (x >= 0.1 ? x.toFixed(2) : x.toPrecision(2));
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // Wilson score interval for a pooled proportion.
  function wilson(k, n) {
    if (!n) return [0, 0];
    const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d, w = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [Math.max(0, c - w), Math.min(1, c + w)];
  }
  const fmtAns = (a) => (a == null || a === "" ? "no answer" : typeof a === "number" ? a.toLocaleString("en-US") : String(a));
  const fmtAccept = (acc) => {
    if (!acc) return "–";
    const parts = [];
    if (typeof acc.number === "number") parts.push(acc.number.toLocaleString("en-US", { maximumFractionDigits: 1 }));
    if (Array.isArray(acc.labels)) parts.push(...acc.labels);
    return parts.join(" or ") || "–";
  };

  // ---------- the numbers, from results.json ----------
  function stats(D) {
    const out = {};
    const paid = (m) => D.models && D.models[m] && D.models[m].group !== "free";
    // The privacy rate is shown only once the results file says it was scored with the corrected leak detector.
    const privacyReady = D.privacy_detector === "corrected" && Array.isArray(D.privacy);
    const exposure = D.exposure_median_chars || {};
    for (const c of CONDS) {
      const acc = (D.accuracy || []).filter((a) => a.condition === c);
      const k = acc.reduce((s, a) => s + a.correct, 0), n = acc.reduce((s, a) => s + a.n, 0);
      const priv = privacyReady ? D.privacy.filter((p) => p.condition === c) : [];
      const lk = priv.reduce((s, p) => s + p.leaked, 0), ln = priv.reduce((s, p) => s + p.n, 0);
      const costs = (D.efficiency || []).filter((e) => e.condition === c && paid(e.model) && e.cost_per_correct_usd > 0).map((e) => e.cost_per_correct_usd);
      out[c] = {
        acc: n ? { rate: k / n, ci: wilson(k, n), k, n, models: acc.length } : null,
        leak: privacyReady && ln ? { rate: lk / ln, ci: wilson(lk, ln), k: lk, n: ln } : null,
        sees: typeof exposure[c] === "number" ? exposure[c] : null,
        cost: costs.length ? { median: median(costs), min: Math.min(...costs), max: Math.max(...costs), models: costs.length } : null,
        failure: failure(D, c),
      };
    }
    return out;
  }
  function failure(D, c) {
    const wrong = (D.examples || []).filter((x) => x.runs && x.runs[c] && x.runs[c].correct === false);
    const pref = FAILURE_PREF[c] || [];
    const pick = pref.map(([t, q]) => wrong.find((x) => x.trap === t && x.question === q && x.runs[c].answer != null)).find(Boolean) || wrong.find((x) => x.runs[c].answer != null) || wrong[0];
    return pick ? { x: pick, run: pick.runs[c] } : { none: (D.examples || []).filter((x) => x.runs && x.runs[c]).length };
  }

  // ---------- drawing ----------
  function bar(rate, ci, cls) {
    const fill = h("span", { class: "cmp-fill f-" + cls });
    fill.style.setProperty("--r", String(rate));
    const whisk = ci ? h("span", { class: "cmp-ci" }) : null;
    // The interval is drawn as a fixed segment on the same 0 to 100 scale (static; never animated).
    if (whisk) { whisk.style.setProperty("--lo", String(ci[0])); whisk.style.setProperty("--hi", String(ci[1])); }
    return h("span", { class: "cmp-track", "aria-hidden": "true" }, fill, whisk);
  }
  const CELLS = [
    { key: "acc", label: "Accuracy against ground truth", sub: "pooled over every model, 95% interval; 0 to 100", cell(s, c) {
      if (!s.acc) return [h("p", { class: "cmp-na", text: "no runs yet" })];
      return [h("p", { class: "cmp-num" }, h("strong", { text: pct(s.acc.rate) }), h("span", { class: "cmp-sub", text: ` ${pct(s.acc.ci[0])} to ${pct(s.acc.ci[1])}` })), bar(s.acc.rate, s.acc.ci, CLS[c])];
    }, text: (s) => (s.acc ? `${pct(s.acc.rate)} (95% CI ${pct(s.acc.ci[0])} to ${pct(s.acc.ci[1])}), ${int(s.acc.k)} of ${int(s.acc.n)}` : "no runs yet") },
    { key: "leak", label: "Leaked what it was not allowed to share", sub: "privacy suite, pooled; lower is better; 0 to 100", cell(s, c) {
      if (!s.leak) return [h("p", { class: "cmp-na" }, h("span", { class: "pulse", "aria-hidden": "true" }), " measuring")];
      return [h("p", { class: "cmp-num" }, h("strong", { text: pct(s.leak.rate) }), h("span", { class: "cmp-sub", text: ` ${pct(s.leak.ci[0])} to ${pct(s.leak.ci[1])}` })), bar(s.leak.rate, s.leak.ci, CLS[c])];
    }, text: (s) => (s.leak ? `${pct(s.leak.rate)} (95% CI ${pct(s.leak.ci[0])} to ${pct(s.leak.ci[1])})` : "measuring") },
    { key: "sees", label: "What the agent sees per question", sub: "median characters of health data; one shared scale", cell(s, c, all) {
      if (s.sees == null) return [h("p", { class: "cmp-na", text: "not measured yet" })];
      const max = Math.max(...CONDS.map((k) => all[k].sees || 0), 1);
      return [h("p", { class: "cmp-num" }, h("strong", { text: int(s.sees) }), h("span", { class: "cmp-sub", text: " characters" })), bar(s.sees / max, null, CLS[c]), h("p", { class: "cmp-note", text: SEES_NOTE[c] })];
    }, text: (s, c) => (s.sees == null ? "not measured yet" : `${int(s.sees)} characters; ${SEES_NOTE[c]}`) },
    { key: "cost", label: "Cost per correct answer", sub: "median across paid models, with the range", cell(s) {
      if (!s.cost) return [h("p", { class: "cmp-na", text: "varies by model" })];
      return [h("p", { class: "cmp-num" }, h("strong", { text: usd(s.cost.median) })), h("p", { class: "cmp-note", text: `${usd(s.cost.min)} to ${usd(s.cost.max)} across ${s.cost.models} models` })];
    }, text: (s) => (s.cost ? `${usd(s.cost.median)} median (${usd(s.cost.min)} to ${usd(s.cost.max)})` : "varies by model") },
    { key: "fail", label: "A typical miss", sub: "a real run from the study", cell(s, c) {
      const f = s.failure;
      if (f.none != null) return [h("p", { class: "cmp-note", text: `None of the ${int(f.none)} example runs kept for this page was wrong; the accuracy row above counts every miss.` })];
      const q = QUESTIONS[f.x.question] || f.x.question.replace(/_/g, " ");
      return [
        h("p", { class: "cmp-fail-q" }, h("strong", { text: q }), h("span", { class: "cmp-sub", text: ` · ${TRAP[f.x.trap] || f.x.trap.replace(/_/g, " ")} · ${f.x.model}` })),
        h("p", { class: "cmp-fail-a" }, "Answered ", h("strong", { text: fmtAns(f.run.answer) }), "; the truth was ", h("strong", { text: fmtAccept(f.x.accept) }), "."),
      ];
    }, text: (s) => (s.failure.none != null ? "no wrong answer among the recorded examples" : `${QUESTIONS[s.failure.x.question] || s.failure.x.question}: answered ${fmtAns(s.failure.run.answer)}, truth ${fmtAccept(s.failure.x.accept)}`) },
  ];

  function takeaway(D, S) {
    const a = S.A_raw.acc, b = S.B_tools.acc, c = S.C_broker.acc;
    if (!a || !b || !c) return "Results are still coming in; the per-model page shows every run so far.";
    const models = new Set((D.accuracy || []).map((x) => x.model)).size;
    let t = `Pooled over ${models} models, agents answered ${pct(c.rate)} of questions correctly through AskWearables, against ${pct(a.rate)} with the raw export and ${pct(b.rate)} with open data tools.`;
    const frontier = (D.accuracy || []).filter((x) => D.models && D.models[x.model] && D.models[x.model].group === "frontier");
    // "Near the ceiling": a frontier model at 95% or better in every condition it ran.
    const byModel = new Map();
    for (const x of frontier) byModel.set(x.model, Math.min(byModel.has(x.model) ? byModel.get(x.model) : 1, x.rate));
    const top = [...byModel].filter(([, low]) => low >= 0.95).sort((p, q) => q[1] - p[1]);
    if (top.length) {
      const names = top.map(([m]) => m);
      const floor = Math.min(...top.map(([, low]) => low));
      t += ` The strongest frontier models (${names.length < 2 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]}) are near the ceiling in every condition, at ${pct(floor)} or better, so for them the difference is privacy and cost rather than accuracy.`;
    } else if (frontier.length) {
      t += ` No frontier model reaches the ceiling in every condition yet.`;
    }
    return t;
  }

  function table(S) {
    return h("div", { class: "table-wrap" }, h("table", { class: "stack" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Measure" }), CONDS.map((c) => h("th", { scope: "col", text: document.querySelector(`.cmp-col.cmp-${CLS[c]} .cmp-name`).textContent })))),
      h("tbody", {}, CELLS.map((row) => h("tr", {}, h("th", { scope: "row", text: row.label }),
        CONDS.map((c) => h("td", { "data-label": document.querySelector(`.cmp-col.cmp-${CLS[c]} .cmp-name`).textContent, text: row.text(S[c], c) })))))));
  }


  // ---------- the privacy leak chart: pooled leak rate per route, one shared 0 to 100 scale ----------
  function leakChart(S) {
    const body = document.getElementById("leak-body"), title = document.getElementById("leak-title"), btn = document.getElementById("leak-toggle");
    if (!body) return;
    const ready = CONDS.every((c) => S[c].leak);
    if (!ready) {
      if (title) title.textContent = "Privacy leaks: measuring with the corrected leak detector";
      body.replaceChildren(h("p", { class: "cmp-na" }, h("span", { class: "pulse", "aria-hidden": "true" }), " Measuring. The study is re-scoring the privacy suite with a corrected leak detector; this chart fills in when it lands."));
      return;
    }
    const name = (c) => document.querySelector(`.cmp-col.cmp-${CLS[c]} .cmp-name`).textContent;
    const best = [...CONDS].sort((a, b) => S[a].leak.rate - S[b].leak.rate)[0];
    if (title) title.textContent = `${name(best)} leaked least: ${pct(S[best].leak.rate)} of attempts`;
    const bars = h("div", { class: "leak-bars", role: "list" }, CONDS.map((c) => h("div", { class: "leak-row", role: "listitem" },
      h("p", { class: "leak-head" }, h("span", { class: "key" }, h("span", { class: "sw sw-" + CLS[c], "aria-hidden": "true" }), h("strong", { text: name(c) })),
        h("span", { class: "leak-val" }, h("strong", { text: pct(S[c].leak.rate) }), ` (${pct(S[c].leak.ci[0])} to ${pct(S[c].leak.ci[1])}), ${int(S[c].leak.k)} of ${int(S[c].leak.n)}`)),
      bar(S[c].leak.rate, S[c].leak.ci, CLS[c]))));
    const tbl = h("div", { class: "table-wrap", hidden: true }, h("table", {},
      h("thead", {}, h("tr", {}, ["Route", "Leaked", "95% interval", "Attempts"].map((t) => h("th", { scope: "col", text: t })))),
      h("tbody", {}, CONDS.map((c) => h("tr", {}, h("th", { scope: "row", text: name(c) }), h("td", { text: pct(S[c].leak.rate) }), h("td", { text: `${pct(S[c].leak.ci[0])} to ${pct(S[c].leak.ci[1])}` }), h("td", { text: int(S[c].leak.n) }))))));
    body.replaceChildren(bars, tbl);
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", () => { const on = btn.getAttribute("aria-pressed") !== "true"; btn.setAttribute("aria-pressed", String(on)); btn.textContent = on ? "Chart" : "Table"; tbl.hidden = !on; bars.hidden = on; });
    }
  }

  // The accuracy-vs-cost chart is drawn by results.js; its title states what the chart shows, from the same data.
  function costTitle(D) {
    const el = document.getElementById("cost-title");
    if (!el) return;
    const paid = (m) => D.models && D.models[m] && D.models[m].group !== "free";
    const by = new Map();
    for (const e of D.efficiency || []) if (paid(e.model) && e.cost_per_correct_usd > 0) (by.get(e.model) || by.set(e.model, {}).get(e.model))[e.condition] = e.cost_per_correct_usd;
    const both = [...by.values()].filter((v) => v.A_raw && v.C_broker);
    if (!both.length) return;
    const cheaper = both.filter((v) => v.C_broker < v.A_raw).length;
    el.textContent = `AskWearables cost less per correct answer than the raw export for ${cheaper} of ${both.length} paid models`;
  }

  function mount(D) {
    const grid = document.getElementById("cmp");
    if (!grid) return;
    const S = stats(D);
    const rows = CELLS.flatMap((row) => [
      h("div", { class: "cmp-rowhead", role: "rowheader" }, h("strong", { text: row.label }), h("span", { class: "cmp-sub", text: row.sub })),
      ...CONDS.map((c) => h("div", { class: `cmp-cell cmp-${CLS[c]}`, role: "cell" }, h("span", { class: "cmp-tag", text: document.querySelector(`.cmp-col.cmp-${CLS[c]} .cmp-name`).textContent }), ...row.cell(S[c], c, S))),
    ]);
    grid.querySelectorAll(".cmp-rowhead, .cmp-cell, .loading").forEach((e) => e.remove());
    grid.append(...rows);
    leakChart(S);
    costTitle(D);
    const take = document.getElementById("cmp-takeaway");
    if (take) take.textContent = takeaway(D, S);
    const holder = document.getElementById("cmp-table");
    const btn = document.getElementById("cmp-toggle");
    if (holder && btn) {
      holder.replaceChildren(table(S));
      btn.hidden = false;
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") !== "true";
        btn.setAttribute("aria-pressed", String(on));
        btn.textContent = on ? "Columns" : "Table";
        holder.hidden = !on;
        grid.hidden = on;
      });
    }
    const box = document.getElementById("compare");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) box.classList.add("in");
    else {
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { box.classList.add("in"); io.disconnect(); } }, { threshold: 0.15 });
      io.observe(grid);
    }
  }

  async function boot() {
    if (!document.getElementById("cmp")) return;
    try {
      mount(await (window.awResults || fetch("/data/results.json").then((r) => r.json())));
    } catch {
      const g = document.getElementById("cmp");
      g.querySelectorAll(".loading").forEach((e) => { e.textContent = "The study results could not be loaded. They are at /data/results.json."; });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
