# Loot Sheet — Design

## Problem

Once a vote-driven roll finishes, results are shown as compact on-screen cards, and can be exported as a ranked, balanced two-column Share card meant for posting back to Discord. Neither is well suited to the person who's actually handing out loot in voice/Discord chat and needs to read down a list, person by person, without visual clutter — the Share card's tight balanced-column layout optimizes for looking good as a shareable image, not for being read at a glance while distributing items.

## Goal

A dedicated "loot sheet" for the roll currently on screen: one person per block, spacious and easy to scan, plus a one-line callout for anyone who won nothing and a section for anything nobody claimed.

## Non-goals

- Not for physical printing — the design targets on-screen reading or Save-as-PDF from the browser, so it keeps the app's dark theme rather than switching to a light print stylesheet.
- Not available for past rolls in Roll History — only the current roll (matches how Share already works).

## Design

### Trigger

A new **"Loot Sheet"** button sits next to the existing Share button, sharing its enable/disable lifecycle (disabled until a roll exists, enabled once `lastRollResult` is set).

### Presentation

Clicking it builds a full standalone HTML document as a string, wraps it in a `Blob`, and opens it via `URL.createObjectURL(...)` in a new browser tab (`window.open(url, '_blank')`). The new tab is a real, independent page — no dependency on the main app's DOM/CSS — so it can be left open on a second monitor, refreshed, or saved as PDF via the browser's own print dialog. The generated page's CSS includes `print-color-adjust: exact` (and the `-webkit-` prefix) so the dark background and colors survive a Save-as-PDF export rather than being stripped to plain black-on-white.

### Content

1. **Header** — roll title and the roll's timestamp (`lastRollResult.when`).
2. **Per-person blocks**, one per winner, in the order they appear in `lastRollResult.names`/`buckets` (skipping anyone with an empty bucket — they're handled by the "No loot" line instead): a clear name heading, then a spacious single-column list of everything they won — item name, quality (if any), SCU (if any), and quantity as an always-shown "N×" prefix — reusing the same data/formatting conventions as the existing `formatWonItemHtml` (via `itemsSnapshot`), just laid out generously (larger text, more line spacing, no balanced-column masonry) instead of packed tightly like the Share card.
3. **"No loot" line** — a single line, e.g. "No loot: Alice, Bob", listing anyone in `lastRollResult.names` whose bucket came back empty. Omitted entirely if everyone won something.
4. **"Unclaimed Items" section** — at the bottom, listing any items nobody voted for at all (the same leftover set the in-app "Unwanted Items" panel already shows), each as "N× Item Name". Omitted entirely if there were none.

### Data

No new data plumbing for winners/no-loot — `lastRollResult` (`{ title, when, names, buckets, itemsSnapshot }`) already has everything needed: winners are names with a non-empty bucket, "no loot" is names with an empty one.

One addition needed: the **leftover/unclaimed items** aren't currently part of `lastRollResult` (only the transient `unwantedItems` module variable, which can be cleared/replaced by later actions like Reset or another Reimport before the sheet is opened). `consumeVoteResults()` — where `lastRollResult` is built and where `unwantedItems` is already computed in the same breath — is extended to also snapshot `leftover: unwanted.slice()` onto `lastRollResult`, so the sheet stays accurate regardless of what the user does in the app afterward.

### Implementation shape

- `buildLootSheetHtml(result)` — pure function, takes `lastRollResult`-shaped data, returns a complete HTML document string (doctype, inline `<style>` using the app's existing color values as literal CSS since the new tab has no access to the parent page's stylesheet, and the body markup described above).
- A `lootSheetBtn` click handler mirrors `shareBtn`'s existing pattern: guard on `lastRollResult` existing, call `buildLootSheetHtml`, open it via Blob URL.
- No Worker/backend involvement — this is entirely client-side, matching how Share already works.
