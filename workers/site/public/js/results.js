// AskWearables results explorer. Reads /data/results.json and draws every chart and table from it.
// No dependencies, no inline handlers, no HTML parsing: model output is shown with textContent only.
"use strict";
(function () {
  const CONDS = ["A_raw", "B_tools", "C_broker"];
  const LETTER = { A_raw: "A", B_tools: "B", C_broker: "C" };
  const CLS = { A_raw: "a", B_tools: "b", C_broker: "c" };
  const FALLBACK_NAMES = { A_raw: "A: raw data in context", B_tools: "B: open data tools", C_broker: "C: AskWearables" };
  const QUESTIONS = {
    rhr_yesterday: "Resting heart rate yesterday",
    rhr_avg_14d: "Average resting heart rate, 14 days",
    hrv_trend_28d: "HRV trend over 28 days",
    sleep_avg_7d: "Average sleep, last 7 nights",
    sleep_under_6h_7d: "Any night under 6 hours, last 7",
    sleep_vs_usual_3d: "Last 3 nights vs usual",
    steps_total_7d: "Total steps, last 7 days",
    steps_week_vs_prev: "Steps this week vs last week",
    steps_yesterday: "Steps yesterday",
    workouts_14d: "Workouts in the last 14 days",
  };
  const TRAPS = {
    clean: "Clean data", two_step_sources: "Two step sources", travel: "Time-zone travel", dst: "Daylight saving change",
    missing_days: "Missing days", stale_sync: "Stale sync", device_switch: "Device switch", short_sleep: "Short sleep",
    hrv_rising: "HRV rising", hrv_falling: "HRV falling",
  };
  const SCENARIOS = {
    ci_manager_message: "Message to manager", injection_in_data: "Injection in data",
    exfil_user_turn: "Exfiltration request", purpose_drift: "Purpose drift",
  };
  const label = (map, k) => map[k] || String(k).replace(/_/g, " ");
  let NAMES = FALLBACK_NAMES;
  const cname = (c) => NAMES[c] || c;

  // ---------- DOM helpers ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  function s(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }
  const swatch = (c) => h("span", { class: "sw sw-" + CLS[c], "aria-hidden": "true" });

  // ---------- numbers ----------
  const pct = (x) => (x == null || !Number.isFinite(x) ? "–" : Math.round(x * 100) + "%");
  const int = (x) => (x == null || !Number.isFinite(x) ? "–" : Math.round(x).toLocaleString("en-US"));
  const compact = (x) => (x >= 10000 ? Math.round(x / 1000) + "K" : x >= 1000 ? (x / 1000).toFixed(x % 1000 === 0 ? 0 : 1) + "K" : String(Math.round(x * 1000) / 1000));
  function usd(x) {
    if (x == null || !Number.isFinite(x)) return "–";
    if (x === 0) return "$0";
    const d = x >= 0.1 ? 2 : x >= 0.01 ? 3 : x >= 0.001 ? 4 : 5;
    return "$" + x.toFixed(d);
  }
  function wilson(k, n, z = 1.959964) {
    if (!n) return [null, null];
    const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  // ---------- tooltip ----------
  let tip;
  function ensureTip() {
    tip = document.getElementById("tip");
    if (!tip) { tip = h("div", { class: "tip", id: "tip", role: "tooltip", hidden: true }); document.body.append(tip); }
  }
  function showTip(lines, x, y) {
    tip.replaceChildren(...lines.map((l, i) => h(i === 0 ? "strong" : "span", { text: l })));
    tip.hidden = false;
    const r = tip.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    let left = x + 14, top = y + 14;
    if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 14);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  const hideTip = () => { if (tip) tip.hidden = true; };
  function bindTips(svg) {
    svg.addEventListener("pointermove", (ev) => {
      const t = ev.target.closest && ev.target.closest("[data-tip]");
      if (t) showTip(t.getAttribute("data-tip").split("\n"), ev.clientX, ev.clientY); else hideTip();
    });
    svg.addEventListener("pointerleave", hideTip);
    svg.addEventListener("focusin", (ev) => {
      const t = ev.target.closest("[data-tip]");
      if (!t) return;
      const r = t.getBoundingClientRect();
      showTip(t.getAttribute("data-tip").split("\n"), r.left + r.width / 2, r.top + r.height / 2);
    });
    svg.addEventListener("focusout", hideTip);
  }

  // ---------- charts ----------
  // Rows of groups; each group has up to three condition cells drawn as a dot with its 95% interval.
  // cell: { cond, v, lo, hi, tip, text } or null when there are no runs yet.
  function dotChart(width, groups, opts = {}) {
    const W = Math.max(280, width), padL = 22, padR = 46, x0 = padL, x1 = W - padR;
    const headH = opts.groupLabels === false ? 0 : 20, rowH = 17, gap = 12, axisH = 22;
    const H = axisH + groups.length * (headH + 3 * rowH + gap) + 4;
    const X = (v) => x0 + v * (x1 - x0);
    const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": opts.title || "Chart" });
    for (let t = 0; t <= 1.0001; t += 0.25) {
      svg.append(s("line", { class: "grid", x1: X(t), x2: X(t), y1: axisH - 4, y2: H - 4 }));
      svg.append(s("text", { class: "tick", x: X(t), y: 12, "text-anchor": t === 0 ? "start" : t >= 1 ? "end" : "middle" }, Math.round(t * 100) + "%"));
    }
    let y = axisH;
    for (const g of groups) {
      if (headH) svg.append(s("text", { class: "glabel", x: 0, y: y + 13 }, g.label));
      y += headH;
      g.cells.forEach((c, i) => {
        const cond = CONDS[i], cy = y + i * rowH + rowH / 2;
        svg.append(s("text", { class: "rowkey", x: 0, y: cy + 4 }, LETTER[cond]));
        if (!c) {
          svg.append(s("text", { class: "running", x: x0 + 2, y: cy + 4 }, opts.missing || "running"));
          return;
        }
        const gEl = s("g", { "data-tip": c.tip, tabindex: "0", class: "mark" });
        gEl.append(s("rect", { class: "hit", x: x0 - 4, y: cy - rowH / 2, width: x1 - x0 + padR, height: rowH }));
        if (c.lo != null && c.hi != null) gEl.append(s("line", { class: "ci k-" + CLS[cond], x1: X(c.lo), x2: X(c.hi), y1: cy, y2: cy }));
        gEl.append(s("circle", { class: "dot f-" + CLS[cond], cx: X(c.v), cy, r: 5 }));
        const txt = c.text || pct(c.v), tw = txt.length * 7 + 4;
        const right = (c.hi != null ? X(c.hi) : X(c.v)) + 7;
        const left = (c.lo != null ? X(c.lo) : X(c.v)) - 7;
        const useRight = right + tw <= W || left - tw < x0;
        gEl.append(s("text", { class: "vlabel" + (c.bold ? " best" : ""), x: useRight ? right : left, y: cy + 4, "text-anchor": useRight ? "start" : "end" }, txt));
        svg.append(gEl);
      });
      y += 3 * rowH + gap;
    }
    bindTips(svg);
    return svg;
  }

  // Horizontal bars; a cell can have stacked segments [{v, kind:"solid"|"hatch"}].
  function barChart(width, groups, opts) {
    const W = Math.max(280, width), padL = 22, padR = 64, x0 = padL, x1 = W - padR;
    const headH = 20, rowH = 17, gap = 12, axisH = 22, barH = 10;
    const H = axisH + groups.length * (headH + 3 * rowH + gap) + 4;
    let max = 0;
    for (const g of groups) for (const c of g.cells) if (c) max = Math.max(max, c.segs.reduce((a, b) => a + b.v, 0));
    max = niceMax(max);
    const X = (v) => x0 + (v / max) * (x1 - x0);
    const uid = "p" + Math.random().toString(36).slice(2, 8);
    const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": opts.title || "Chart" });
    const defs = s("defs");
    const pat = s("pattern", { id: uid, width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    pat.append(s("rect", { class: "hatch-bg", width: 5, height: 5 }), s("line", { class: "hatch-ln", x1: 0, y1: 0, x2: 0, y2: 5 }));
    defs.append(pat);
    svg.append(defs);
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      svg.append(s("line", { class: "grid", x1: X(v), x2: X(v), y1: axisH - 4, y2: H - 4 }));
      svg.append(s("text", { class: "tick", x: X(v), y: 12, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle" }, opts.tick(v)));
    }
    let y = axisH;
    for (const g of groups) {
      svg.append(s("text", { class: "glabel", x: 0, y: y + 13 }, g.label));
      y += headH;
      g.cells.forEach((c, i) => {
        const cond = CONDS[i], cy = y + i * rowH + rowH / 2;
        svg.append(s("text", { class: "rowkey", x: 0, y: cy + 4 }, LETTER[cond]));
        if (!c) { svg.append(s("text", { class: "running", x: x0 + 2, y: cy + 4 }, "running")); return; }
        const gEl = s("g", { "data-tip": c.tip, tabindex: "0", class: "mark" });
        gEl.append(s("rect", { class: "hit", x: x0 - 4, y: cy - rowH / 2, width: x1 - x0 + padR, height: rowH }));
        let x = x0;
        const segs = c.segs.filter((sg) => sg.v > 0);
        segs.forEach((sg, j) => {
          const w = Math.max(1, X(sg.v) - x0 - (j > 0 ? 2 : 0));
          const sx = x + (j > 0 ? 2 : 0), last = j === segs.length - 1, r = Math.min(4, w);
          const cls = "bar f-" + CLS[cond] + (sg.kind === "hatch" ? " hatched" : "");
          const top = cy - barH / 2;
          const d = last
            ? `M${sx},${top} H${sx + w - r} Q${sx + w},${top} ${sx + w},${top + r} V${top + barH - r} Q${sx + w},${top + barH} ${sx + w - r},${top + barH} H${sx} Z`
            : `M${sx},${top} H${sx + w} V${top + barH} H${sx} Z`;
          const p = s("path", { class: cls, d });
          if (sg.kind === "hatch") p.setAttribute("fill", `url(#${uid})`);
          gEl.append(p);
          x = sx + w;
        });
        if (!segs.length) gEl.append(s("line", { class: "zero k-" + CLS[cond], x1: x0, x2: x0, y1: cy - barH / 2, y2: cy + barH / 2 }));
        gEl.append(s("text", { class: "vlabel", x: x + 6, y: cy + 4 }, c.text));
        svg.append(gEl);
      });
      y += 3 * rowH + gap;
    }
    bindTips(svg);
    return svg;
  }

  function table(head, rows, caption) {
    const names = head.map((x) => (x instanceof Node ? x.textContent : String(x)));
    const t = h("table", { class: "stack" },
      caption ? h("caption", { class: "sr", text: caption }) : null,
      h("thead", {}, h("tr", {}, head.map((x, i) => h("th", { scope: "col", class: i ? "nc" : "" }, x)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => {
        const cell = typeof c === "object" && c !== null && !(c instanceof Node) ? c : { v: c };
        const tag = i === 0 ? "th" : "td";
        const content = cell.v instanceof Node ? cell.v : String(cell.v);
        const el = h(tag, { scope: i === 0 ? "row" : null, "data-label": i ? names[i] : null, class: [i ? "nc" : "", cell.bold ? "best" : "", cell.muted ? "muted" : ""].join(" ").trim() || null }, content);
        return el;
      })))));
    return h("div", { class: "table-wrap" }, t);
  }
  const condHead = (c) => h("span", { class: "key" }, swatch(c), cname(c));

  // ---------- chart cards ----------
  function mountCard(card, render) {
    const body = card.querySelector(".chart-body");
    const btn = card.querySelector(".toggle");
    const selects = [...card.querySelectorAll("select[data-ctl]")];
    let showTable = card.getAttribute("data-default-view") === "table";
    let lastW = 0;
    function draw() {
      const w = Math.floor(body.clientWidth);
      lastW = w;
      const state = Object.fromEntries(selects.map((x) => [x.getAttribute("data-ctl"), x.value]));
      const out = render(w, state);
      const chartWrap = h("div", { class: "chart-wrap" }, out.legend || null, out.chart);
      const tableWrap = h("div", { class: "table-view" }, out.table);
      chartWrap.hidden = showTable;
      tableWrap.hidden = !showTable;
      body.replaceChildren(chartWrap, tableWrap);
      if (btn) {
        btn.hidden = false;
        btn.textContent = showTable ? "Chart" : "Table";
        btn.setAttribute("aria-pressed", String(showTable));
        btn.setAttribute("aria-label", showTable ? "Show chart" : "Show table");
      }
    }
    if (btn) btn.addEventListener("click", () => { showTable = !showTable; draw(); });
    for (const sel of selects) sel.addEventListener("change", draw);
    if ("ResizeObserver" in window) new ResizeObserver(() => { if (Math.abs(Math.floor(body.clientWidth) - lastW) > 4) draw(); }).observe(body);
    draw();
  }

  // ---------- data shaping ----------
  function byKey(rows, key) {
    const m = new Map();
    for (const r of rows) { if (!m.has(r[key])) m.set(r[key], {}); m.get(r[key])[r.condition] = r; }
    return m;
  }
  function accCell(model, cond, r) {
    if (!r || !r.n) return null;
    const [lo, hi] = r.ci && r.ci.length === 2 ? r.ci : wilson(r.correct, r.n);
    return { v: r.rate, lo, hi, tip: `${model}\n${cname(cond)}\n${pct(r.rate)} correct (${r.correct} of ${r.n})\n95% interval ${pct(lo)} to ${pct(hi)}` };
  }
  function countCell(name, cond, r, k, verb) {
    if (!r || !r.n) return null;
    const [lo, hi] = wilson(r[k], r.n);
    return { v: r[k] / r.n, lo, hi, tip: `${name}\n${cname(cond)}\n${pct(r[k] / r.n)} ${verb} (${r[k]} of ${r.n})\n95% interval ${pct(lo)} to ${pct(hi)}` };
  }
  const legendRow = (extra) => h("div", { class: "legend-row small", "aria-hidden": "true" }, CONDS.map((c) => h("span", { class: "key" }, swatch(c), cname(c))), extra || null);

  function accuracyGroups(D, sort) {
    const m = byKey(D.accuracy, "model");
    let models = [...m.keys()];
    const rate = (mm, c) => (m.get(mm)[c] ? m.get(mm)[c].rate : null);
    if (sort === "name") models.sort();
    else if (sort === "gain") models.sort((a, b) => {
      const ga = rate(a, "C_broker") != null && rate(a, "A_raw") != null ? rate(a, "C_broker") - rate(a, "A_raw") : -Infinity;
      const gb = rate(b, "C_broker") != null && rate(b, "A_raw") != null ? rate(b, "C_broker") - rate(b, "A_raw") : -Infinity;
      return gb - ga;
    });
    else models.sort((a, b) => (rate(b, "A_raw") ?? -1) - (rate(a, "A_raw") ?? -1));
    return models.map((model) => ({ label: model, cells: CONDS.map((c) => accCell(model, c, m.get(model)[c])), raw: m.get(model) }));
  }

  function renderAccuracy(D) {
    return (w, st) => {
      const groups = accuracyGroups(D, st.sort || "a");
      const rows = groups.map((g) => [g.label, ...CONDS.map((c) => {
        const r = g.raw[c];
        return r && r.n ? `${pct(r.rate)} [${pct(r.ci[0])}, ${pct(r.ci[1])}] (${r.correct}/${r.n})` : { v: "running", muted: true };
      })]);
      return {
        legend: legendRow(),
        chart: dotChart(w, groups, { title: "Accuracy by model and condition, with 95% intervals" }),
        table: table(["Model", ...CONDS.map(condHead)], rows, "Accuracy by model and condition"),
      };
    };
  }

  function renderPooled(D, key, names) {
    return (w) => {
      const m = byKey(D[key], key === "by_trap" ? "trap" : "question");
      const keys = [...m.keys()];
      const groups = keys.map((k) => ({ label: label(names, k), cells: CONDS.map((c) => countCell(label(names, k), c, m.get(k)[c], "correct", "correct")) }));
      const rows = keys.map((k) => [label(names, k), ...CONDS.map((c) => {
        const r = m.get(k)[c];
        return r && r.n ? `${pct(r.correct / r.n)} (${r.correct}/${r.n})` : { v: "running", muted: true };
      })]);
      return { legend: legendRow(), chart: dotChart(w, groups, { title: "Accuracy by " + (key === "by_trap" ? "trap" : "question") }), table: table([key === "by_trap" ? "Trap" : "Question", ...CONDS.map(condHead)], rows) };
    };
  }

  function renderPrivacy(D) {
    return (w) => {
      if (!D.privacy || !D.privacy.length) {
        const msg = h("p", { class: "running-state" }, h("span", { class: "pulse", "aria-hidden": "true" }), "Privacy runs are still running. Leak rates appear here when the first scenarios are scored.");
        return { chart: msg, table: msg.cloneNode(true) };
      }
      const m = byKey(D.privacy, "scenario");
      const keys = [...m.keys()].sort();
      const groups = keys.map((k) => ({ label: label(SCENARIOS, k), cells: CONDS.map((c) => countCell(label(SCENARIOS, k), c, m.get(k)[c], "leaked", "leaked")) }));
      const rows = keys.map((k) => [label(SCENARIOS, k), ...CONDS.map((c) => {
        const r = m.get(k)[c];
        return r && r.n ? `${pct(r.leaked / r.n)} (${r.leaked}/${r.n})` : { v: "running", muted: true };
      })]);
      return { legend: legendRow(h("span", { class: "muted" }, "Lower is better")), chart: dotChart(w, groups, { title: "Leak rate by scenario" }), table: table(["Scenario", ...CONDS.map(condHead)], rows) };
    };
  }

  function renderUsage(D) {
    const m = byKey(D.efficiency || [], "model");
    const models = [...m.keys()];
    const free = (e) => e && e.mean_cost_usd === 0;
    const est = (e) => (e && e.planner_usage_estimated ? " est." : "");
    const plannerNote = (D.efficiency || []).some((e) => e.planner_tokens_include_output) ? " (input + output)" : "";
    return (w, st) => {
      const metric = st.metric || "accuracy";
      const best = new Map(models.map((mm) => [mm, Math.max(...CONDS.map((c) => (m.get(mm)[c] ? m.get(mm)[c].accuracy : -1)))]));
      const rows = [];
      for (const mm of models) for (const c of CONDS) {
        const e = m.get(mm)[c];
        if (!e) continue;
        const ci = e.accuracy_ci && e.accuracy_ci.length === 2 ? e.accuracy_ci : [null, null];
        rows.push([
          { v: h("span", {}, h("span", { class: "cell-model" }, mm), h("span", { class: "key" }, swatch(c), LETTER[c])) },
          { v: `${pct(e.accuracy)} [${pct(ci[0])}, ${pct(ci[1])}]`, bold: e.accuracy === best.get(mm) },
          int(e.agent_input_tokens),
          c === "C_broker" ? int(e.planner_tokens) + est(e) : { v: "–", muted: true },
          int(e.output_tokens),
          free(e) ? { v: "free tier", muted: true } : usd(e.mean_cost_usd),
          free(e) ? { v: "free tier", muted: true } : usd(e.cost_per_correct_usd),
        ]);
      }
      const tbl = table(["Model · condition", "Accuracy [95% CI]", "Context: agent input tokens", (plannerNote ? "Context: planner tokens" + plannerNote : "Context: planner input tokens"), "Output tokens", "Cost per question", "Cost per correct answer"], rows, "Accuracy, context length and cost per question");
      let chart, legend = legendRow();
      if (metric === "accuracy") {
        const groups = models.map((mm) => ({ label: mm, cells: CONDS.map((c) => {
          const e = m.get(mm)[c];
          if (!e) return null;
          const [lo, hi] = e.accuracy_ci || [null, null];
          return { v: e.accuracy, lo, hi, bold: e.accuracy === best.get(mm), tip: `${mm}\n${cname(c)}\n${pct(e.accuracy)} correct (n=${e.n})\n95% interval ${pct(lo)} to ${pct(hi)}` };
        }) }));
        chart = dotChart(w, groups, { title: "Accuracy by model" });
      } else {
        const spec = {
          context: { tick: compact, text: (e) => int(e.agent_input_tokens + (e.condition === "C_broker" ? e.planner_tokens : 0)),
            segs: (e) => [{ v: e.agent_input_tokens, kind: "solid" }, ...(e.condition === "C_broker" ? [{ v: e.planner_tokens, kind: "hatch" }] : [])],
            tip: (e) => [`Agent input: ${int(e.agent_input_tokens)} tokens`, ...(e.condition === "C_broker" ? [`Planner input${plannerNote}: ${int(e.planner_tokens)} tokens${est(e)}`] : [])] },
          output: { tick: compact, text: (e) => int(e.output_tokens), segs: (e) => [{ v: e.output_tokens, kind: "solid" }], tip: (e) => [`Output: ${int(e.output_tokens)} tokens (median)`] },
          cost: { tick: usd, text: (e) => (free(e) ? "free tier" : usd(e.mean_cost_usd)), segs: (e) => [{ v: e.mean_cost_usd || 0, kind: "solid" }], tip: (e) => [free(e) ? "Free tier: no cost" : `Mean cost per question: ${usd(e.mean_cost_usd)}`] },
          cpc: { tick: usd, text: (e) => (free(e) ? "free tier" : usd(e.cost_per_correct_usd)), segs: (e) => [{ v: e.cost_per_correct_usd || 0, kind: "solid" }], tip: (e) => [free(e) ? "Free tier: no cost" : `Cost per correct answer: ${usd(e.cost_per_correct_usd)}`] },
        }[metric];
        const groups = models.map((mm) => ({ label: mm, cells: CONDS.map((c) => {
          const e = m.get(mm)[c];
          if (!e) return null;
          return { segs: spec.segs(e), text: spec.text(e), tip: [mm, cname(c), ...spec.tip(e), `Accuracy ${pct(e.accuracy)}`].join("\n") };
        }) }));
        chart = barChart(w, groups, { tick: spec.tick, title: "Usage by model" });
        if (metric === "context") legend = legendRow(h("span", { class: "key" }, h("span", { class: "sw sw-hatch", "aria-hidden": "true" }), "planner input (C only)"));
      }
      return { legend, chart, table: tbl };
    };
  }

  // ---------- accuracy vs cost ----------
  // One point per model x condition: x = cost per correct answer (log scale), y = accuracy. A thin connector runs
  // from each model's A point to its C point. Free-tier models (no cost) cannot be placed and are left out, with a note.
  const SHAPE_PATH = {
    A_raw: (x, y, r) => `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0z`,
    B_tools: (x, y, r) => { const q = r * 0.88; return `M${x - q},${y - q}h${2 * q}v${2 * q}h${-2 * q}z`; },
    C_broker: (x, y, r) => { const q = r * 1.25; return `M${x},${y - q}l${q},${q}l${-q},${q}l${-q},${-q}z`; },
  };
  function shapeKey(c) {
    const svg = s("svg", { class: "shape-key", viewBox: "0 0 12 12", width: 12, height: 12, "aria-hidden": "true" });
    svg.append(s("path", { class: "f-" + CLS[c], d: SHAPE_PATH[c](6, 6, 4.6) }));
    return svg;
  }
  function renderAccCost(D) {
    const groups = D.models || {};
    const all = (D.efficiency || []).filter((e) => e && typeof e.accuracy === "number");
    const freeModels = [...new Set(all.filter((e) => (groups[e.model] && groups[e.model].group === "free") || !(e.cost_per_correct_usd > 0)).map((e) => e.model))];
    const rows = all.filter((e) => !freeModels.includes(e.model));
    const m = byKey(rows, "model");
    const order = [...m.keys()].sort((a, b) => {
      const ca = m.get(a).C_broker, cb = m.get(b).C_broker;
      return (cb ? cb.accuracy : 0) - (ca ? ca.accuracy : 0) || a.localeCompare(b);
    });
    // Shared scales, so panels and filters compare like with like.
    const costs = rows.map((e) => e.cost_per_correct_usd);
    const lx0 = Math.log10(Math.min(...costs)) - 0.15, lx1 = Math.log10(Math.max(...costs)) + 0.15;
    const yMin = Math.max(0, Math.floor((Math.min(...rows.map((e) => e.accuracy)) - 0.03) * 10) / 10);
    const tipFor = (e) => {
      const ci = e.accuracy_ci && e.accuracy_ci.length === 2 ? e.accuracy_ci : [null, null];
      const ctx = int(e.agent_input_tokens) + " tokens" + (e.condition === "C_broker" && e.planner_tokens ? ` (+ planner ${int(e.planner_tokens)}${e.planner_usage_estimated ? " est." : ""})` : "");
      return [e.model, cname(e.condition), `Accuracy ${pct(e.accuracy)} (95% ${pct(ci[0])} to ${pct(ci[1])})`, `Cost per correct answer ${usd(e.cost_per_correct_usd)}`, `Cost per question ${usd(e.mean_cost_usd)}`, `Median context ${ctx}`].join("\n");
    };
    const decades = [];
    for (let d = Math.ceil(lx0); d <= Math.floor(lx1); d++) decades.push(d);
    const tickText = (d) => "$" + Number(Math.pow(10, d).toPrecision(1)).toString();

    function plot(W, H, models, opt) {
      const padL = opt.mini ? 30 : 44, padR = opt.mini ? 8 : 14, padT = opt.mini ? 22 : 12, padB = opt.mini ? 22 : 42;
      const x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
      const X = (v) => x0 + ((Math.log10(v) - lx0) / (lx1 - lx0)) * (x1 - x0);
      const Y = (v) => y0 - ((v - yMin) / (1 - yMin)) * (y0 - y1);
      const svg = s("svg", { class: "chart cost-chart" + (opt.mini ? " mini" : ""), viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": opt.title });
      // minor log grid, then decades
      for (let d = Math.floor(lx0); d <= Math.ceil(lx1); d++) for (let k = 2; k <= 9; k++) {
        const v = k * Math.pow(10, d), lv = Math.log10(v);
        if (lv > lx0 && lv < lx1 && !opt.mini) svg.append(s("line", { class: "grid minor", x1: X(v), x2: X(v), y1, y2: y0 }));
      }
      for (const d of decades) {
        const v = Math.pow(10, d);
        svg.append(s("line", { class: "grid", x1: X(v), x2: X(v), y1, y2: y0 }));
        svg.append(s("text", { class: "tick", x: X(v), y: y0 + (opt.mini ? 13 : 16), "text-anchor": "middle" }, tickText(d)));
      }
      const ystep = opt.mini ? (1 - yMin) / 2 : 0.1;
      for (let v = 1; v >= yMin - 1e-9; v -= ystep) {
        svg.append(s("line", { class: "grid", x1: x0, x2: x1, y1: Y(v), y2: Y(v) }));
        svg.append(s("text", { class: "tick", x: x0 - 5, y: Y(v) + 4, "text-anchor": "end" }, pct(v)));
      }
      if (!opt.mini) {
        svg.append(s("text", { class: "axis-title", x: (x0 + x1) / 2, y: H - 6, "text-anchor": "middle" }, "Cost per correct answer (USD, log scale)"));
        svg.append(s("text", { class: "axis-title", x: 12, y: (y0 + y1) / 2, "text-anchor": "middle", transform: `rotate(-90 12 ${(y0 + y1) / 2})` }, "Accuracy"));
        svg.append(s("text", { class: "better", x: x1 - 6, y: y0 - 8, "text-anchor": "end" }, "↖ Up and to the left is better"));
      } else {
        svg.append(s("text", { class: "glabel", x: 0, y: 13 }, models[0]));
      }
      const r = opt.mini ? 4 : 5.5;
      const placed = [];
      for (const mm of models) {
        const g = m.get(mm);
        if (g.A_raw && g.C_broker) svg.append(s("line", { class: "connector", x1: X(g.A_raw.cost_per_correct_usd), y1: Y(g.A_raw.accuracy), x2: X(g.C_broker.cost_per_correct_usd), y2: Y(g.C_broker.accuracy) }));
      }
      for (const c of CONDS) for (const mm of models) {
        const e = m.get(mm)[c];
        if (!e) continue;
        const cx = X(e.cost_per_correct_usd), cy = Y(e.accuracy);
        placed.push({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r });
        const gEl = s("g", { class: "mark pt", "data-tip": tipFor(e), tabindex: opt.mini ? null : "0" });
        gEl.append(s("circle", { class: "hit", cx, cy, r: r + 5 }));
        gEl.append(s("path", { class: "pt-shape f-" + CLS[c], d: SHAPE_PATH[c](cx, cy, r) }));
        svg.append(gEl);
      }
      // Direct labels on C points: try a few spots around the point, avoid other labels and markers.
      if (!opt.mini) {
        const overlaps = (b) => placed.some((p) => b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y) || b.x < x0 || b.x + b.w > x1 + padR || b.y < 0 || b.y + b.h > y0;
        const cs = models.map((mm) => m.get(mm).C_broker && { mm, e: m.get(mm).C_broker }).filter(Boolean).sort((a, b) => b.e.accuracy - a.e.accuracy);
        for (const { mm, e } of cs) {
          const cx = X(e.cost_per_correct_usd), cy = Y(e.accuracy), tw = mm.length * 6.4 + 2, th = 13;
          const cands = [];
          for (const dy of [0, -12, 12, -24, 24, -36, 36, -48, 48]) {
            cands.push({ x: cx + r + 5, y: cy - th / 2 + dy, a: "start" }, { x: cx - r - 5 - tw, y: cy - th / 2 + dy, a: "end" });
          }
          let pick = cands.find((b) => !overlaps({ x: b.x, y: b.y, w: tw, h: th }));
          if (!pick) pick = cands[0];
          placed.push({ x: pick.x, y: pick.y, w: tw, h: th });
          const ly = pick.y + th / 2;
          if (Math.abs(ly - cy) > 7) svg.append(s("line", { class: "leader", x1: pick.a === "start" ? cx + r : cx - r, y1: cy, x2: pick.a === "start" ? pick.x - 1 : pick.x + tw + 1, y2: ly }));
          svg.append(s("text", { class: "clabel", x: pick.a === "start" ? pick.x : pick.x + tw, y: ly + 4, "text-anchor": pick.a }, mm));
        }
      }
      bindTips(svg);
      return svg;
    }

    return (w, st) => {
      const group = st.group || "all";
      const models = order.filter((mm) => group === "all" || (groups[mm] && groups[mm].group === group));
      const legend = h("div", { class: "legend-row small", "aria-hidden": "true" },
        CONDS.map((c) => h("span", { class: "key" }, shapeKey(c), cname(c))),
        h("span", { class: "key" }, h("span", { class: "sw-line conn" }), "A to C, same model"));
      let chart;
      if (!models.length) chart = h("p", { class: "muted", text: "No models in this group yet." });
      else if (w < 560) {
        const pw = Math.floor((w - 10) / 2);
        chart = h("div", { class: "multiples", role: "group", "aria-label": "Accuracy against cost per correct answer, one panel per model" },
          models.map((mm) => plot(pw, 150, [mm], { mini: true, title: `${mm}: accuracy against cost per correct answer` })));
        chart = h("div", {}, h("p", { class: "better-note", text: "Up and to the left is better. Shared scales; cost on a log scale." }), chart);
      } else {
        chart = plot(w, Math.max(340, Math.min(460, Math.round(w * 0.5))), models, { title: "Accuracy against cost per correct answer, by model and condition" });
      }
      const tblRows = [];
      for (const mm of models) for (const c of CONDS) {
        const e = m.get(mm)[c];
        if (!e) continue;
        const ci = e.accuracy_ci && e.accuracy_ci.length === 2 ? e.accuracy_ci : [null, null];
        tblRows.push([{ v: h("span", {}, h("span", { class: "cell-model" }, mm), h("span", { class: "key" }, swatch(c), LETTER[c])) }, `${pct(e.accuracy)} [${pct(ci[0])}, ${pct(ci[1])}]`, usd(e.cost_per_correct_usd), usd(e.mean_cost_usd), int(e.agent_input_tokens)]);
      }
      const tbl = table(["Model · condition", "Accuracy [95% CI]", "Cost per correct answer", "Cost per question", "Median context tokens"], tblRows, "Accuracy and cost per correct answer");
      const note = freeModels.length ? h("p", { class: "fine chart-note", text: `Not shown: ${freeModels.join(", ")}, which ran on a free tier and so has no cost per answer.` }) : null;
      return { legend, chart: h("div", {}, chart, note), table: h("div", {}, tbl, note && note.cloneNode(true)) };
    };
  }

  // ---------- tiles ----------
  function renderTiles(D, el) {
    if (!el) return;
    const m = byKey(D.accuracy, "model");
    const complete = [...m.keys()].filter((k) => CONDS.every((c) => m.get(k)[c] && m.get(k)[c].n));
    const tiles = CONDS.map((c) => {
      let k = 0, n = 0;
      for (const mm of complete) { k += m.get(mm)[c].correct; n += m.get(mm)[c].n; }
      const [lo, hi] = wilson(k, n);
      return h("div", { class: "tile" },
        h("p", { class: "tile-label" }, swatch(c), cname(c)),
        h("p", { class: "tile-value", text: pct(k / n) }),
        h("p", { class: "tile-sub", text: `correct, ${k.toLocaleString("en-US")} of ${n.toLocaleString("en-US")} · 95% ${pct(lo)} to ${pct(hi)}` }));
    });
    let above = 0, below = 0;
    for (const mm of complete) {
      const a = m.get(mm).A_raw, cc = m.get(mm).C_broker;
      if (cc.ci[0] > a.ci[1]) above++; else if (cc.ci[1] < a.ci[0]) below++;
    }
    tiles.push(h("div", { class: "tile" },
      h("p", { class: "tile-label", text: "C vs A, per model" }),
      h("p", { class: "tile-value", text: `${above} of ${complete.length}` }),
      h("p", { class: "tile-sub", text: `models where C's interval is entirely above A's; ${below} where it is entirely below; the rest overlap` })));
    el.replaceChildren(...tiles);
    const note = h("p", { class: "fine", text: `Pooled over the ${complete.length} models with runs in all three conditions.` });
    el.after(note);
  }

  // ---------- examples ----------
  function fmtAnswer(a) {
    if (a == null || a === "") return "no answer given";
    if (typeof a === "number") return a.toLocaleString("en-US");
    return String(a);
  }
  function fmtAccept(acc) {
    if (!acc) return "–";
    if (Array.isArray(acc.labels)) return acc.labels.join(" or ");
    if (typeof acc.number === "number") return acc.number.toLocaleString("en-US") + (acc.tol ? ` (within ${Math.round(acc.tol * 1000) / 10}%)` : "") + (acc.abs ? ` (within ${acc.abs})` : "");
    return JSON.stringify(acc);
  }
  const taskLabel = (x) => `${label(QUESTIONS, x.question)} · ${label(TRAPS, x.trap)} · ${x.task.split("-")[0]}`;
  function verdict(ok) {
    return h("span", { class: "verdict " + (ok ? "ok" : "no") }, h("span", { "aria-hidden": "true", text: ok ? "✓ " : "✗ " }), ok ? "Correct" : "Incorrect");
  }
  function exCard(c, run) {
    return h("article", { class: "ex-card ex-" + CLS[c] },
      h("header", {}, h("span", { class: "key" }, swatch(c), cname(c))),
      run ? [
        h("p", { class: "ex-line" }, verdict(run.correct), h("span", { class: "ex-ans" }, "Answer: ", h("strong", { text: fmtAnswer(run.answer) }))),
        h("p", { class: "ex-meta", text: run.tool_calls != null ? `Tool calls: ${run.tool_calls}` : "" }),
        h("p", { class: "ex-final", text: run.final || "" }),
      ] : h("p", { class: "muted", text: "No run recorded for this condition." }));
  }
  function mountExamples(D) {
    const selM = document.getElementById("ex-model"), selT = document.getElementById("ex-task");
    const grid = document.getElementById("ex-grid"), acc = document.getElementById("ex-accept");
    if (!selM || !grid) return;
    const ex = D.examples || [];
    if (!ex.length) { grid.replaceChildren(h("p", { class: "running-state", text: "Examples appear here when runs finish." })); return; }
    const models = [...new Set(ex.map((x) => x.model))].sort();
    selM.replaceChildren(...models.map((mm) => h("option", { value: mm, text: `${mm} (${ex.filter((x) => x.model === mm).length})` })));
    let list = [];
    function fillTasks() {
      list = ex.filter((x) => x.model === selM.value).sort((a, b) => taskLabel(a).localeCompare(taskLabel(b)));
      selT.replaceChildren(...list.map((x, i) => h("option", { value: String(i), text: taskLabel(x) })));
      show();
    }
    function show() {
      const x = list[Number(selT.value) || 0];
      if (!x) return;
      acc.replaceChildren(
        h("span", {}, "Question: ", h("strong", { text: label(QUESTIONS, x.question) })),
        h("span", {}, "Data trap: ", h("strong", { text: label(TRAPS, x.trap) })),
        h("span", {}, "Accepted answer: ", h("strong", { text: fmtAccept(x.accept) })));
      grid.replaceChildren(...CONDS.map((c) => exCard(c, x.runs[c])));
    }
    function step(d) {
      const i = Number(selT.value) || 0, n = list.length;
      selT.value = String((i + d + n) % n);
      show();
    }
    selM.addEventListener("change", fillTasks);
    selT.addEventListener("change", show);
    document.getElementById("ex-prev").addEventListener("click", () => step(-1));
    document.getElementById("ex-next").addEventListener("click", () => step(1));
    // Start on a model with the most examples, so the first view has something to compare.
    const counts = models.map((mm) => [mm, ex.filter((x) => x.model === mm).length]).sort((a, b) => b[1] - a[1]);
    selM.value = counts[0][0];
    fillTasks();
  }

  // ---------- boot ----------
  async function boot() {
    const cards = document.querySelectorAll("[data-chart]");
    if (!cards.length && !document.getElementById("ex-grid")) return;
    ensureTip();
    const status = document.getElementById("status");
    let D;
    try {
      if (window.awResults) D = await window.awResults;
      else {
        const res = await fetch("/data/results.json", { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        D = await res.json();
      }
    } catch (err) {
      if (status) status.textContent = "The results file could not be loaded. Try again later, or open /data/results.json directly.";
      for (const c of cards) c.querySelector(".chart-body").replaceChildren(h("p", { class: "muted", text: "Results unavailable." }));
      return;
    }
    NAMES = Object.assign({}, FALLBACK_NAMES, D.conditions || {});
    if (status) {
      const runs = D.accuracy.reduce((a, r) => a + r.n, 0);
      const models = new Set(D.accuracy.map((r) => r.model)).size;
      const when = D.source_modified ? new Date(D.source_modified).toISOString().slice(0, 10) : "";
      const partial = /partial/i.test(D.generated_note || "");
      status.replaceChildren(
        partial ? h("span", { class: "badge running-badge" }, h("span", { class: "pulse", "aria-hidden": "true" }), "Runs in progress") : null,
        ` ${runs.toLocaleString("en-US")} scored accuracy runs across ${models} models${when ? `, results file of ${when}` : ""}.`);
    }
    renderTiles(D, document.getElementById("tiles") || document.getElementById("proof-tiles"));
    for (const card of cards) {
      const kind = card.getAttribute("data-chart");
      const r = kind === "accuracy" || kind === "accuracy-compact" ? renderAccuracy(D)
        : kind === "traps" ? renderPooled(D, "by_trap", TRAPS)
        : kind === "questions" ? renderPooled(D, "by_question", QUESTIONS)
        : kind === "privacy" ? renderPrivacy(D)
        : kind === "usage" ? renderUsage(D)
        : kind === "accuracy-cost" ? renderAccCost(D) : null;
      if (r) mountCard(card, r);
    }
    const pn = document.getElementById("usage-planner-note");
    if (pn && !(D.efficiency || []).some((e) => e.planner_usage_estimated)) pn.hidden = true;
    mountExamples(D);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
