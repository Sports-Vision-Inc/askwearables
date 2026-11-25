// The compact site menu on narrow screens: a disclosure button that shows and hides the main navigation.
// Without this script (or on a wide screen) the links are always shown; the button stays hidden.
"use strict";
(function () {
  const header = document.querySelector(".site-header");
  const btn = header && header.querySelector(".nav-toggle");
  const nav = header && header.querySelector(".site-nav");
  if (!btn || !nav) return;
  const label = btn.querySelector(".nav-toggle-label");
  const set = (open, focusButton) => {
    btn.setAttribute("aria-expanded", String(open));
    header.classList.toggle("menu-open", open);
    if (label) label.textContent = open ? "Close" : "Menu";
    if (!open && focusButton) btn.focus();
  };
  header.classList.add("has-menu");
  btn.hidden = false;
  set(false);
  btn.addEventListener("click", () => {
    // Focus stays on the button (the disclosure pattern); Tab moves into the links, which follow it in the DOM.
    set(btn.getAttribute("aria-expanded") !== "true");
  });
  // Escape closes the menu and puts focus back on the button (on the document: Safari does not focus a tapped button).
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && btn.getAttribute("aria-expanded") === "true") { ev.preventDefault(); set(false, true); }
  });
  // A tap or focus outside the header closes it.
  document.addEventListener("pointerdown", (ev) => { if (!header.contains(ev.target)) set(false); });
  document.addEventListener("focusin", (ev) => { if (!header.contains(ev.target)) set(false); });
  // Following an in-page link closes it.
  nav.addEventListener("click", (ev) => { if (ev.target.closest && ev.target.closest("a")) set(false); });
  // Back on a wide screen, the links are shown inline again, so the open state is dropped.
  const wide = window.matchMedia("(min-width: 721px)");
  const onWide = () => { if (wide.matches) set(false); };
  if (wide.addEventListener) wide.addEventListener("change", onWide);
})();
