import { describe, expect, it } from "vitest";
import { consentPage, loginPage, messagePage } from "../src/pages.js";

const view = { agentName: "Coach", agentDomain: "coach.example", registeredBy: "Example", redirectHost: "coach.example", redirectIsLoopback: false, handle: "h", postTo: "/authorize", exampleUrl: "/example", today: "2026-11-25" };

describe("sign-in and consent pages on a phone", () => {
  const pages = [loginPage("/", "n"), loginPage("/", "n", "setup"), consentPage(view, "n"), messagePage("Expired", "Start again.")];

  it("size controls for touch and keep fields at 16px", () => {
    for (const p of pages) {
      expect(p).toMatch(/<meta name="viewport" content="width=device-width,initial-scale=1">/);
      expect(p).toMatch(/color-scheme:light dark/);
      expect(p).toMatch(/button\{[^}]*min-height:44px/);
      expect(p).toMatch(/select\{[^}]*font-size:max\(16px,1em\);min-height:44px/);
      // Each checkbox or radio row is a 44px target with a 22px box.
      expect(p).toMatch(/fieldset label,label\.check\{[^}]*min-height:44px/);
      expect(p).toMatch(/label\.check>input\{[^}]*width:22px;height:22px/);
      // Links and the primary button keep AA contrast in the dark theme.
      expect(p).toMatch(/a\{color:var\(--accent\)/);
      expect(p).toMatch(/button\.primary\{[^}]*color:var\(--on-accent\)/);
      expect(p).toMatch(/minmax\(min\(100%,200px\),1fr\)/);
    }
  });

  it("wraps the purpose select so it never widens the page", () => {
    expect(consentPage(view, "n")).toMatch(/<span class="select"><select name="purpose" required>/);
    expect(loginPage("/", "n", "setup")).toMatch(/<label class="check"><input type="checkbox" id="accept">/);
  });
});
