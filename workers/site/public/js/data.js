// Starts the one fetch of the study results that the landing page's scripts share (results.js and home.js).
"use strict";
(function () {
  const json = (r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };
  const opts = { headers: { accept: "application/json" } };
  window.awResults = fetch("/data/results.json", opts).then(json);
  window.awFeatured = fetch("/data/featured.json", opts).then(json);
  // Each consumer reports its own failure; keep an unhandled rejection out of the console.
  window.awResults.catch(() => {});
  window.awFeatured.catch(() => {});
})();
