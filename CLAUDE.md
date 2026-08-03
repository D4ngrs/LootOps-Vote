# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LootOps is a single-file, no-build static web app: **`index.html`** (~2,700 lines) contains all HTML, CSS, and JavaScript inline. There is no package.json, no bundler, no test suite, and no server-side code — the whole app ships as one file that can be opened directly in a browser or hosted as static content.

It's a loot-distribution tool for a Star Citizen org: participants ("names") and loot items are entered, then the app randomly deals items out to names ("Roll"), with results logged to history and optionally posted to a Discord webhook.

## Working with the file

- Because it's one large file, use Grep to jump to the relevant function/section rather than reading the whole file — several lines (the favicon and a couple of embedded boot images/GIF frames near the top of `<body>`) are huge base64 blobs and will blow out a full-file read.
- There is no build/lint/test command — verify changes by opening `index.html` in a browser (or via a simple static server) and exercising the feature manually.
- The visible version string is controlled by a single constant near the top of the file:
  ```js
  const APP_VERSION = 'v0.9.2';
  ```
  It's displayed on the login screen and page footer. **Do not bump this, and do not add/edit a `CHANGELOG_ENTRIES` entry, unless the user explicitly asks for it** — even right after shipping a user-visible change. When asked to write one: plain language (no jargon), never address the user directly ("you"/"your"), prefix each bullet with `Added:`/`Changed:`/`Fixed:`, only list real user-facing impact, and give genuinely new features (`Added:`) 1-2 sentences of real detail rather than a generic one-liner — routine fixes/tweaks stay short.

## Architecture (single file, roughly top-to-bottom)

1. **`<style>` block** — all CSS, using CSS custom properties defined on `:root` (`--bg`, `--panel`, `--gold`, `--violet`, `--text`, `--muted`, `--bad`) for the dark theme.
2. **`<body>` markup** — in order: login gate (`#loginGate`), boot/logo overlay (`#bootOverlay`), then the main app (`.wrap`): header, Discord webhook settings modal, history modal, the Names/Items two-panel grid, roll options, roll button, results, and roll history.
3. **`<script>` block(s)** at the bottom contain all logic. Key areas, in file order:
   - **Boot sequence** — decodes and plays an embedded GIF logo via a hand-rolled GIF parser/LZW decoder (`parseGIF`, `lzwDecode`, `playGIF`) before revealing the app.
   - **Auth gate** — client-side password check against a SHA-256 hash (`PASSWORD_HASH`); session persisted in `localStorage` under `AUTH_KEY` (`lootops_auth_v1`) with a 10-day expiry (`isSessionValid`). This is access gating for a private tool, not real security — the hash and check live entirely in client-side JS.
   - **Names & Items lists** — `renderNamesList`, `addName`, `renderItemsList`, `addOrIncrementItem`, plus per-item quality slider popover (`openQualityPopover`) and detail-label formatting (`abbrType`, `abbrGrade`, `abbrClassCode`, `buildDetailLabel`).
   - **Rolling logic** — `shuffle` (Fisher-Yates) and `assign(names, items, spreadEven, capOne)`, which supports three modes: capped-at-one-per-person, even round-robin spread, or fully random bucketing. `render()` draws the result cards.
   - **History** — `loadHistory`/`saveHistory` persist roll results to `localStorage` under `HISTORY_KEY` (`rollcall_history_v1`); `renderHistory`/`renderHistoryModalList` render the recent list vs. the "older rolls" modal.
   - **Discord webhook integration** — webhook URL stored in `localStorage` (`WEBHOOK_KEY`/`WEBHOOK_ENABLED_KEY`, prefix `rollcall_webhook_*`); `logRoll` posts a formatted embed via `fetch` after each roll, with `trimForEmbed`/`escDiscord` handling Discord's payload constraints.
   - **Star Citizen Wiki integration** — items can be searched/imported from `api.star-citizen.wiki` instead of typed manually. `WIKI_ENDPOINTS`-style per-category URLs (components, weapons, mining heads/modules/gadgets, salvage heads, harvestables, commodities) drive `fetch`-based search with pagination (`extractUuids`, follow `next` links), autocomplete suggestions (`renderWikiSuggestions`, `setActiveSuggestion`, `selectSuggestion`), and category-specific labeling (`humanizeCommodityGroup`).
   - **Misc UI chrome** — custom floating scrollbar thumb and scroll-to-bottom jump button (`updateThumb`, `updateJumpBtn`, `onScroll`).
- All persistence is client-side `localStorage` (no backend) — every `localStorage` call is wrapped in `try/catch` to tolerate private-browsing modes where it's unavailable.

## UI constraint: Names/Items row heights must stay uniform

Every row in the Names list and every row in the Items list (`.entry-row-item` inside `.entry-list`, `#namesList`/`#itemsList`) must render at the exact same height — both within a list and between the two lists. This is a deliberate, non-negotiable visual requirement, not incidental styling.

This has broken in several non-obvious ways in the past, so when touching `.entry-row-item`, `.entry-name`, `.entry-name-text`, `.entry-detail-text`, `.trailing-controls`, `.qty-input`, `.quality-chip`, `.scu-select`, `.entry-remove`, or `.entry-list`:
- Letting the bold item name wrap onto a second line grows that row past the shared ~46px budget (name line + detail line). Long names are instead shown via `fitNameFontSize()` (a canvas-measured auto-shrink down to a 9px floor) before falling back to ellipsis truncation — never let the name itself wrap.
- `.entry-list` uses `scrollbar-gutter:stable` so a list's row width doesn't shift the instant it crosses the scroll threshold — without it, a row already close to the wrap point (e.g. a full Items row with quality chip + SCU select + qty + remove) can wrap only when a scrollbar happens to be present.
- Native form controls (`<select>`, in particular `.scu-select`) render taller than their CSS padding suggests. `.scu-select` and `.quality-chip` both pin an explicit `height` with zeroed vertical padding to match `.qty-input` rather than relying on padding math.
- Verify any change by measuring `getBoundingClientRect().height` on real rows in a live browser (not by reasoning from CSS alone) — check a normal row, the busiest realistic row (long name + quality + SCU + high qty), and a list with exactly enough entries to sit right at its 250px height limit, in both lists.
