# Mobile critique and fixes

Review date: 25 November 2026. Scope: askwearables.app (every page in `workers/site/public`: home, results, credits,
privacy, terms, all of `docs/`, and the 404 page), the console (`workers/console/public`, app.askwearables.app) and
the sign-in pages (`workers/auth/src/pages.ts`: sign-in, owner setup, consent and message pages).

## How it was checked

- Engines: WebKit (Safari) and Chromium, with touch enabled. Chromium also ran with `isMobile`. Device scale factor
  was 2 at 320 and 360 wide and 3 at the other sizes.
- Viewports: 320x568 (iPhone SE 1st gen), 375x667 (SE), 390x844 (iPhone 14/15), 393x852, 430x932 (Pro Max),
  360x800 (Android) and 844x390 (landscape). Each was run in the light and the dark theme.
- Every run took a full-page screenshot and an in-page audit. The audit recorded:
  - interactive elements under 44x44 CSS px (inline links inside running text are exempt);
  - text under 16px;
  - WCAG AA contrast below 4.5:1 (3:1 for large text), measured against the real composited background;
  - boxes that scroll sideways, sticky and fixed elements, headings that wrap to four or more lines, page height,
    requests and bytes.
- Tools (scratchpad, not shipped): `mobile/tools/shoot.mjs`, which takes the screenshots and runs the audit;
  `serve.mjs`, a static server with the site's CSP; and `render-auth.mts`, which renders the auth pages to files.
- Screenshots: `/private/tmp/claude-501/-Users-varunkodathala-Downloads-AskWearables/c7f27e47-ce32-45b3-a382-6167fa5eeb46/scratchpad/mobile/`
  (`before/` and `after/`, one folder per surface and engine, plus `audit.json`). Below, `B/` stands for
  `.../scratchpad/mobile/before/` and `A/` for `.../scratchpad/mobile/after/`. File names are
  `<engine>-<page>-<width>x<height>-<theme>.png`.

Severity scale:
- **High:** content is unreadable or the page breaks.
- **Medium:** hard to use on a phone, or fails WCAG AA.
- **Low:** polish.

## Findings

| # | Sev | Where | Viewports | Problem | Before screenshot | Fix |
|---|-----|-------|-----------|---------|-------------------|-----|
| 1 | High | /privacy, /terms (legal tables) | every width up to 600, both engines, both themes | 3-column tables crush the first column to one letter per line ("C a t e g o r y", "H e a lt h D a t a"). Each row becomes hundreds of px tall. Cause: `overflow-wrap: anywhere` on table cells at 600px and below. | `B/site-webkit/webkit-privacy-375x667-light.png` | On a phone, tables with a header row become labelled cards: the first cell is the row heading and every other cell shows its column name. `md2site.py` now emits `class="stack doc-table"`, `th scope="row"` and `data-label`. Cells use `break-word`, never `anywhere`. |
| 2 | High | /docs/api, /docs/packets, /docs/quickstart, /docs/, /docs/privacy, /docs/self-hosting | 320 to 430 | The same collapse in the parameter, field, response and catalogue tables ("Ty pe", "h e a d er", "st ri ng", "F r o m le v el"). | `B/site-webkit/webkit-docs_api-375x667-light.png`, `B/site-webkit/webkit-docs_packets-320x568-light.png` | Same stacked cards. `render-api-docs.ts` generates them and `api.html` was regenerated. The hand-written docs tables were converted. |
| 3 | High | Consent page (auth) | 320 and 375, both engines | The page scrolls sideways (scrollWidth 434px) because the purpose `<select>` sizes to its longest option. Its native control is also only 23px tall in Safari. | `B/auth/webkit-consent-375x667-light.png` | The select is wrapped and drawn at full width and 44px tall, with a CSS-drawn chevron (the page loads no images). |
| 4 | High | Console: Sources, Agents, Receipts tables | 320 to 430 | 6- to 8-column tables in a sideways scroll box. Dates wrap per character group and the Decision and Reasons columns are cut off at the edge ("De", "rel"). | `B/console/webkit-home-375x667-light.png` | Below 640px the tables become cards: a heading plus label and value rows. Long ids and reasons wrap. |
| 5 | High | Console, all fields | every phone | Inputs are 15px, so iOS Safari zooms the page when one takes focus. | `B/console/webkit-home-375x667-light.png` | Body and fields are 16px or more; fields are 44px tall. |
| 6 | Medium | Site header, every page | 320 to 430 | The nav wraps under the lockup: two rows at 375 to 430, three at 320 with "Console" alone on its row. Links are 23px tall, and the brand and parent links are 27 to 28px. | `B/site-webkit/webkit-home-320x568-light.png` | Compact disclosure menu at 720px and below (`js/nav.js`). It is a real `<button>` with `aria-expanded` and `aria-controls="site-nav"`. Escape closes it and returns focus. A tap outside or a link click closes it. Without the script, the links stay visible. Menu links are 48px tall. The brand and parent links are 44px tall with the same look. |
| 7 | Medium | Controls across the site | phones and touch | Under 44px: chart "Table" toggles (30), story and walkthrough tabs (30 to 32), signal chips (26), Pause toggles (28 to 30), Prev/Next step (40), hero buttons (41), selects (23 in Safari, which ignores the height of a native select), results jump chips (34), docs nav chips (32), TOC links (17 to 22), footer links (17 to 23), `<summary>` toggles (22 to 26). Gaps between them were 6px. | `B/site-webkit/webkit-results-375x667-light.png`, `B/site-webkit/webkit-home-375x667-light.png` | 44px minimum through a `--tap` token on narrow and coarse-pointer screens, with 8px gaps. Selects are drawn with `appearance: none` and a Lucide chevron, so Safari honours their height. Summaries are 44px rows with a ▸/▾ marker. |
| 8 | Medium | Home: "ASK" tag in the use-case chats | all | White on the C green: 2.82:1 in light and 3.41:1 in dark, at 10.9px. | `B/site-webkit/webkit-home-375x667-light.png` | Dark text on the same green: 6.58:1 light, 5.44:1 dark. The A/B/C palette is unchanged. |
| 9 | Medium | Console and sign-in, dark theme | all | Primary buttons are white on #7aa2ff (2.49:1). Links keep the browser's default blue on a dark card (1.8:1), for example "Terms of Service", "Privacy Policy" and "Export everything". Form controls stay light-themed. | `B/auth/webkit-setup-375x667-dark.png`, `B/console/webkit-home-375x667-dark.png` | `--on-accent` dark text (7.29:1). Links use `--accent` (6.79:1). `color-scheme: light dark`. |
| 10 | Medium | Home and results, text sizes | phones | About 30 selectors at 10.9 to 12px (chips, level pills, merge labels, vault labels, week grid, packet ids, code in denied packets). Running text in the hero cards and charts is 13 to 14.4px (chat bubbles, "Why it is safe", story "why" lines, merge cards, chart subtitles). | `B/site-webkit/webkit-home-375x667-light.png` | Phone floors: 16px for running text, 13px for secondary lines, 12px for uppercase labels and chips. Code is at least 12px. Each floor only raises a size. |
| 11 | Medium | Charts (results and home) | 320 to 430 | Dot and bar charts drew at least 280px wide, so at 320 they were scaled down and the labels dropped to about 10px. Rows are 17px tall, which is hard to hit with a finger. Tooltips on touch flash and vanish, because `pointerleave` fires right after every tap. At 320 the small multiples are two panels about 120px wide whose cost ticks touch. | `B/site-webkit/webkit-results-320x568-light.png` | Charts draw at their real width (from 240px). Tick, value and row-key text is 12px on phones. Rows are 24px on coarse pointers. A tap shows the tooltip until the next tap elsewhere or a scroll. Small multiples drop to one column below 280px. Focused marks get an accent ring. |
| 12 | Medium | Home, page weight | phones | 33 requests and about 600 KB decoded (about 165 KB gzip). `results.json` (284 KB, 44 KB gzip) was fetched at start-up, though its first reader, the story card, is about 5,000px down on a phone. | audit: `B/audit375/audit.json` | `data.js` starts that fetch when the story or comparison comes within two screens, or when the page is idle after load. Every reader still awaits the same promise for the same file. |
| 13 | Low | Home: wellness journal tile (week grid) | 320, 360 | Day names split mid-word ("We d", "Mo n"). | `B/site-webkit/webkit-home-320x568-light.png` | Day names do not break; the row labels may wrap instead. |
| 14 | Low | Home: use-case tile headers | all phones | The device image is centred beside a tall header and floats in empty space. | `B/site-webkit/webkit-home-375x667-light.png` | 40px image aligned to the top, beside the agent's name. |
| 15 | Low | Home: hero buttons | 320 to 375 | Three buttons of uneven widths wrap raggedly. | `B/site-webkit/webkit-home-320x568-light.png` | Below 380px they stack at full width. Up to 600px the primary button is full width and the other two sit side by side. |
| 16 | Low | Home: leak chart "Measuring" state | phones | The pulse dot is centred on a wrapped paragraph, so it sits beside the second line. | `B/site-webkit/webkit-home-375x667-light.png` | The dot is aligned with the first line. |
| 17 | Low | Footer, every page | phones | Legal and nav links are 17 to 23px tall. | `B/site-webkit/webkit-home-375x667-light.png` | 44px rows. The copyright line is aligned with the links. |
| 18 | Low | Docs nav, every docs page | all | Labelled "Privacy policy (draft)" and "Terms of service (draft)", though both pages are published. | `B/site-webkit/webkit-docs_api-375x667-light.png` | "(draft)" removed, also in the generator. |
| 19 | Low | Headings and paragraphs | 320 to 393 | One-word last lines in h1 and h2 and some card questions. | `B/site-webkit/webkit-home-320x568-light.png` | `text-wrap: balance` on headings and `pretty` on paragraphs, on phones. This is progressive: browsers without support are unchanged. |
| 20 | Low | Sign-in setup and consent | all | Checkboxes and radios are 12px. The setup checkbox wraps onto its own line above its label. Choice rows are 29px. | `B/auth/webkit-setup-375x667-dark.png`, `B/auth/webkit-consent-375x667-light.png` | Each choice is a full-width row at least 44px tall with a 22px box. Allow and Deny are equal-width on phones. |
| 21 | Low | Console header | 320 | A sticky header with six 23px links wraps to two rows (about 90px), and anchor jumps land under it. | `B/console/webkit-home-320x568-light.png` | Disclosure menu (`aria-expanded`, Escape) below 640px. The header is one row of 56px, and sections have `scroll-margin-top`. |

## Checked and found sound

- **Page width.** No page scrolled sideways at any phone width before or after, except the consent page (#3). The
  architecture diagram scrolls inside its own labelled box, and only once its `<details>` is opened.
- **Sticky elements.** The site has none on a phone. The docs sidebar is sticky only from 820px up. The console
  header is the only one, and it is now a single 56px row.
- **Contrast of muted text and chips.** Measured on every page and both themes:
  - muted text: 5.9:1 on the light background, 5.6:1 on surface-2, 7.7:1 on the dark background and 6.39:1 on dark
    surface-2;
  - accent chips: 5.26:1 in light and 6.71:1 in dark.
  The only failures were #8 and #9.
- **Reduced motion.** Every animation stops under `prefers-reduced-motion`, as the existing test requires. The new
  menu icon's transition is also switched off.
- **Focus.** Order follows the DOM. The menu button sits before the links. The tab lists support arrow keys, Home and
  End. Every control has a visible outline. Chart marks gained a ring (#11).
- **Landscape at 844x390.** The nav stays inline (wider than 720px). The use-case masonry runs in two columns and
  nothing is covered. The hero stage is large but correct.
- **Images and icons.** All scale with their containers. The watch face is sized in container units. Icons are masks
  that take the text colour.

## Accepted as is, with reasons

- **SportsVision logo PNG (50 KB, 1600x343) shown at 70x15.** It is the largest single asset on every page. The
  brand rule (`assets/README.txt`) and the site test pin the file "as supplied". Lossless recompression saves only
  4%. It is cached after the first page. Recommendation: the owner supplies an approved 2x rendition
  (for example 224x48).
- **How-it-works SVG labels: 10.5 to 11.5px, about 9px at 320.** The numbered list right below repeats every stage at
  16px. Larger SVG text would overflow the fixed boxes.
- **Chart rows are 24px tall on touch, not 44px.**
  - Each row is a full-width hit strip.
  - Every chart has a Table view that lists the same values.
  - This falls under WCAG 2.5.8's equivalent-control exception.
- **Walkthrough steps not yet reached are drawn faded during autoplay.** This is the intended reveal. "Next step" and
  "Pause" bring them up, and reduced motion shows them all.
- **Code blocks wrap at the screen edge.** This is an earlier, deliberate choice: copying still gives the original
  lines.

## Verification

- **Tests in `workers/site/test/site.test.ts`.** Five new tests lock in:
  - the menu's markup, ARIA and script, including the generators;
  - 44px targets for the nav, menu, footer and every control class, 8px gaps, the select height and the touch
    tooltip;
  - type floors: nothing under 12px on a phone, and 16px running text;
  - stacked document tables, with no letter-per-line wrapping allowed;
  - lazy loading of `results.json`.
- **Other new tests.** `workers/console/test/mobile.test.ts` covers the console menu, 16px fields, 44px controls and
  stacked tables. `workers/auth/test/pages.test.ts` covers 44px choices and buttons, 16px fields, dark contrast and
  the wrapped select.
- **Other checks run.** `node scripts/check-viewport.mjs` on every page, `npx tsc -p workers/site`, `-p workers/auth`
  and `-p workers/console`, and `npx wrangler deploy --dry-run -c workers/site/wrangler.jsonc`.
- **Before and after screenshots.** Every viewport and both themes are in `before/` and `after/`. The side-by-side
  pairs at 375 and 390 are in `compare/`.
