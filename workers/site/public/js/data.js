// Starts the one fetch of the study results that the landing page's scripts share (results.js and home.js).
// results.json is the heaviest file on the page and its first reader (the story card) sits below the use-case tiles,
// so on the landing page the fetch starts when that part of the page comes within two screens of the viewport, or
// once the page has loaded and gone idle, whichever is first. Readers await the same promise either way, so every
// figure still comes from the one file.
"use strict";
(function () {
  const json = (r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };
  const opts = { headers: { accept: "application/json" } };
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  window.awResults = started.then(() => fetch("/data/results.json", opts)).then(json);
  window.awFeatured = fetch("/data/featured.json", opts).then(json);
  // Each consumer reports its own failure; keep an unhandled rejection out of the console.
  window.awResults.catch(() => {});
  window.awFeatured.catch(() => {});

  const first = document.querySelector("[data-needs-results]");
  if (!first || !("IntersectionObserver" in window)) { start(); return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
  }, { rootMargin: "200% 0px 200% 0px" });
  for (const el of document.querySelectorAll("[data-needs-results]")) io.observe(el);
  const idle = () => (window.requestIdleCallback ? window.requestIdleCallback(() => start(), { timeout: 4000 }) : setTimeout(start, 2500));
  if (document.readyState === "complete") idle(); else window.addEventListener("load", idle, { once: true });
})();
