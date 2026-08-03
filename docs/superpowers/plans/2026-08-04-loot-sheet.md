# Loot Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Loot Sheet" button next to Share that opens a spacious, dark-themed, standalone results page (grouped by person, plus a "No loot" line and an Unclaimed Items section) in a new browser tab for the current roll.

**Architecture:** Entirely client-side, in `index.html`, following the same pattern as the existing Share feature: a pure `buildLootSheetHtml(result)` function builds a full standalone HTML document string from `lastRollResult`, and a button click wraps it in a `Blob` and opens it via `URL.createObjectURL` in a new tab. One small upstream change is needed first: `lastRollResult` doesn't currently carry the leftover/unclaimed items, only the transient `unwantedItems` variable which can be overwritten by later actions (Reset, Reimport) before the sheet is opened.

**Tech Stack:** Plain JS/HTML/CSS, no framework, no build step — matches the rest of the file.

## Global Constraints

- No physical-print optimization — dark theme throughout, `print-color-adjust: exact` (plus `-webkit-` prefix) so a Save-as-PDF keeps the dark background instead of the browser stripping it.
- Current roll only — no History integration in this pass (per design spec's explicit non-goal).
- No new dependencies, no Worker/backend involvement.
- Quantity is always shown as an "N×" prefix (never omitted at N=1), matching the convention already used everywhere else in the app (`worker/src/index.js`'s `formatItemSummary`, `formatWonItemHtml`, the Share card, Unwanted Items panel).

---

### Task 1: Snapshot leftover items onto `lastRollResult`

**Files:**
- Modify: `index.html:3783` (inside `consumeVoteResults`, right where `unwantedItems` and `lastRollResult` are already set)

**Interfaces:**
- Produces: `lastRollResult.leftover` — an array of `{ name, qty }`, one entry per item nobody voted for in the current roll. Consumed by Task 3's `buildLootSheetHtml`.

- [ ] **Step 1: Capture the leftover snapshot where `unwanted` is already in scope**

In `consumeVoteResults` (`index.html`), find this existing block:

```js
  unwantedItems = unwanted;
  renderUnwantedItems();

  const title = record.title || '';
  const when = new Date().toLocaleString();
  const itemsSnapshot = record.items.map(it => ({
    name: it.name, displayName: it.name, detail: it.info ? `(${it.info})` : '', quality: it.quality, scu: it.scu,
  }));

  render(allNames, buckets, [], title, itemsSnapshot);
  logRoll(allNames, buckets, [], title, when, itemsSnapshot);

  lastRollResult = { title, when, names: allNames.slice(), buckets: buckets.map(b => b.slice()), itemsSnapshot };
```

Replace the `lastRollResult = ...` line with:

```js
  lastRollResult = {
    title, when,
    names: allNames.slice(),
    buckets: buckets.map(b => b.slice()),
    itemsSnapshot,
    leftover: unwanted.map(it => ({ name: it.name, qty: it.qty })),
  };
```

(Everything above that line is unchanged — `unwanted` is the same array already used for `unwantedItems`/`renderUnwantedItems()` a few lines earlier in this function, so no new computation is needed, just capturing it in a smaller shape.)

- [ ] **Step 2: Verify with a throwaway browser check**

Open `index.html` locally (or via `wrangler`-independent static server), log in via the Discord OAuth gate (or temporarily stub a session token in `localStorage` as done in prior manual test sessions), run through a vote → roll cycle that leaves at least one item unclaimed, then in devtools console run:

```js
console.log(lastRollResult.leftover);
```

Expected: an array of `{ name, qty }` matching whatever showed up in the on-screen "Unwanted Items" panel for that roll.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: snapshot leftover items onto lastRollResult"
```

---

### Task 2: `buildLootSheetHtml` — the standalone page builder

**Files:**
- Modify: `index.html` (add new function near `buildShareCardHtml`, e.g. right after it — search for `// ---- Share result modal ----` to locate that region)

**Interfaces:**
- Consumes: a `lastRollResult`-shaped object: `{ title, when, names, buckets, itemsSnapshot, leftover }` (Task 1); `escapeHtml(s)` (already defined, `index.html` — the one near `groupWonItems`, not the DM-inspector one further down); `groupWonItems(bucket)` (already defined).
- Produces: `buildLootSheetHtml(result): string` — a complete HTML document (`<!doctype html>` through `</html>`), used by Task 3's button handler.

- [ ] **Step 1: Write `buildLootSheetHtml`**

Add this function in `index.html`, near `buildShareCardHtml`:

```js
// Builds a full standalone HTML document (not a DOM fragment) for the "Loot Sheet" —
// a spacious, one-column, dark-themed page meant to be read on screen or saved as PDF
// while distributing loot, as opposed to the Share card's compact shareable-image
// layout. Opened in its own browser tab (see the lootSheetBtn handler), so it carries
// its own inline <style> rather than relying on the parent page's stylesheet.
function buildLootSheetHtml(result){
  const itemByName = new Map(result.itemsSnapshot.map(it => [it.name, it]));

  function itemLine(itemName, qty){
    const def = itemByName.get(itemName) || {};
    const bits = ['<span class="ls-qty">' + qty + '×</span>'];
    bits.push(escapeHtml(def.displayName || itemName));
    if(def.quality) bits.push('<span class="ls-qual">Q' + def.quality + '</span>');
    if(def.scu) bits.push('<span class="ls-scu">' + def.scu + ' SCU</span>');
    let html = '<div class="ls-item-line">' + bits.join(' ') + '</div>';
    if(def.detail) html += '<div class="ls-item-detail">' + escapeHtml(def.detail.replace(/^\(|\)$/g, '')) + '</div>';
    return html;
  }

  const personBlocks = [];
  const noLootNames = [];
  result.names.forEach((name, i) => {
    const grouped = groupWonItems(result.buckets[i]);
    if(grouped.length === 0){ noLootNames.push(name); return; }
    const itemsHtml = grouped.map(g => itemLine(g.name, g.qty)).join('');
    personBlocks.push(
      '<section class="ls-person">' +
        '<h2>' + escapeHtml(name) + '</h2>' +
        '<div class="ls-items">' + itemsHtml + '</div>' +
      '</section>'
    );
  });

  const noLootHtml = noLootNames.length
    ? '<p class="ls-no-loot">No loot: ' + noLootNames.map(escapeHtml).join(', ') + '</p>'
    : '';

  const leftover = result.leftover || [];
  const leftoverHtml = leftover.length
    ? '<section class="ls-leftover"><h2>Unclaimed Items</h2><div class="ls-items">' +
        leftover.map(it => '<div class="ls-item-line"><span class="ls-qty">' + it.qty + '×</span>' + escapeHtml(it.name) + '</div>').join('') +
      '</div></section>'
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(result.title || 'Loot Sheet')} — Loot Sheet</title>
<style>
  :root{
    --bg:#14151A; --panel:#1D1F26; --panel-2:#23252E; --line:#31333F;
    --gold:#E8A33D; --violet:#7C6FF0; --text:#EDEDED; --muted:#8A8F98;
  }
  *{box-sizing:border-box;}
  html, body{
    background:var(--bg); color:var(--text);
    font-family:'IBM Plex Mono', 'Consolas', monospace;
    margin:0; padding:40px 24px 80px;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .ls-wrap{max-width:760px; margin:0 auto;}
  header{margin-bottom:32px;}
  header h1{
    font-family:'Space Grotesk', sans-serif; font-size:28px; margin:0 0 6px;
  }
  header .ls-when{color:var(--muted); font-size:13px;}
  .ls-person{
    background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:20px 24px; margin-bottom:18px;
  }
  .ls-person h2{
    font-family:'Space Grotesk', sans-serif; font-size:20px; margin:0 0 14px;
    color:var(--gold);
  }
  .ls-items{display:flex; flex-direction:column; gap:12px;}
  .ls-item-line{font-size:16px; line-height:1.4;}
  .ls-qty{color:var(--gold); font-weight:700; margin-right:6px;}
  .ls-qual{color:var(--violet); margin-left:8px;}
  .ls-scu{color:var(--muted); margin-left:8px;}
  .ls-item-detail{color:var(--muted); font-size:12.5px; margin-top:2px;}
  .ls-no-loot{color:var(--muted); font-size:14px; margin:24px 0;}
  .ls-leftover{
    background:var(--panel-2); border:1px dashed var(--line); border-radius:12px;
    padding:20px 24px; margin-top:24px;
  }
  .ls-leftover h2{
    font-family:'Space Grotesk', sans-serif; font-size:16px; margin:0 0 12px; color:var(--muted);
  }
</style>
</head>
<body>
  <div class="ls-wrap">
    <header>
      <h1>${escapeHtml(result.title || 'Loot Sheet')}</h1>
      <div class="ls-when">${escapeHtml(result.when || '')}</div>
    </header>
    ${personBlocks.join('')}
    ${noLootHtml}
    ${leftoverHtml}
  </div>
</body>
</html>`;
}
```

- [ ] **Step 2: Verify with a throwaway browser check**

With `lastRollResult` populated (from Task 1's verification, or set manually in devtools to a small fake shape matching `{ title, when, names, buckets, itemsSnapshot, leftover }`), run in the console:

```js
const html = buildLootSheetHtml(lastRollResult);
console.log(html.length > 0, html.includes('<!doctype html>'));
document.open(); document.write(html); document.close(); // eyeball it in the current tab, throwaway only
```

Expected: `true true` logged, and the temporarily-overwritten page shows readable person blocks. Reload the actual app afterward (this step intentionally trashes the current tab's DOM — that's fine, it's a throwaway check, not a real test of the tab-opening mechanism, which Task 3 covers).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add buildLootSheetHtml for the standalone loot sheet page"
```

---

### Task 3: Loot Sheet button

**Files:**
- Modify: `index.html` (markup: the `.roll-row` containing `#shareBtn`, around `index.html:1700`; JS: near `shareBtn.addEventListener('click', ...)`)

**Interfaces:**
- Consumes: `buildLootSheetHtml` (Task 2), `lastRollResult`, `shareBtn`'s existing enable/disable pattern (mirrored, not shared — this button gets its own `disabled`/`.ready` handling tied to the same `lastRollResult` lifecycle).

- [ ] **Step 1: Add the button markup next to Share**

In `index.html`, find:

```html
  <div class="roll-row">
    <button id="shareBtn" type="button" disabled aria-label="Share result">
      <svg class="btn-bg-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 15l6-6"/>
        <path d="M13 6.5l1-1a3.5 3.5 0 0 1 5 5l-1.5 1.5"/>
        <path d="M11 17.5l-1 1a3.5 3.5 0 0 1-5-5l1.5-1.5"/>
      </svg>
      <span class="btn-label">Share</span>
    </button>
  </div>
```

Replace with:

```html
  <div class="roll-row">
    <button id="shareBtn" type="button" disabled aria-label="Share result">
      <svg class="btn-bg-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 15l6-6"/>
        <path d="M13 6.5l1-1a3.5 3.5 0 0 1 5 5l-1.5 1.5"/>
        <path d="M11 17.5l-1 1a3.5 3.5 0 0 1-5-5l1.5-1.5"/>
      </svg>
      <span class="btn-label">Share</span>
    </button>
    <button id="lootSheetBtn" type="button" class="ghost-btn" disabled aria-label="Open loot sheet">
      <span class="btn-label">📋 Loot Sheet</span>
    </button>
  </div>
```

- [ ] **Step 2: Add the click handler and enable/disable wiring**

Right after the existing `shareBtn.addEventListener('click', () => openShareModal());` line, add:

```js
const lootSheetBtn = document.getElementById('lootSheetBtn');
lootSheetBtn.addEventListener('click', () => {
  if(!lastRollResult) return;
  const html = buildLootSheetHtml(lastRollResult);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
});
```

Then, in `consumeVoteResults` (`index.html`, same block Task 1 touched), find:

```js
  shareBtn.disabled = false;
  shareBtn.classList.add('ready');
```

Replace with:

```js
  shareBtn.disabled = false;
  shareBtn.classList.add('ready');
  lootSheetBtn.disabled = false;
```

Also find the `resetRollState()` function (`index.html`, shared by the Reset button and Reimport — added in a previous session) and, right after:

```js
  shareBtn.disabled = true;
  shareBtn.classList.remove('ready');
```

add:

```js
  lootSheetBtn.disabled = true;
```

so the Loot Sheet button's enabled state tracks `lastRollResult` exactly the way Share's already does — including going back to disabled on Reset/Reimport, since `resetRollState()` also clears `lastRollResult = null`.

- [ ] **Step 3: Manual end-to-end verification in a browser**

1. Run through a vote → roll cycle (or use the app's existing manual-roll path if testing without live Discord) that produces at least one winner, at least one participant with nothing, and at least one unclaimed item.
2. Confirm "Loot Sheet" is disabled before any roll, and enabled immediately after — same moment Share becomes enabled.
3. Click it — confirm a new tab opens with: a header (title + timestamp), one card per winner with their items spaciously listed (name, qty as "N×" prefix, quality/SCU where applicable), a "No loot: ..." line naming anyone who won nothing, and an "Unclaimed Items" section listing anything nobody voted for.
4. Confirm the new tab is fully standalone — closing the original app tab doesn't affect it, and it has its own dark styling with no dependency on the app's own stylesheet.
5. Click Reset (or Reimport) in the main app — confirm "Loot Sheet" goes back to disabled.
6. Try the browser's print dialog → Save as PDF on the loot sheet tab — confirm the dark background and gold/violet accent colors are preserved in the output (may require the browser's "background graphics" print option to be on; note this to the user if it isn't preserved by default).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add Loot Sheet button opening a standalone per-person results page"
```

---

## Plan self-review notes

- **Spec coverage:** header/timestamp, per-person spacious blocks, "No loot" line, Unclaimed Items section, new-tab presentation, dark theme + print-color-adjust, current-roll-only scope, button placement next to Share — all covered across the three tasks.
- **No placeholders:** all code blocks are complete and runnable.
- **Type/name consistency:** `lastRollResult.leftover` (Task 1) is consumed by name in `buildLootSheetHtml` (Task 2); `buildLootSheetHtml` (Task 2) is called by name in the `lootSheetBtn` handler (Task 3); `lootSheetBtn` disable/enable mirrors `shareBtn`'s existing call sites exactly (`consumeVoteResults` and `resetRollState`).
