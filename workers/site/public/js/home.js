// Landing page: the hero walkthrough and the "what the agent sees" comparison.
// Everything shown is read at runtime from /data/results.json (the study's real runs) and /data/featured.json
// (which example ids to play, in order). Model output is shown with textContent only; no HTML is parsed.
"use strict";
(function () {
  const CONDS = ["A_raw", "B_tools", "C_broker"];
  const CLS = { A_raw: "a", B_tools: "b", C_broker: "c" };
  const FALLBACK_NAMES = { A_raw: "A: raw data in context", B_tools: "B: open data tools", C_broker: "C: AskWearables" };
  const ROUTE = { A_raw: "reads the whole export", B_tools: "calls open data tools", C_broker: "asks AskWearables" };
  const COND_ICON = { A_raw: "file-text", B_tools: "database", C_broker: "shield-check" };
  const METRIC = { steps: "steps", hrv_rmssd: "HRV (RMSSD)", sleep_duration: "sleep duration", resting_hr: "resting heart rate", workout: "workouts", sleep_efficiency: "sleep efficiency" };
  const LEVEL = { 0: "flag", 1: "trend", 2: "daily", 3: "raw" };
  const SOURCE = { apple_health: "Apple Health", garmin: "Garmin", oura: "Oura", whoop: "WHOOP", fitbit: "Fitbit" };
  const QUESTIONS = {
    rhr_yesterday: "Resting heart rate yesterday", rhr_avg_14d: "Average resting heart rate, 14 days", hrv_trend_28d: "HRV trend over 4 weeks",
    sleep_avg_7d: "Average sleep, last 7 nights", sleep_under_6h_7d: "Any night under 6 hours, last 7", sleep_vs_usual_3d: "Last 3 nights vs usual",
    steps_total_7d: "Total steps, last 7 days", steps_week_vs_prev: "Steps this week vs last week", steps_yesterday: "Steps yesterday", workouts_14d: "Workouts in the last 14 days",
  };
  // Milliseconds into each example when each stage appears, and the length of one example.
  const STAGES = [["ask", 0], ["plan", 900], ["gate", 2100], ["vault", 4000], ["packet", 5200], ["compare", 6400]];
  const CYCLE = 14000;

  let NAMES = FALLBACK_NAMES;
  const cname = (c) => NAMES[c] || c;
  const label = (map, k) => map[k] || String(k).replace(/_/g, " ");
  const metricName = (m) => METRIC[m] || String(m).replace(/_/g, " ");
  const sourceName = (s) => SOURCE[s] || String(s).replace(/_/g, " ");

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const icon = (name, extra) => h("span", { class: "ico ico-" + name + (extra ? " " + extra : ""), "aria-hidden": "true" });
  const emoji = (code) => (/^[0-9a-f-]+$/.test(code || "") ? h("img", { class: "emoji", src: `/assets/emoji/twemoji/${code}.svg`, alt: "", width: "20", height: "20" }) : null);
  const int = (x) => Math.round(x).toLocaleString("en-US");

  function fmtAnswer(a) {
    if (a == null || a === "") return "no answer";
    if (typeof a === "number") return a.toLocaleString("en-US");
    return String(a);
  }
  function fmtAccept(acc) {
    if (!acc) return "–";
    const parts = [];
    if (typeof acc.number === "number") parts.push(acc.number.toLocaleString("en-US", { maximumFractionDigits: 1 }));
    if (Array.isArray(acc.labels)) parts.push(...acc.labels);
    return parts.join(" or ") || "–";
  }
  // The model's final text without the closing "ANSWER:" line or markdown marks, cut at a word boundary.
  function excerpt(text, max = 190) {
    let t = String(text || "").replace(/ANSWER:[^\n]*/gi, "").replace(/[*_`#|]/g, "").replace(/\s+/g, " ").trim();
    t = t.replace(/^…\s*/, "");
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).replace(/[\s,;:.\-–]+$/, "") + "…";
  }
  function days(start, end) {
    const out = [];
    const d = new Date(start + "T00:00:00Z"), e = new Date(end + "T00:00:00Z");
    for (let i = 0; d <= e && i < 70; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
  }
  const shortDay = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  // ---------- one example, rendered into the stage fields ----------
  function specBlock(p) {
    const line = (...parts) => h("span", { class: "ln" }, ...parts);
    const k = (t) => h("span", { class: "tk-k", text: `"${t}"` });
    const str = (t) => h("span", { class: "tk-s", text: `"${t}"` });
    if (!p) return [line(h("span", { class: "tk-c", text: "// this run's QuerySpec was not stored" }))];
    return [
      line("{"),
      line("  ", k("operation"), ": ", str(p.operation), ","),
      line("  ", k("metrics"), ": [", ...p.metrics.flatMap((m, i) => (i ? [", ", str(m)] : [str(m)])), "],"),
      line("  ", k("window"), ": { ", k("start"), ": ", str(p.window.start), ", ", k("end"), ": ", str(p.window.end), " }"),
      line("}"),
    ];
  }
  function checks(p, level) {
    const lv = typeof level === "number" ? level : null;
    const items = [
      "Token bound to this agent and this grant",
      p ? `Metric in the grant: ${p.metrics.map(metricName).join(", ")}` : "Metrics in the grant",
      "Provider terms allow use by an AI agent",
      "No sensitive category requested",
      p ? ["Window inside the grant: ", h("span", { class: "nw", text: p.window.start }), " to ", h("span", { class: "nw", text: p.window.end })] : "Window inside the grant",
      lv != null ? `Level ${lv} (${LEVEL[lv] || "?"}), within the grant's maximum` : "Level within the grant's maximum",
      "Daily budget and purpose fit",
    ];
    return items.map((t) => h("li", {}, h("span", { class: "tick" }, icon("check")), h("span", {}, t)));
  }
  function vault(p, level) {
    if (!p) {
      return [h("p", { class: "ws-note", text: typeof level === "number"
        ? `Computed and released at level ${level} (${LEVEL[level] || "?"}). The packet body was not stored for this run.`
        : "The packet body was not stored for this run." })];
    }
    const out = [];
    const f = (p.findings || [])[0];
    if (f && Array.isArray(f.values) && f.values.length) {
      const byDay = new Map(f.values.map((v) => [v.day, v.value]));
      const span = days(p.window.start, p.window.end);
      const max = Math.max(...f.values.map((v) => v.value), 1);
      const strip = h("div", { class: "strip", role: "img", "aria-label": `${span.length} days in the window; ${span.filter((d) => byDay.has(d)).length} with data` },
        span.map((d) => {
          const has = byDay.has(d);
          const bar = h("span", { class: "strip-bar" });
          if (has) bar.style.setProperty("--v", String(Math.max(0.06, byDay.get(d) / max)));
          return h("span", { class: "strip-day" + (has ? "" : " gap"), title: has ? `${d}: ${int(byDay.get(d))}` : `${d}: no data` }, bar);
        }));
      out.push(strip, h("p", { class: "strip-axis" }, h("span", { text: shortDay(span[0]) }), h("span", { class: "strip-key" }, h("span", { class: "strip-swatch gap" }), "no data"), h("span", { text: shortDay(span[span.length - 1]) })));
    }
    const dq = p.data_quality || {};
    const cov = typeof dq.coverage === "number" ? dq.coverage : null;
    const meter = h("span", { class: "meter" }, h("span", { class: "meter-fill" }));
    meter.firstChild.style.setProperty("--v", String(cov ?? 0));
    out.push(h("dl", { class: "vault-meta" },
      h("div", {}, h("dt", { text: "Coverage" }), h("dd", {}, meter, h("span", { text: cov == null ? "no data" : Math.round(cov * 100) + "%" }))),
      h("div", {}, h("dt", { text: "Sources" }), h("dd", { text: (dq.sources || []).length ? dq.sources.map(sourceName).join(" + ") : "none in window" })),
      h("div", {}, h("dt", { text: "Last sync" }), h("dd", { class: dq.freshness_hours > 48 ? "warn" : "", text: dq.freshness_hours != null ? `${int(dq.freshness_hours)} h ago` : "–" }))));
    return out;
  }
  function packetCard(p, level, cRun) {
    if (!p) {
      return [h("div", { class: "pk" },
        h("div", { class: "pk-head" }, h("span", { class: "pk-level", text: typeof level === "number" ? `Level ${level} · ${LEVEL[level] || "?"}` : "Packet" })),
        h("p", { class: "pk-finding" }, "The agent answered ", h("strong", { text: fmtAnswer(cRun && cRun.answer) }), " from it."),
        h("p", { class: "pk-foot" }, icon("receipt"), "Release written to the receipt log"))];
    }
    const caveats = (p.data_quality && p.data_quality.caveats) || [];
    return [h("div", { class: "pk" },
      h("div", { class: "pk-head" },
        h("span", { class: "pk-level", text: `Level ${p.level} · ${LEVEL[p.level] || "?"}` }),
        p.packet_id ? h("code", { class: "pk-id", title: p.packet_id, text: p.packet_id.slice(0, 11) + "…" }) : null),
      (p.findings || []).map((f) => h("p", { class: "pk-finding", text: f.statement })),
      caveats.length ? h("ul", { class: "pk-caveats", "aria-label": "Caveats" }, caveats.map((c) => h("li", { text: c }))) : null,
      h("p", { class: "pk-foot" }, icon("receipt"), "Receipt written to the user's hash-chained log"))];
  }
  function compareCards(x) {
    return CONDS.map((c) => {
      const r = x.runs[c];
      const ok = r && r.correct;
      return h("article", { class: `wc wc-${CLS[c]}` + (ok ? " ok" : " no") },
        h("header", { class: "wc-head" }, h("span", { class: "wc-ico" }, icon(COND_ICON[c])), h("span", {}, h("strong", { text: cname(c) }), h("span", { class: "wc-route", text: ROUTE[c] }))),
        r ? [
          h("p", { class: "wc-ans" },
            h("span", { class: "wc-val", text: fmtAnswer(r.answer) }),
            h("span", { class: "wc-mark " + (ok ? "ok" : "no") }, icon(ok ? "check" : "x"), h("span", { text: ok ? "Correct" : "Wrong" }))),
          excerpt(r.final) ? h("p", { class: "wc-final", text: excerpt(r.final) }) : null,
        ] : h("p", { class: "muted", text: "No run recorded." }));
    });
  }

  // ---------- the walkthrough (How it works) ----------
  function mountWalk(D, F) {
    const root = document.getElementById("walk");
    if (!root) return;
    const byId = new Map((D.examples || []).map((x) => [x.id, x]));
    const items = (F.pipeline || F.examples || []).map((f) => ({ f, x: byId.get(f.id) })).filter((it) => it.x && it.x.runs && it.x.runs.C_broker);
    const loading = document.getElementById("walk-loading");
    if (!items.length) { if (loading) loading.textContent = "The featured examples are not in this results file yet."; return; }
    if (loading) loading.hidden = true;
    root.classList.add("ready");

    const panel = document.getElementById("walk-panel");
    const tabsEl = document.getElementById("walk-tabs");
    const toggle = document.getElementById("walk-toggle");
    const progress = document.getElementById("walk-progress");
    const why = document.getElementById("walk-why");
    const field = (n) => panel.querySelector(`[data-f="${n}"]`);
    const steps = Object.fromEntries([...panel.querySelectorAll(".ws")].map((el) => [el.getAttribute("data-step"), el]));
    const compare = panel.querySelector(".walk-compare");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    const tabs = items.map((it, i) => {
      const b = h("button", { type: "button", role: "tab", id: "walk-tab-" + i, "aria-controls": "walk-panel", "aria-selected": "false", tabindex: "-1", class: "walk-tab" },
        emoji(it.f.emoji), h("span", { text: it.f.title || label(QUESTIONS, it.x.question) }));
      b.addEventListener("click", () => select(i, true));
      return b;
    });
    tabsEl.replaceChildren(...tabs);
    tabsEl.addEventListener("keydown", (ev) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const n = tabs.length;
      const j = ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i - 1 + n) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
      if (j < 0) return;
      ev.preventDefault();
      tabs[j].focus();
      select(j, true);
    });

    let cur = -1, elapsed = 0, fired = 0, playing = true, onScreen = true, held = false, raf = 0, last = 0, swapTimer = 0;

    function fill(i) {
      const { f, x } = items[i];
      const c = x.runs.C_broker;
      const p = (c.packets || [])[0] || null;
      const level = (c.levels || []).find((v) => typeof v === "number");
      why.replaceChildren(emoji(f.emoji), h("strong", { text: f.title || "" }), " ", f.why || "");
      field("model").textContent = `${x.model} · ${label(QUESTIONS, x.question)}`;
      field("ask").textContent = (c.asked && c.asked[0]) || label(QUESTIONS, x.question);
      field("spec").replaceChildren(...specBlock(p));
      field("checks").replaceChildren(...checks(p, p ? p.level : level));
      field("vault").replaceChildren(...vault(p, level));
      field("packet").replaceChildren(...packetCard(p, level, c));
      if (field("truth")) field("truth").textContent = fmtAccept(x.accept);
      if (field("cards")) field("cards").replaceChildren(...compareCards(x));
      tabs.forEach((t, k) => { t.setAttribute("aria-selected", String(k === i)); t.tabIndex = k === i ? 0 : -1; });
      panel.setAttribute("aria-labelledby", "walk-tab-" + i);
    }
    function setStage(n) {
      // n stages are visible; the last visible one is current.
      STAGES.forEach(([name], k) => {
        const el = name === "compare" ? compare : steps[name];
        if (!el) return;
        el.classList.toggle("on", k < n);
        el.classList.toggle("cur", k === n - 1 && name !== "compare");
      });
    }
    function showAll() { setStage(STAGES.length); progress.style.transform = "scaleX(1)"; }

    function select(i, user) {
      clearTimeout(swapTimer);
      const go = () => {
        cur = i;
        fill(i);
        elapsed = 0; fired = 0;
        if (reduce.matches) { showAll(); panel.classList.remove("swap"); return; }
        setStage(0);
        panel.classList.remove("swap");
        progress.style.transform = "scaleX(0)";
        tick();
        kick();
      };
      if (cur < 0 || reduce.matches) { go(); return; }
      if (user && cur === i) { go(); return; }
      panel.classList.add("swap");
      swapTimer = setTimeout(go, 220);
    }

    const running = () => playing && onScreen && !held && !document.hidden && !reduce.matches;
    function frame(now) {
      raf = 0;
      if (!running()) return;
      elapsed += Math.min(100, now - last);
      last = now;
      tick();
      if (elapsed >= CYCLE) { select((cur + 1) % items.length, false); return; }
      raf = requestAnimationFrame(frame);
    }
    function tick() {
      let n = fired;
      while (n < STAGES.length && elapsed >= STAGES[n][1]) n++;
      if (n !== fired || n === 0) { fired = n; setStage(n); }
      progress.style.transform = `scaleX(${Math.min(1, elapsed / CYCLE)})`;
    }
    function kick() {
      if (raf || !running()) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function setPlaying(v) {
      playing = v;
      toggle.replaceChildren(icon(v ? "pause" : "play"), h("span", { class: "walk-toggle-label", text: v ? "Pause" : "Play" }));
      toggle.setAttribute("aria-label", v ? "Pause the walkthrough" : "Play the walkthrough");
      root.classList.toggle("paused", !v);
      kick();
    }
    toggle.addEventListener("click", () => setPlaying(!playing));

    // Hold while someone is reading or using the panel; stop drawing when it is off screen or the tab is hidden.
    const body = panel.querySelector(".walk-body");
    body.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { held = true; } });
    body.addEventListener("pointerleave", () => { held = false; kick(); });
    panel.addEventListener("focusin", () => { held = true; });
    panel.addEventListener("focusout", () => { held = false; kick(); });
    document.addEventListener("visibilitychange", kick);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; kick(); }, { threshold: 0.15 }).observe(root);
    }
    function applyMotion() {
      toggle.hidden = reduce.matches;
      root.classList.toggle("static", reduce.matches);
      if (reduce.matches) showAll(); else { elapsed = 0; fired = 0; setStage(0); kick(); }
    }
    if (reduce.addEventListener) reduce.addEventListener("change", applyMotion);
    setPlaying(true);
    select(0, false);
    applyMotion();
  }

  // ---------- the hero story card: one everyday question, the true answer, and what each route answered ----------
  const TRAP_PLAIN = { two_step_sources: "phone and watch both count steps", missing_days: "some days have no data", short_sleep: "a run of short nights", stale_sync: "the watch has not synced lately", device_switch: "a new watch", travel: "a time-zone change", dst: "a clock change", clean: "clean data" };
  const RIGHT = { true: ["check", "Right"], false: ["x", "Wrong"] };
  function storyCards(x, f) {
    return CONDS.map((c) => {
      const r = x.runs[c];
      const ok = !!(r && r.correct);
      const kids = [h("header", { class: "sc-head" }, h("span", { class: "wc-ico" }, icon(COND_ICON[c])), h("span", {}, h("strong", { text: cname(c) }), h("span", { class: "wc-route", text: ROUTE[c] })))];
      if (!r) kids.push(h("p", { class: "muted", text: "No run recorded." }));
      else {
        kids.push(h("p", { class: "sc-ans" }, h("span", { class: "sc-val", text: fmtAnswer(r.answer) }),
          h("span", { class: "sc-mark " + (ok ? "ok" : "no") }, icon(RIGHT[ok][0]), h("span", { text: RIGHT[ok][1] }))));
        if (f.why && f.why[c]) kids.push(h("p", { class: "sc-why", text: f.why[c] }));
        if (c === "C_broker") {
          const p = (r.packets || [])[0];
          const body = p
            ? [...(p.findings || []).map((fd) => h("p", { class: "pk-finding", text: fd.statement })),
               ((p.data_quality && p.data_quality.caveats) || []).length ? h("ul", { class: "pk-caveats" }, p.data_quality.caveats.map((cv) => h("li", { text: cv }))) : null,
               h("p", { class: "pk-foot" }, icon("receipt"), `Level ${p.level} (${LEVEL[p.level] || "?"}), with a receipt`)]
            : [r.asked && r.asked[0] ? h("p", { class: "sc-asked" }, "It asked: ", h("q", { text: r.asked[0] })) : null,
               h("p", { class: "fine", text: "This run's packet body was not stored. The agent's reply from it:" }),
               excerpt(r.final, 220) ? h("p", { class: "sc-final", text: excerpt(r.final, 220) }) : null];
          kids.push(h("details", { class: "sc-got" }, h("summary", { text: "What the agent received" }), h("div", { class: "pk" }, body)));
        }
      }
      return h("article", { class: `sc sc-${CLS[c]} ` + (ok ? "ok" : "no") }, kids);
    });
  }
  // How long one example stays up.
  const STORY_CYCLE = 9000;
  function mountStory(D, F) {
    const root = document.getElementById("story");
    if (!root) return;
    const byId = new Map((D.examples || []).map((x) => [x.id, x]));
    const items = (F.examples || []).map((f) => ({ f, x: byId.get(f.id) })).filter((it) => it.x && it.x.runs && it.x.runs.C_broker);
    const loading = document.getElementById("story-loading");
    if (!items.length) { if (loading) loading.textContent = "The featured examples are not in this results file yet."; return; }
    if (loading) loading.hidden = true;
    root.classList.add("ready");
    const panel = document.getElementById("story-panel"), tabsEl = document.getElementById("story-tabs"), toggle = document.getElementById("story-toggle"), progress = document.getElementById("story-progress");
    const field = (n) => panel.querySelector(`[data-f="${n}"]`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    const tabs = items.map((it, i) => {
      const b = h("button", { type: "button", role: "tab", id: "story-tab-" + i, "aria-controls": "story-panel", "aria-selected": "false", tabindex: "-1", class: "story-tab" }, emoji(it.f.emoji), h("span", { text: it.f.title || label(QUESTIONS, it.x.question) }));
      b.addEventListener("click", () => select(i));
      return b;
    });
    tabsEl.replaceChildren(...tabs);
    tabsEl.addEventListener("keydown", (ev) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const n = tabs.length;
      const j = ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i - 1 + n) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
      if (j < 0) return;
      ev.preventDefault();
      tabs[j].focus();
      select(j);
    });

    let cur = -1, elapsed = 0, playing = true, onScreen = true, held = false, raf = 0, last = 0, swapTimer = 0;
    function fill(i) {
      const { f, x } = items[i];
      field("q").textContent = f.title || label(QUESTIONS, x.question);
      field("meta").replaceChildren(h("span", { text: TRAP_PLAIN[x.trap] || String(x.trap).replace(/_/g, " ") }), " · ", h("span", { text: x.model }));
      field("truth").textContent = fmtAccept(x.accept);
      field("cards").replaceChildren(...storyCards(x, f));
      tabs.forEach((t, k) => { t.setAttribute("aria-selected", String(k === i)); t.tabIndex = k === i ? 0 : -1; });
      panel.setAttribute("aria-labelledby", "story-tab-" + i);
    }
    function select(i) {
      clearTimeout(swapTimer);
      const go = () => {
        cur = i; fill(i); elapsed = 0;
        panel.classList.remove("swap");
        if (reduce.matches) { progress.style.transform = "scaleX(1)"; return; }
        tick(); kick();
      };
      if (cur < 0 || reduce.matches) { go(); return; }
      panel.classList.add("swap");
      swapTimer = setTimeout(go, 320);
    }
    const running = () => playing && onScreen && !held && !document.hidden && !reduce.matches;
    function tick() {
      progress.style.transform = `scaleX(${Math.min(1, elapsed / STORY_CYCLE)})`;
    }
    function frame(now) {
      raf = 0;
      if (!running()) return;
      elapsed += Math.min(100, now - last);
      last = now;
      tick();
      if (elapsed >= STORY_CYCLE) { select((cur + 1) % items.length); return; }
      raf = requestAnimationFrame(frame);
    }
    function kick() {
      if (raf || !running()) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function setPlaying(v) {
      playing = v;
      toggle.replaceChildren(icon(v ? "pause" : "play"), h("span", { text: v ? "Pause" : "Play" }));
      toggle.setAttribute("aria-label", v ? "Pause the examples" : "Play the examples");
      toggle.setAttribute("aria-pressed", String(!v));
      root.classList.toggle("paused", !v);
      kick();
    }
    toggle.addEventListener("click", () => setPlaying(!playing));
    // Hold while someone reads or uses the card; stop when it is off screen or the tab is hidden.
    panel.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") held = true; });
    panel.addEventListener("pointerleave", () => { held = false; kick(); });
    panel.addEventListener("focusin", () => { held = true; });
    panel.addEventListener("focusout", () => { held = false; kick(); });
    panel.addEventListener("toggle", () => { held = true; }, true);
    document.addEventListener("visibilitychange", kick);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; kick(); }, { threshold: 0.1 }).observe(root);
    }
    function applyMotion() {
      toggle.hidden = reduce.matches;
      root.classList.toggle("static", reduce.matches);
      if (reduce.matches) progress.style.transform = "scaleX(1)"; else { elapsed = 0; kick(); }
    }
    if (reduce.addEventListener) reduce.addEventListener("change", applyMotion);
    setPlaying(true);
    select(0);
    applyMotion();
  }

  // ---------- what the agent sees ----------
  function mountSees(D) {
    const box = document.getElementById("sees-box"), sizes = document.getElementById("sizes"), roll = document.getElementById("wall-roll");
    if (!box || !sizes) return;
    const ex = D.exposure_median_chars;
    if (!ex || !CONDS.every((c) => typeof ex[c] === "number")) { sizes.replaceChildren(h("p", { class: "muted", text: "Exposure figures are not in this results file yet." })); return; }
    const max = Math.max(...CONDS.map((c) => ex[c]));
    const REACH = {
      A_raw: ["file-text", "Reach: the whole record, delivered every time", "wide"],
      B_tools: ["database", "Reach: the whole record, a tool call away", "wide"],
      C_broker: ["shield-check", "Reach: only what the grant allows, at the lowest level that answers", "narrow"],
    };
    const WHAT = { A_raw: "the export in the prompt", B_tools: "what the tools returned", C_broker: "the packets" };
    sizes.replaceChildren(...CONDS.map((c) => {
      const fillEl = h("span", { class: "size-fill f-" + CLS[c] });
      fillEl.style.setProperty("--r", String(ex[c] / max));
      const ratio = c !== "C_broker" && ex.C_broker > 0 ? ex[c] / ex.C_broker : null;
      const [ic, reach, kind] = REACH[c];
      return h("div", { class: "size-row size-" + CLS[c], role: "listitem" },
        h("p", { class: "size-head" },
          h("span", { class: "key" }, h("span", { class: "sw sw-" + CLS[c], "aria-hidden": "true" }), h("strong", { text: cname(c) })),
          h("span", { class: "size-num" }, h("strong", { text: int(ex[c]) }), " characters")),
        h("span", { class: "size-track", "aria-hidden": "true" }, fillEl),
        h("p", { class: "size-sub" }, h("span", { text: WHAT[c] }),
          ratio && ratio >= 1.5 ? h("span", { class: "size-ratio", text: `${Math.round(ratio)}× the packet` }) : ratio ? h("span", { class: "size-ratio", text: "similar volume to the packet" }) : null),
        h("p", { class: "reach reach-" + kind }, icon(ic), h("span", { text: reach })));
    }), h("p", { class: "fine sizes-note", text: "B delivers about as much as C, so the difference there is reach, not size: an open tool can fetch any part of the record, and a planted instruction or a drifting purpose decides what it fetches. The privacy suite on the results page measures that." }));

    const s = D.export_sample;
    if (s && Array.isArray(s.lines) && s.lines.length > 2 && roll) {
      const [head, ...rows] = s.lines;
      const meta = box.querySelector('[data-f="wall-meta"]');
      if (meta) meta.textContent = `${int(s.lines_total - 1)} rows · ${int(s.chars)} characters`;
      const cap = box.querySelector('[data-f="wall-cap"]');
      if (cap) cap.textContent = `The opening rows of one synthetic person's export (${s.person}, ${String(s.trap).replace(/_/g, " ")} data). In condition A, all of it goes into the prompt for every question.`;
      const line = (t, cls) => h("span", { class: "wl" + (cls ? " " + cls : ""), text: t });
      box.querySelector(".wall-head").after(h("div", { class: "wall-cols", "aria-hidden": "true" }, line(head)));
      // Two copies so the roll loops without a seam.
      roll.replaceChildren(...rows.map((r) => line(r)), ...rows.map((r) => line(r)));
    }
    const go = () => box.classList.add("in");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) go();
    else {
      const io = new IntersectionObserver((es) => {
        for (const e of es) box.classList.toggle("visible", e.isIntersecting);
        if (es.some((e) => e.isIntersecting)) go();
      }, { threshold: 0.2 });
      io.observe(box);
    }
  }

  async function boot() {
    if (!document.getElementById("walk") && !document.getElementById("story") && !document.getElementById("sees-box")) return;
    let D, F;
    try {
      D = await (window.awResults || fetch("/data/results.json").then((r) => r.json()));
    } catch {
      for (const id of ["walk-loading", "story-loading"]) { const l = document.getElementById(id); if (l) l.textContent = "The study results could not be loaded. Try again later, or open /data/results.json directly."; }
      const s = document.getElementById("sizes");
      if (s) s.replaceChildren(h("p", { class: "muted", text: "Results unavailable." }));
      return;
    }
    NAMES = Object.assign({}, FALLBACK_NAMES, D.conditions || {});
    mountSees(D);
    try {
      F = await (window.awFeatured || fetch("/data/featured.json").then((r) => r.json()));
    } catch {
      F = { examples: [] };
    }
    mountStory(D, F);
    mountWalk(D, F);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
