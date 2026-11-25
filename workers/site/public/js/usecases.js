// "What people ask": fills each scenario card from /data/usecases.json, which scripts/build-usecases.ts writes by
// running the real engine (gate, compute, packet builder) on the study's synthetic people. Every figure, level,
// statement and denial reason on the cards comes from that file; the page markup holds only the words people use.
"use strict";
(function () {
  const LEVEL = { 0: "flag", 1: "trend", 2: "daily", 3: "raw" };
  const METRIC = { steps: "steps", hrv_rmssd: "HRV", sleep_duration: "sleep", resting_hr: "resting heart rate", weight: "weight" };
  const PURPOSE = { scheduling: "scheduling", training_advice: "training advice", sleep_coaching: "sleep coaching", general_wellness: "general wellness", personal_research: "personal research" };
  // Display names for the signals a card touches, and the order the device view cycles through them.
  const SIGNAL = { sleep_duration: "Sleep", sleep_stages: "Sleep stages", hrv_rmssd: "HRV", resting_hr: "Resting HR", steps: "Steps", workout: "Workouts", weight: "Weight", spo2: "Blood oxygen", respiratory_rate: "Respiratory rate" };
  const OP = { compare_to_baseline: "compare to baseline", trend: "trend", latest: "latest", aggregate: "aggregate", threshold_check: "threshold check", compare_periods: "compare periods" };

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const icon = (name) => h("span", { class: "ico ico-" + name, "aria-hidden": "true" });
  const metricName = (m) => METRIC[m] || String(m).replace(/_/g, " ");
  const weekday = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const longDay = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  const list = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

  function grantChip(g) {
    return `${PURPOSE[g.purpose] || g.purpose} grant: ${g.metrics.map(metricName).join(", ")}, up to level ${g.max_level}`;
  }

  function packetCard(ask) {
    const r = ask.response || {};
    const spec = ask.spec || {};
    const op = h("span", { class: "pk-op", text: `${OP[spec.operation] || spec.operation} · ${spec.metrics.map(metricName).join(", ")}` });
    const receipt = r.receipt_id ? h("p", { class: "pk-foot" }, icon("receipt"), h("span", {}, "Receipt ", h("code", { class: "pk-id", title: r.receipt_id, text: r.receipt_id.slice(0, 10) + "…" }))) : null;
    if (r.status !== "ok" || !r.packet) {
      return h("div", { class: "pk pk-denied" },
        h("div", { class: "pk-head" }, h("span", { class: "pk-level pk-no", text: r.status === "unsupported" ? "Unsupported" : "Denied" }), op),
        h("p", { class: "pk-finding", text: "Nothing released." }),
        h("ul", { class: "pk-reasons", "aria-label": "Reasons" }, (r.reasons || []).map((x) => h("li", {}, h("code", { text: x })))),
        receipt);
    }
    const p = r.packet;
    return h("div", { class: "pk" },
      h("div", { class: "pk-head" }, h("span", { class: "pk-level", text: `Level ${p.level} · ${LEVEL[p.level] || "?"}` }), op),
      (p.findings || []).map((f) => h("p", { class: "pk-finding", text: f.statement })),
      receipt);
  }

  function week(c) {
    const box = h("div", { class: "week-grid" });
    const rows = { resting_hr: [], hrv_rmssd: [] };
    for (const a of c.asks) {
      const m = a.spec.metrics[0];
      const f = a.response.packet && a.response.packet.findings[0];
      if (rows[m]) rows[m].push({ day: a.spec.window.start, dir: f ? f.direction : "unknown", mag: f ? f.magnitude : "unknown", text: f ? f.statement : (a.response.reasons || []).join(", ") });
    }
    box.append(h("span", { class: "wk-corner" }), ...(c.days || []).map((d) => h("span", { class: "wk-day", text: weekday(d) })));
    for (const [m, label] of [["resting_hr", "Resting HR"], ["hrv_rmssd", "HRV"]]) {
      box.append(h("span", { class: "wk-label", text: label }),
        ...rows[m].map((x) => h("span", { class: `wk-cell wk-${["above", "below", "within"].includes(x.dir) ? x.dir : "unknown"} wk-${x.mag}`, title: `${longDay(x.day)}: ${x.text}` })));
    }
    const hiRhr = rows.resting_hr.filter((x) => x.dir === "above").map((x) => x.day);
    const loHrv = rows.hrv_rmssd.filter((x) => x.dir === "below").map((x) => x.day);
    const both = hiRhr.filter((d) => loHrv.includes(d));
    const days = (xs) => list(xs.map(weekday));
    let summary = hiRhr.length
      ? `Your resting heart rate ran above your usual range on ${days(hiRhr)}`
      : "Your resting heart rate stayed inside or below your usual range all week";
    summary += loHrv.length ? `, and your HRV ran below your usual range on ${days(loHrv)}.` : ".";
    if (both.length) summary += ` ${days(both)} had both, so ${both.length > 1 ? "those days" : "that day"} may be worth a lighter plan and an earlier night.`;
    return { grid: box, summary };
  }


  // ---------- chips: the signals each card touched, and what was released ----------
  function chips(c) {
    const seen = new Map();
    for (const a of c.asks) for (const m of a.spec.metrics) {
      const denied = a.response.status !== "ok";
      seen.set(m, (seen.get(m) || { denied: true }).denied && denied ? { denied: true } : { denied: false });
    }
    const levels = c.asks.filter((a) => a.response.packet).map((a) => a.response.packet.level);
    const out = [...seen].map(([m, v]) => h("span", { class: "chip chip-sig" + (v.denied ? " chip-denied" : ""), "data-metric": m, text: SIGNAL[m] || m.replace(/_/g, " ") }));
    if (levels.length) { const top = Math.max(...levels); out.push(h("span", { class: "chip chip-level", text: `Level ${top} · ${LEVEL[top]}` })); }
    if (c.asks.some((a) => a.response.status !== "ok")) out.push(h("span", { class: "chip chip-no", text: "Denied" }));
    return out;
  }

  // ---------- the hero device: one well-synced person's own watch, ring and band ----------
  // Every value comes from usecases.json "device", which the engine computed for that person's own view.
  const SVGNS = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v)); return e; };
  const hm = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}`;
  const SCREENS = [
    { key: "activity", label: "Activity", metrics: ["steps", "sleep_duration"] },
    { key: "sleep", label: "Sleep", metrics: ["sleep_duration"] },
    { key: "resting_hr", label: "Resting HR", metrics: ["resting_hr"] },
    { key: "hrv", label: "HRV", metrics: ["hrv_rmssd"] },
    { key: "workout", label: "Workouts", metrics: ["workout"] },
    { key: "vitals", label: "Night vitals", metrics: ["spo2", "respiratory_rate", "skin_temp_deviation"] },
  ];
  const WEARS = [
    ["Ring", ["sleep_duration", "hrv_rmssd", "skin_temp_deviation", "spo2"]],
    ["Band", ["steps", "resting_hr", "respiratory_rate"]],
  ];
  const SIGNAL_SHORT = { skin_temp_deviation: "Temperature", spo2: "SpO2", respiratory_rate: "Breathing" };
  function badge(usual) {
    if (!usual || !usual.direction || usual.direction === "unknown") return h("span", { class: "fbadge fb-none" }, h("span", { class: "nd-ico", "aria-hidden": "true" }), "no usual yet");
    if (usual.direction === "within") return h("span", { class: "fbadge fb-within", text: "within usual" });
    return h("span", { class: "fbadge fb-off", title: `${usual.magnitude && usual.magnitude !== "none" ? usual.magnitude + "ly " : ""}${usual.direction} the usual range`, text: `${usual.direction === "above" ? "↗" : "↘"} ${usual.direction} usual` });
  }
  function noData() { return h("div", { class: "fscreen fs-empty" }, h("span", { class: "nd-ico big", "aria-hidden": "true" }), h("p", { class: "fs-label", text: "No data" })); }
  function spark(week, cls) {
    const vals = week.map((w) => w.value);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * 100},${26 - ((v - lo) / span) * 22}`).join(" ");
    const svg = sv("svg", { class: "fspark " + cls, viewBox: "0 0 100 30", preserveAspectRatio: "none", "aria-hidden": "true" });
    svg.append(sv("polyline", { points: pts, fill: "none", "vector-effect": "non-scaling-stroke" }));
    const last = pts.split(" ").pop().split(",");
    svg.append(sv("circle", { cx: last[0], cy: last[1], r: 3, "vector-effect": "non-scaling-stroke" }));
    return svg;
  }
  function arc(frac, r, cls) {
    const c = 2 * Math.PI * r;
    return sv("circle", { class: "farc " + cls, cx: 50, cy: 50, r, "stroke-dasharray": `${(Math.max(0.02, Math.min(1, frac)) * c).toFixed(1)} ${c.toFixed(1)}`, transform: "rotate(-90 50 50)" });
  }
  function screen(key, S) {
    const day = (d) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) : "");
    if (key === "activity") {
      const st = S.steps, sl = S.sleep_duration;
      if (!st || !sl) return noData();
      const maxSt = Math.max(...st.week.map((w) => w.value)), maxSl = Math.max(...sl.week.map((w) => w.value));
      const rings = sv("svg", { class: "frings", viewBox: "0 0 100 100", "aria-hidden": "true" });
      rings.append(sv("circle", { class: "farc-bg a1", cx: 50, cy: 50, r: 42 }), arc(st.value / maxSt, 42, "a1"), sv("circle", { class: "farc-bg a2", cx: 50, cy: 50, r: 31 }), arc(sl.value / maxSl, 31, "a2"));
      return h("div", { class: "fscreen fs-activity" }, h("p", { class: "fs-label", text: "Activity" }), rings,
        h("p", { class: "fs-val" }, Math.round(st.value).toLocaleString("en-US"), h("span", { class: "fs-u", text: " steps" })),
        h("p", { class: "fs-sub", text: `${hm(sl.value)} sleep` }), h("p", { class: "fs-foot", text: day(st.day) }));
    }
    if (key === "vitals") {
      const rows = [["spo2", "SpO2", (v) => `${v}%`], ["respiratory_rate", "Breath", (v) => `${v}`], ["skin_temp_deviation", "Temp", (v) => `${v > 0 ? "+" : ""}${v}°C`]]
        .filter(([m]) => S[m]);
      if (!rows.length) return noData();
      const mark = (u) => {
        if (!u || !u.direction || u.direction === "unknown") return h("span", { class: "fv-dir", title: "no usual yet", text: "·" });
        if (u.direction === "within") return h("span", { class: "fv-dir fv-in", title: "within your usual range", text: "●" });
        return h("span", { class: "fv-dir fv-off", title: `${u.direction} your usual range`, text: u.direction === "above" ? "↗" : "↘" });
      };
      return h("div", { class: "fscreen fs-vitals" }, h("p", { class: "fs-label", text: "Vitals" }),
        ...rows.map(([m, lab, f]) => h("p", { class: "fv-row" }, h("span", { class: "fv-lab", text: lab }), h("span", { class: "fv-val", text: f(S[m].value) }), mark(S[m].usual))),
        h("p", { class: "fs-foot", text: "● usual  ↘ low  ↗ high" }));
    }
    if (key === "sleep") {
      const sl = S.sleep_duration;
      if (!sl) return noData();
      const bar = h("span", { class: "fstages" });
      const st = sl.stages || {};
      for (const [k, cls, lab] of [["deep_min", "deep", "Deep"], ["rem_min", "rem", "REM"], ["light_min", "light", "Light"], ["awake_min", "awake", "Awake"]]) {
        if (!st[k]) continue;
        const seg = h("span", { class: "stg stg-" + cls, title: `${lab}: ${st[k]} min` });
        seg.style.flexGrow = String(st[k]);
        bar.append(seg);
      }
      return h("div", { class: "fscreen" }, h("p", { class: "fs-label", text: "Sleep" }), h("p", { class: "fs-val", text: hm(sl.value) }),
        sl.stages ? [bar, h("p", { class: "fs-key" }, ...["deep", "rem", "light"].map((c) => h("span", { class: "k-" + c, text: c === "rem" ? "REM" : c })))] : null, badge(sl.usual));
    }
    if (key === "resting_hr" || key === "hrv") {
      const m = key === "hrv" ? "hrv_rmssd" : "resting_hr", r = S[m];
      if (!r) return noData();
      return h("div", { class: "fscreen" }, h("p", { class: "fs-label", text: key === "hrv" ? "HRV" : "Resting HR" }),
        h("p", { class: "fs-val" }, String(m === "hrv_rmssd" ? r.value : Math.round(r.value)), h("span", { class: "fs-u", text: m === "hrv_rmssd" ? " ms" : " bpm" })),
        spark(r.week, key), h("p", { class: "fs-foot", text: "7 days" }), badge(r.usual));
    }
    if (key === "workout") {
      const w = S.workout;
      if (!w) return noData();
      const max = Math.max(...w.week.map((x) => x.value), 1);
      const bars = h("span", { class: "fbars" }, w.week.map((x) => { const b = h("span", { class: "fbar" + (x.value ? "" : " zero") }); b.style.setProperty("--v", String(Math.max(0.06, x.value / max))); return b; }));
      const active = w.week.filter((x) => x.value > 0).length;
      return h("div", { class: "fscreen" }, h("p", { class: "fs-label", text: "Workouts" }), h("p", { class: "fs-val", text: hm(w.value) }), bars, h("p", { class: "fs-foot", text: `${active} active ${active === 1 ? "day" : "days"} this week` }));
    }
    return noData();
  }
  function mountDevice(D) {
    const stage = document.getElementById("stage"), sigEl = document.getElementById("signals"), face = document.getElementById("face");
    const dev = D.device;
    if (!stage || !sigEl || !face || !dev || !dev.signals) return;
    const S = dev.signals;
    const f = (n) => stage.querySelector(`[data-f="${n}"]`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const toggle = document.getElementById("stage-toggle");
    // Which cards used each signal, and at what level, for the caption and the highlight.
    const users = (metrics) => Object.entries(D.cases || {}).filter(([, c]) => c.asks.some((a) => a.spec.metrics.some((m) => metrics.includes(m)))).map(([key, c]) => {
      const lv = c.asks.filter((a) => a.response.packet && a.spec.metrics.some((m) => metrics.includes(m))).map((a) => a.response.packet.level);
      const name = document.querySelector(`.uc[data-uc="${key}"] .uc-agent`);
      return { key, name: name ? name.firstChild.textContent.trim().toLowerCase() : key, level: lv.length ? Math.max(...lv) : null };
    });
    // The ring and the band: what each wears, lit when the current screen uses it; absent signals say so.
    const legend = f("legend");
    if (legend) legend.replaceChildren(...WEARS.map(([dname, ms]) => h("span", { class: "wear" }, h("strong", { text: dname }),
      ...ms.map((m) => (S[m] ? h("span", { class: "chip chip-sig", "data-metric": m, text: SIGNAL_SHORT[m] || SIGNAL[m] || m })
        : h("span", { class: "chip chip-nodata", title: "Not recorded for this person" }, h("span", { class: "nd-ico", "aria-hidden": "true" }), `${SIGNAL_SHORT[m] || SIGNAL[m] || m} · no data`))))));
    const btns = SCREENS.map((sc, i) => {
      const b = h("button", { type: "button", role: "tab", class: "signal", "aria-selected": "false", tabindex: "-1", text: sc.label });
      b.addEventListener("click", () => select(i, true));
      return b;
    });
    sigEl.replaceChildren(...btns);
    sigEl.addEventListener("keydown", (ev) => {
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      const j = ev.key === "ArrowRight" ? (i + 1) % btns.length : ev.key === "ArrowLeft" ? (i - 1 + btns.length) % btns.length : -1;
      if (j < 0) return;
      ev.preventDefault(); btns[j].focus(); select(j, true);
    });
    let cur = 0, timers = [], playing = true, onScreen = true;
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    function rail(at) { stage.setAttribute("data-at", String(at)); stage.querySelectorAll(".rail-node").forEach((el, k) => { el.classList.toggle("on", at >= 0 && k <= at); el.classList.toggle("cur", k === at); }); }
    function select(i) {
      clear();
      cur = i;
      const sc = SCREENS[i];
      btns.forEach((b, k) => { b.setAttribute("aria-selected", String(k === i)); b.tabIndex = k === i ? 0 : -1; });
      const scr = screen(sc.key, S);
      face.replaceChildren(scr);
      face.classList.remove("enter");
      if (!reduce.matches) { void face.offsetWidth; face.classList.add("enter"); }
      const u = users(sc.metrics);
      document.querySelectorAll(".uc").forEach((card) => card.classList.toggle("fed", u.some((x) => x.key === card.getAttribute("data-uc"))));
      document.querySelectorAll(".chip-sig").forEach((ch) => ch.classList.toggle("on", sc.metrics.includes(ch.getAttribute("data-metric"))));
      const used = u.map((x) => `the ${x.name}${x.level != null ? ` (level ${x.level}, ${LEVEL[x.level]})` : ""}`);
      f("cap").textContent = used.length ? `${sc.label} is used by ${list(used)}. No agent receives these values.` : `${sc.label} stays on the device: no request on this page uses it.`;
      if (reduce.matches || !playing || !onScreen) { rail(3); return; }
      rail(0);
      [600, 1200, 1800].forEach((t, k) => timers.push(setTimeout(() => rail(k + 1), t)));
      timers.push(setTimeout(() => select((cur + 1) % SCREENS.length), 5200));
    }
    function setPlaying(v) {
      playing = v;
      toggle.replaceChildren(h("span", { class: "ico ico-" + (v ? "pause" : "play"), "aria-hidden": "true" }), h("span", { text: v ? "Pause" : "Play" }));
      toggle.setAttribute("aria-pressed", String(!v));
      toggle.setAttribute("aria-label", v ? "Pause the device screens" : "Play the device screens");
      stage.classList.toggle("paused", !v);
      select(cur);
    }
    toggle.addEventListener("click", () => setPlaying(!playing));
    toggle.hidden = reduce.matches;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => {
        const vis = es[es.length - 1].isIntersecting;
        stage.classList.toggle("offscreen", !vis);
        if (vis !== onScreen) { onScreen = vis; select(cur); }
      }, { threshold: 0.2 }).observe(stage);
    }
    document.addEventListener("visibilitychange", () => { onScreen = !document.hidden; select(cur); });
    select(0);
  }

  function fill(D) {
    for (const card of document.querySelectorAll("[data-uc]")) {
      const c = D.cases && D.cases[card.getAttribute("data-uc")];
      if (!c) continue;
      const f = (n) => card.querySelector(`[data-f="${n}"]`);
      if (f("grant")) f("grant").textContent = grantChip(c.grant);
      if (f("chips")) f("chips").replaceChildren(...chips(c));
      if (f("packets")) f("packets").replaceChildren(...c.asks.map(packetCard));
      if (f("merge")) f("merge").textContent = c.asks.map((a) => (a.response.packet ? a.response.packet.findings.map((x) => x.statement).join(". ") : "")).filter(Boolean).join(". ") + ".";
      if (f("week")) {
        const w = week(c);
        f("week").replaceChildren(w.grid);
        if (f("summary")) f("summary").textContent = w.summary + " These are wellness signals, not a stress measurement.";
      }
      card.classList.add("ready");
    }
    // Cards rise in as they scroll into view; with reduced motion, or without an observer, they are simply shown.
    const cards = [...document.querySelectorAll(".uc")];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) { cards.forEach((c) => c.classList.add("in")); return; }
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }, { threshold: 0.12 });
    cards.forEach((c) => { c.classList.add("will-rise"); io.observe(c); });
  }

  async function boot() {
    if (!document.getElementById("uc-grid")) return;
    try {
      const r = await fetch("/data/usecases.json", { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const D = await r.json();
      fill(D);
      mountDevice(D);
    } catch {
      for (const el of document.querySelectorAll('.uc [data-f="packets"], .uc [data-f="week"]')) el.replaceChildren(h("p", { class: "muted", text: "The scenario packets could not be loaded. They are at /data/usecases.json." }));
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
