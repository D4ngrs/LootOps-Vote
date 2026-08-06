# Sandbox Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Sandbox Mode" to LootOps-Vote that exercises the full post/vote/roll UI without ever calling the Cloudflare Worker or posting to Discord, using a fake-reactions editor in place of real Discord reactions.

**Architecture:** A single boolean flag (`rollcall_sandbox_mode_v1`) gates a parallel `localStorage` namespace for roll history and the pending-vote pointer, plus local stand-ins for the five Worker endpoints the vote lifecycle normally calls. Two non-modal floating panels (a new, reusable UI component) show what would have been posted to Discord at the "post vote" and "finalize" steps. The existing Vote Status panel, roll logic (`consumeVoteResults`), results card, roll history, Share, Loot Sheet, and "Reimport unclaimed items" are all reused unmodified - they just end up pointed at fake data instead of real data.

**Tech Stack:** Vanilla JS, inline in `index.html` (no build step, no framework - see project CLAUDE.md).

## Global Constraints

- No build/lint/test command exists for this project - every task's manual verification means opening `index.html` in a browser (a simple static server is fine) and exercising the feature by hand, per project CLAUDE.md.
- Never use an em dash in any user-facing text (app UI, dialogs, hints) - standing project rule.
- The Names/Items list row-height uniformity rule (project CLAUDE.md) does not apply to this feature - no changes are made to `.entry-row-item`, `#namesList`, or `#itemsList`.
- Sandbox state key: `rollcall_sandbox_mode_v1` (boolean, stored as `'1'`/absent).
- Sandbox history key: `rollcall_vote_test_history_v1`.
- Sandbox pending-vote key: `rollcall_vote_test_pending_v1`.
- Sandbox vote record key: `rollcall_vote_test_record_v1`.
- Fake name pool (exactly these 10, in this order): `Test Alpha, Test Bravo, Test Charlie, Test Delta, Test Echo, Test Foxtrot, Test Golf, Test Hotel, Test India, Test Juliett`. Reaction counts are capped at 10.
- Toggle button text: `Enter Sandbox Mode` (off) / `Leave Sandbox Mode` (on).
- Mode-switch confirm text (only shown if a real vote is pending when entering Sandbox Mode): `A live vote is still running and won't be affected. Enter Sandbox Mode anyway?`
- Indicator color: `#FF7A1A` (distinct from every existing `--gold`/`--violet`/`--green`/`--bad` value already in the palette).
- Spec reference: `docs/superpowers/specs/2026-08-06-sandbox-mode-design.md`.

---

### Task 1: Sandbox Mode toggle, state, and visual indicator

**Files:**
- Modify: `index.html` (CSS block near line 934, HTML near line 1552 and line 1636, JS near line 3608)

**Interfaces:**
- Produces: `isSandboxMode(): boolean`, `setSandboxMode(on: boolean): void` - used by every later task to branch behavior.

- [ ] **Step 1: Add the indicator CSS**

Find the `.modal-panel{` rule (search for `.modal-panel{` - it starts a block around line 934) and insert this new block immediately before it:

```css
  #sandboxFrame{
    position:fixed; inset:0; pointer-events:none; z-index:9999;
    border:6px solid #FF7A1A; box-sizing:border-box;
  }
  #sandboxFrame.hidden{display:none;}
  #sandboxBadge{
    position:fixed; top:0; left:50%; transform:translateX(-50%);
    z-index:10000;
    background:#FF7A1A; color:#14151A;
    font-family:'IBM Plex Mono', monospace; font-weight:700; font-size:11px;
    letter-spacing:.08em; text-transform:uppercase;
    padding:4px 14px; border-radius:0 0 8px 8px;
    pointer-events:none;
  }
  #sandboxBadge.hidden{display:none;}

```

- [ ] **Step 2: Add the frame/badge markup to the body**

Find `<div id="bgWatermark"></div>` (unique string, near line 1552) and insert immediately after it:

```html
<div id="sandboxFrame" class="hidden"></div>
<div id="sandboxBadge" class="hidden">Sandbox Mode</div>
```

- [ ] **Step 3: Add the toggle button to the Discord Settings modal**

Find this exact block (search for `<div class="modal-status" id="historyWebhookStatus"></div>`):

```html
      <div class="modal-status" id="historyWebhookStatus"></div>

      <hr class="modal-divider">

      <div class="modal-title">Discord Vote Worker</div>
```

Replace it with:

```html
      <div class="modal-status" id="historyWebhookStatus"></div>

      <hr class="modal-divider">

      <div class="modal-title">Sandbox Mode</div>
      <div class="modal-hint">Test the full post/vote/roll flow without contacting Discord or the Worker. Fake reaction counts stand in for real Discord reactions, and rolls go to a separate history so they never mix with real ones.</div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" id="sandboxModeBtn">Enter Sandbox Mode</button>
      </div>

      <hr class="modal-divider">

      <div class="modal-title">Discord Vote Worker</div>
```

- [ ] **Step 4: Add the state functions and toggle handler**

Find the line `// ---- Discord Vote Worker connection ----` (near line 3608) and insert this new block immediately before it:

```javascript
// ---- Sandbox Mode ----
// Gates a parallel localStorage namespace (see loadHistory/saveHistory and
// loadPendingVote/savePendingVote/clearPendingVote below) and local stand-ins
// for the Worker's vote-lifecycle endpoints, so the full post/vote/roll UI
// can be exercised without ever contacting the Worker or Discord.
const SANDBOX_MODE_KEY = 'rollcall_sandbox_mode_v1';

function isSandboxMode(){
  try{ return localStorage.getItem(SANDBOX_MODE_KEY) === '1'; }
  catch(e){ return false; }
}

function updateSandboxIndicator(){
  const on = isSandboxMode();
  document.getElementById('sandboxFrame').classList.toggle('hidden', !on);
  document.getElementById('sandboxBadge').classList.toggle('hidden', !on);
  const btn = document.getElementById('sandboxModeBtn');
  if(btn) btn.textContent = on ? 'Leave Sandbox Mode' : 'Enter Sandbox Mode';
}

async function setSandboxMode(on){
  if(on && loadPendingVote()){
    // loadPendingVote() at this point still reads the *current* mode's key -
    // if we're not in sandbox mode yet, this checks the real pending vote.
    const proceed = await confirmModal("A live vote is still running and won't be affected. Enter Sandbox Mode anyway?", 'Enter Sandbox Mode');
    if(!proceed) return;
  }
  try{
    if(on) localStorage.setItem(SANDBOX_MODE_KEY, '1');
    else localStorage.removeItem(SANDBOX_MODE_KEY);
  }catch(e){ /* storage unavailable, ignore */ }
  updateSandboxIndicator();
  renderVoteStatus();
  renderHistory();
  if(!historyOverlay.classList.contains('hidden')) renderHistoryModalList();
}

document.getElementById('sandboxModeBtn').addEventListener('click', () => {
  setSandboxMode(!isSandboxMode());
});

updateSandboxIndicator();

```

Note: this step references `loadPendingVote`, `confirmModal`, `renderVoteStatus`, `renderHistory`, `historyOverlay`, and `renderHistoryModalList`, all of which already exist elsewhere in the file (or are modified by Task 2) - `setSandboxMode` is written now but only becomes fully correct once Task 2's key resolvers are in place. That's fine; this task's own verification (Step 5) only exercises the toggle/indicator, not history/pending-vote switching.

- [ ] **Step 5: Manual verification**

Open `index.html` in a browser, log in, open Discord Settings. Confirm:
1. A "Sandbox Mode" section appears above "Discord Vote Worker" with an "Enter Sandbox Mode" button.
2. Clicking it (with no vote pending) immediately flips the button to "Leave Sandbox Mode", and closing the modal shows a thick orange border around the viewport plus a "Sandbox Mode" badge at the top center. Neither blocks clicking anything underneath.
3. Reloading the page keeps Sandbox Mode on (border/badge still visible, button still reads "Leave Sandbox Mode" after reopening Settings).
4. Clicking "Leave Sandbox Mode" removes the border/badge and flips the button back.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: add Sandbox Mode toggle and visual indicator"
```

---

### Task 2: Parallel storage namespace for history and pending-vote

**Files:**
- Modify: `index.html` (near line 3214 `HISTORY_KEY`, near line 3931 `PENDING_VOTE_KEY`)

**Interfaces:**
- Consumes: `isSandboxMode()` from Task 1.
- Produces: `loadHistory()`, `saveHistory(entries)`, `loadPendingVote()`, `savePendingVote(vote)`, `clearPendingVote()` now transparently route to sandbox-scoped keys when `isSandboxMode()` is true - no signature changes, so every existing caller (History modal, Share, Loot Sheet, "Reimport unclaimed items", the whole vote-status flow) keeps working unmodified.

- [ ] **Step 1: Add key resolvers and update history storage**

Find:

```javascript
const HISTORY_KEY = 'rollcall_vote_history_v1';

function loadHistory(){
  try{
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}

function saveHistory(entries){
  try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); }catch(e){ /* storage unavailable, ignore */ }
}
```

Replace with:

```javascript
const HISTORY_KEY = 'rollcall_vote_history_v1';
const SANDBOX_HISTORY_KEY = 'rollcall_vote_test_history_v1';

function historyKey(){
  return isSandboxMode() ? SANDBOX_HISTORY_KEY : HISTORY_KEY;
}

function loadHistory(){
  try{
    const raw = localStorage.getItem(historyKey());
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}

function saveHistory(entries){
  try{ localStorage.setItem(historyKey(), JSON.stringify(entries)); }catch(e){ /* storage unavailable, ignore */ }
}
```

- [ ] **Step 2: Update pending-vote storage**

Find:

```javascript
const PENDING_VOTE_KEY = 'rollcall_vote_pending_v1';

function loadPendingVote(){
  try{ const raw = localStorage.getItem(PENDING_VOTE_KEY); return raw ? JSON.parse(raw) : null; }
  catch(e){ return null; }
}
function savePendingVote(vote){
  try{ localStorage.setItem(PENDING_VOTE_KEY, JSON.stringify(vote)); }catch(e){ /* ignore */ }
}
function clearPendingVote(){
  try{ localStorage.removeItem(PENDING_VOTE_KEY); }catch(e){ /* ignore */ }
}
```

Replace with:

```javascript
const PENDING_VOTE_KEY = 'rollcall_vote_pending_v1';
const SANDBOX_PENDING_VOTE_KEY = 'rollcall_vote_test_pending_v1';

function pendingVoteKey(){
  return isSandboxMode() ? SANDBOX_PENDING_VOTE_KEY : PENDING_VOTE_KEY;
}

function loadPendingVote(){
  try{ const raw = localStorage.getItem(pendingVoteKey()); return raw ? JSON.parse(raw) : null; }
  catch(e){ return null; }
}
function savePendingVote(vote){
  try{ localStorage.setItem(pendingVoteKey(), JSON.stringify(vote)); }catch(e){ /* ignore */ }
}
function clearPendingVote(){
  try{ localStorage.removeItem(pendingVoteKey()); }catch(e){ /* ignore */ }
}
```

- [ ] **Step 3: Manual verification**

Open the app, log in, open devtools console.
1. With Sandbox Mode off, roll something (or just run `saveHistory([{when:'x',title:'live-test',names:[],buckets:[],leftover:[]}])` in the console), then check `localStorage.getItem('rollcall_vote_history_v1')` contains it and `localStorage.getItem('rollcall_vote_test_history_v1')` is untouched.
2. Enter Sandbox Mode (via the Settings button), run `saveHistory([{when:'x',title:'sandbox-test',names:[],buckets:[],leftover:[]}])`, then confirm `rollcall_vote_test_history_v1` now holds it and `rollcall_vote_history_v1` is unchanged from step 1.
3. Open the History modal while in Sandbox Mode - it should show only `sandbox-test`. Leave Sandbox Mode and reopen History - it should show only `live-test`.
4. Clean up: run `localStorage.removeItem('rollcall_vote_history_v1'); localStorage.removeItem('rollcall_vote_test_history_v1');` in the console before moving on, so this smoke-test data doesn't linger.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: route roll history and pending-vote storage through a Sandbox Mode namespace"
```

---

### Task 3: Sandbox vote record storage and text-formatting helpers

**Files:**
- Modify: `index.html` (new code block placed near line 3931, just above the `PENDING_VOTE_KEY` constant from Task 2)

**Interfaces:**
- Consumes: `escapeHtml(s)` (existing, line 2819), `formatCountdown(msLeft)` (existing - defined at line 4007, textually *after* this task's insertion point, but that's fine: it's a `function` declaration, which is hoisted, so `buildSandboxVoteMessageText`'s call to it resolves correctly regardless of definition order, since it's only ever invoked later at runtime, not at parse time).
- Produces: `FAKE_NAME_POOL: string[]`, `pickFakeNames(count): string[]`, `loadSandboxRecord()`, `saveSandboxRecord(record)`, `clearSandboxRecord()`, `formatItemSummaryText(it)`, `mdPreviewToHtml(text)`, `buildSandboxVoteMessageText(record)`, `buildSandboxResultsBlocks(record, names, buckets, leftover, spreadEven, capOne)` - all consumed by Tasks 5-7.

- [ ] **Step 1: Add the helpers**

Insert this block immediately above the `const PENDING_VOTE_KEY = ...` line (from Task 2):

```javascript
// ---- Sandbox Mode: fake vote record + Discord-message-preview text ----
// The record shape mirrors exactly what the Worker's KV would hold for a real
// vote ({ id, items, title, roleId, flavorText, createdAt, deadline, status,
// results, finalizedAt }), and record.results uses the exact same shape
// consumeVoteResults() already reads from a real vote ({ "<itemIndex>":
// ["voterName", ...] }) - so a sandbox record can be handed to
// consumeVoteResults() completely unmodified once finalized (see Task 7).
const SANDBOX_RECORD_KEY = 'rollcall_vote_test_record_v1';

function loadSandboxRecord(){
  try{ const raw = localStorage.getItem(SANDBOX_RECORD_KEY); return raw ? JSON.parse(raw) : null; }
  catch(e){ return null; }
}
function saveSandboxRecord(record){
  try{ localStorage.setItem(SANDBOX_RECORD_KEY, JSON.stringify(record)); }catch(e){ /* ignore */ }
}
function clearSandboxRecord(){
  try{ localStorage.removeItem(SANDBOX_RECORD_KEY); }catch(e){ /* ignore */ }
}

const FAKE_NAME_POOL = [
  'Test Alpha', 'Test Bravo', 'Test Charlie', 'Test Delta', 'Test Echo',
  'Test Foxtrot', 'Test Golf', 'Test Hotel', 'Test India', 'Test Juliett',
];

// Draws `count` distinct names at random from the shared pool (capped at the
// pool size) - shared across every item in a sandbox vote, so the same fake
// name can end up claiming multiple items, letting the grouped-by-person
// results view be tested realistically.
function pickFakeNames(count){
  const n = Math.max(0, Math.min(count, FAKE_NAME_POOL.length));
  const shuffled = FAKE_NAME_POOL.slice();
  for(let i = shuffled.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// Plain-text port of the Worker's formatItemSummary (worker/src/index.js) -
// duplicated rather than shared, since the frontend and Worker are separate
// deployables with no build step or shared module system between them.
function formatItemSummaryText(it){
  const namePart = `${it.qty}× **${it.name}**` + (it.info ? ` _(${it.info})_` : '');
  const segments = [namePart];
  if(it.quality !== null && it.quality !== undefined) segments.push('Q' + it.quality);
  if(it.scu !== null && it.scu !== undefined) segments.push(it.scu + ' SCU');
  return segments.join('  |  ');
}

// Converts the small subset of Discord markdown this preview actually
// produces (**bold**, _italic_, newlines) into HTML for display in a
// floating panel - intentionally not a full markdown parser.
function mdPreviewToHtml(text){
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

// Plain-text port of the Worker's formatBatchContent, deliberately scoped
// down: no per-item Discord emoji assignment and no 20-reactions-per-message
// batching, since both exist only to satisfy Discord's own reaction cap and
// aren't meaningful to replicate in a preview that never actually posts.
function buildSandboxVoteMessageText(record){
  const lines = [];
  if(record.roleId) lines.push(`(would ping role ${record.roleId})`);
  const titleLine = `**${record.title || 'LootOps Vote'}**`;
  lines.push(titleLine);
  if(record.status === 'ready' || record.status === 'aborted'){
    lines.push('Voting closed.');
  }else{
    lines.push(`Voting closes in ${formatCountdown(record.deadline - Date.now())}`);
  }
  if(record.flavorText) lines.push(record.flavorText);
  lines.push('React to claim interest:');
  record.items.forEach((it, i) => {
    lines.push(`${i + 1}.  |  ` + formatItemSummaryText(it));
  });
  return lines.join('\n');
}

// Plain-text port of the Worker's announceResults two-embed content. Returns
// { main: {title, fields}, results: {title, fields} } where each field is
// [label, value] - the caller (Task 7's openResultsPreviewWindow) is
// responsible for rendering these as styled blocks.
function buildSandboxResultsBlocks(record, names, buckets, leftover, spreadEven, capOne){
  const itemMetaByName = new Map(record.items.map(it => [it.name, it]));
  function groupWon(bucket){
    const counts = new Map();
    bucket.forEach(n => counts.set(n, (counts.get(n) || 0) + 1));
    return Array.from(counts.entries());
  }
  const participantsText = names.join(', ') || '-';
  const lootPoolText = record.items.map(formatItemSummaryText).join('\n') || '-';
  const resultsText = names.length
    ? names.map((name, i) => {
        const got = buckets[i] || [];
        if(!got.length) return `**${name}:**\n_nothing_`;
        const itemLines = groupWon(got).map(([itemName, qty]) => {
          const meta = itemMetaByName.get(itemName) || {};
          return formatItemSummaryText({ name: itemName, info: meta.info, quality: meta.quality, scu: meta.scu, qty });
        }).join('\n');
        return `**${name}:**\n${itemLines}`;
      }).join('\n\n')
    : '_No one reacted to any item._';

  const main = {
    title: record.title || 'Untitled Roll',
    fields: [
      ['Date & Time', new Date().toLocaleString()],
      ['Participants', participantsText],
      ['Roll Mode', `Spread evenly: ${spreadEven ? 'Yes' : 'No'}\nCap at 1 item: ${capOne ? 'Yes' : 'No'}`],
      ['Loot Pool', lootPoolText],
    ],
  };
  const resultsFields = [['Results', resultsText]];
  if(leftover && leftover.length) resultsFields.push(['Unclaimed Items (no reactions)', leftover.join(', ')]);
  const results = {
    title: (record.title ? record.title + ' - ' : '') + 'Results',
    fields: resultsFields,
  };
  return { main, results };
}

```

- [ ] **Step 3: Manual verification (console smoke test)**

Open the app in a browser, open devtools console, and run:

```javascript
pickFakeNames(3) // should log an array of 3 distinct names from the pool, different each call
pickFakeNames(15) // should log all 10 pool names (capped), not throw
formatItemSummaryText({ name: 'Gold', qty: 2, info: null, quality: 3, scu: null }) // "2× **Gold**  |  Q3"
mdPreviewToHtml('**bold** and _italic_\nnext line') // '<strong>bold</strong> and <em>italic</em><br>next line'
buildSandboxVoteMessageText({ title: 'Test Vote', deadline: Date.now() + 3600000, items: [{ name: 'Gold', qty: 2, info: null, quality: null, scu: null }], status: 'pending' })
// should log a multi-line string starting with "**Test Vote**", a "Voting closes in ..." line, "React to claim interest:", then "1.  |  2× **Gold**"
buildSandboxResultsBlocks(
  { title: 'Test Vote', items: [{ name: 'Gold', qty: 2, info: null, quality: null, scu: null }] },
  ['Alice'], [['Gold','Gold']], [], true, false
)
// should log { main: {...}, results: {...} } with Participants "Alice" and Results text "**Alice:**\n2× **Gold**"
```

Confirm each call returns the shape described and nothing throws.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add Sandbox Mode vote-record storage and Discord-preview formatting helpers"
```

---

### Task 4: Reusable non-modal floating panel component

**Files:**
- Modify: `index.html` (CSS near line 934, JS near the end of Task 3's insertion point)

**Interfaces:**
- Produces: `createFloatingPanel({ title, bodyHtml, defaultRight, defaultTop }): { el: HTMLElement, close(): void, setBody(html: string): void }` - consumed by Tasks 5 and 7 (Window 1 and Window 2 are both instances of this).

- [ ] **Step 1: Add the floating panel CSS**

Insert this immediately after the `#sandboxBadge.hidden{display:none;}` rule added in Task 1, Step 1:

```css
  .floating-panel{
    position:fixed;
    z-index:9500;
    background:var(--panel);
    border:1px solid var(--line);
    border-radius:12px;
    box-shadow:6px 10px 32px rgba(0,0,0,0.5);
    width:360px;
    max-width:calc(100vw - 32px);
    max-height:calc(100vh - 32px);
    display:flex;
    flex-direction:column;
  }
  .floating-panel-head{
    display:flex; justify-content:space-between; align-items:center;
    padding:14px 16px; border-bottom:1px solid var(--line);
    cursor:move; user-select:none; flex:0 0 auto;
  }
  .floating-panel-title{
    font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:14px; color:var(--text);
  }
  .floating-panel-close{
    background:transparent; border:none; color:var(--bad);
    font-size:18px; line-height:1; cursor:pointer; padding:2px 6px; border-radius:4px;
  }
  .floating-panel-close:hover{background:var(--panel-2);}
  .floating-panel-body{
    padding:16px; overflow-y:auto; font-size:12.5px; color:var(--text); line-height:1.5;
  }

```

- [ ] **Step 2: Add the component function**

Insert this immediately after `buildSandboxResultsBlocks`'s closing brace from Task 3:

```javascript
// ---- Reusable non-modal floating panel ----
// Unlike the app's existing .modal-overlay/.modal-panel dialogs (which block
// interaction with the rest of the page via a backdrop), this has no backdrop
// and can be dragged around by its header - the rest of the page stays fully
// interactive while it's open. Used by Sandbox Mode's Window 1 and Window 2.
function createFloatingPanel({ title, bodyHtml, defaultRight = 24, defaultTop = 80 }){
  const panel = document.createElement('div');
  panel.className = 'floating-panel';
  panel.style.top = defaultTop + 'px';
  panel.style.right = defaultRight + 'px';
  panel.innerHTML =
    '<div class="floating-panel-head">' +
      '<div class="floating-panel-title"></div>' +
      '<button type="button" class="floating-panel-close" aria-label="Close">×</button>' +
    '</div>' +
    '<div class="floating-panel-body"></div>';
  panel.querySelector('.floating-panel-title').textContent = title;
  panel.querySelector('.floating-panel-body').innerHTML = bodyHtml;
  document.body.appendChild(panel);

  const head = panel.querySelector('.floating-panel-head');
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  head.addEventListener('pointerdown', e => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', e => {
    if(!dragging) return;
    panel.style.left = (startLeft + (e.clientX - startX)) + 'px';
    panel.style.top = (startTop + (e.clientY - startY)) + 'px';
  });
  head.addEventListener('pointerup', () => { dragging = false; });

  const close = () => panel.remove();
  panel.querySelector('.floating-panel-close').addEventListener('click', close);

  return {
    el: panel,
    close,
    setBody: html => { panel.querySelector('.floating-panel-body').innerHTML = html; },
  };
}

```

- [ ] **Step 3: Manual verification (console smoke test)**

Open the app in a browser, open devtools console, and run:

```javascript
const p = createFloatingPanel({ title: 'Test Panel', bodyHtml: '<p>hello</p>' });
```

Confirm:
1. A panel appears near the top-right of the viewport, styled like the app's other modals (dark panel background, rounded corners) but with no dimmed backdrop - clicking/typing elsewhere on the page still works.
2. It has a bottom-right-offset drop shadow.
3. Dragging its header (title bar) moves it around the viewport smoothly.
4. Clicking the × closes it (`p.el.isConnected` should now log `false`).
5. Run `p.setBody('<p>updated</p>')` before closing - confirm the body content changes without moving/recreating the panel.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add reusable non-modal floating panel component"
```

---

### Task 5: Sandbox branch for posting a vote (Window 1)

**Files:**
- Modify: `index.html` (the `postVoteBtn` click handler, search for `postVoteBtn.addEventListener('click'`)

**Interfaces:**
- Consumes: `isSandboxMode()`, `saveSandboxRecord`, `loadSandboxRecord`, `pickFakeNames`, `buildSandboxVoteMessageText`, `mdPreviewToHtml`, `createFloatingPanel`, `buildVoteItemsPayload()` (existing), `savePendingVote` (existing, now sandbox-aware via Task 2).
- Produces: `openFakeVoteWindow(record)` - also consumed by Task 6 (the "reopen" button).

- [ ] **Step 1: Add the fake-vote window builder**

Insert this immediately after `createFloatingPanel`'s closing brace from Task 4:

```javascript
// ---- Sandbox Mode: Window 1 (fake vote / reactions editor) ----
let fakeVoteWindow = null;

function renderFakeVoteWindowBody(record){
  const messageHtml = mdPreviewToHtml(buildSandboxVoteMessageText(record));
  const rowsHtml = record.items.map((it, i) => {
    const current = (record.results && record.results[String(i)]) || [];
    return (
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid var(--line);">' +
        '<span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(it.name) + '</span>' +
        '<input type="number" min="0" max="10" value="' + current.length + '" data-item-index="' + i + '" class="entry-input sandbox-reaction-count" style="width:56px; padding:6px 8px;">' +
      '</div>'
    );
  }).join('');
  return (
    '<div style="background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:14px; white-space:pre-wrap;">' + messageHtml + '</div>' +
    '<div class="modal-label" style="margin-bottom:6px;">Fake reaction counts</div>' +
    rowsHtml
  );
}

function wireFakeVoteWindowInputs(win, record){
  win.el.querySelectorAll('.sandbox-reaction-count').forEach(input => {
    input.addEventListener('change', () => {
      const i = Number(input.dataset.itemIndex);
      let count = Math.max(0, Math.min(10, Math.floor(Number(input.value)) || 0));
      input.value = count;
      const current = loadSandboxRecord();
      if(!current) return;
      current.results = current.results || {};
      current.results[String(i)] = pickFakeNames(count);
      saveSandboxRecord(current);
      win.setBody(renderFakeVoteWindowBody(current));
      wireFakeVoteWindowInputs(win, current);
    });
  });
}

function openFakeVoteWindow(record){
  if(fakeVoteWindow) fakeVoteWindow.close();
  fakeVoteWindow = createFloatingPanel({
    title: 'Sandbox: would post to Discord',
    bodyHtml: renderFakeVoteWindowBody(record),
  });
  wireFakeVoteWindowInputs(fakeVoteWindow, record);
  const originalClose = fakeVoteWindow.close;
  fakeVoteWindow.close = () => { originalClose(); fakeVoteWindow = null; };
}

```

- [ ] **Step 2: Branch `postVoteBtn`'s click handler**

Find the `postVoteBtn.addEventListener('click', async () => {` handler (search for that exact string). Its current body starts with:

```javascript
postVoteBtn.addEventListener('click', async () => {
  const title = rollTitleInput.value.trim();
  if(!title){ errorEl.textContent = 'Add a title before posting.'; return; }
  if(itemsArr.length === 0){ errorEl.textContent = 'Add at least one item before posting.'; return; }
  if(!loadWorkerUrl() || !isSessionValidLocally()){ errorEl.textContent = 'Log in with Discord in settings first.'; return; }

  postVoteBtn.disabled = true;
  errorEl.textContent = '';
  try{
```

Replace those first lines (keep the rest of the function body, i.e. the existing `try{ ... }` block for the live path, exactly as-is) with:

```javascript
postVoteBtn.addEventListener('click', async () => {
  const title = rollTitleInput.value.trim();
  if(!title){ errorEl.textContent = 'Add a title before posting.'; return; }
  if(itemsArr.length === 0){ errorEl.textContent = 'Add at least one item before posting.'; return; }

  if(isSandboxMode()){
    const record = {
      id: 'sandbox-' + Date.now(),
      items: buildVoteItemsPayload(),
      title,
      roleId: selectedRoleId || null,
      flavorText: flavorTextInput.value.trim() || null,
      createdAt: Date.now(),
      deadline: Date.now() + (Number(voteDurationSelect.value) || 72) * 60 * 60 * 1000,
      status: 'pending',
      results: {},
      finalizedAt: null,
    };
    saveSandboxRecord(record);
    savePendingVote({ voteId: record.id, title, postedAt: record.createdAt, deadline: record.deadline });
    renderVoteStatus();
    openFakeVoteWindow(record);
    return;
  }

  if(!loadWorkerUrl() || !isSessionValidLocally()){ errorEl.textContent = 'Log in with Discord in settings first.'; return; }

  postVoteBtn.disabled = true;
  errorEl.textContent = '';
  try{
```

The rest of the function (the existing `workerFetch('/vote', ...)` call through the closing `});`) stays exactly as it already is - only the top of the function changes.

- [ ] **Step 3: Manual verification**

Open the app, log in, enter Sandbox Mode. Add a title, add 2-3 items (any items, real or manually typed), click "Post to Discord for Voting". Confirm:
1. No network request is made (check devtools Network tab - nothing to the Worker fires).
2. A floating panel titled "Sandbox: would post to Discord" opens near the top-right, showing bold title text, a "Voting closes in ..." line, and one row per item with a "0" reaction-count input.
3. The normal Vote Status panel also appears below (with the countdown and Check Status/Start Rolling Now/Abort buttons) - unaffected so far since Task 6/7/8 haven't wired those yet.
4. Changing an item's count to e.g. 3 and pressing Tab/clicking away updates nothing visibly wrong (no errors in console) - full effect is verified in Task 6.
5. Run `JSON.parse(localStorage.getItem('rollcall_vote_test_record_v1'))` in devtools console and confirm `results["0"]` (or whichever index you changed) now holds an array of 3 distinct names from the fake pool.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Sandbox Mode fake-vote posting and Window 1 (reactions editor)"
```

---

### Task 6: Sandbox branch for Check Status, plus reopen button

**Files:**
- Modify: `index.html` (`checkVoteResults`, search for `async function checkVoteResults()`; `renderVoteStatus`, search for `function renderVoteStatus()`)

**Interfaces:**
- Consumes: `isSandboxMode()`, `loadSandboxRecord`, `openFakeVoteWindow` (Task 5), `setNamesFromVotes` (existing), `setVoteStatusMsg` (existing).

- [ ] **Step 1: Branch `checkVoteResults`**

Find:

```javascript
async function checkVoteResults(){
  const pending = loadPendingVote();
  if(!pending) return;
  setVoteStatusMsg('Checking…');
  try{
```

Replace with:

```javascript
async function checkVoteResults(){
  const pending = loadPendingVote();
  if(!pending) return;

  if(isSandboxMode()){
    const record = loadSandboxRecord();
    if(!record) return;
    const votersSoFar = Array.from(new Set(Object.values(record.results || {}).flat()));
    setNamesFromVotes(votersSoFar);
    setVoteStatusMsg(votersSoFar.length + (votersSoFar.length === 1 ? ' person has' : ' people have') + ' reacted so far (sandbox).');
    return;
  }

  setVoteStatusMsg('Checking…');
  try{
```

The rest of the function (the existing `workerFetch('/vote/' + pending.voteId + '/preview')` block through its closing `}`) stays exactly as it already is.

- [ ] **Step 2: Add the "Edit fake reactions" reopen button**

Find `renderVoteStatus`'s action-button block (search for `const abortBtn = document.createElement('button');` - it's the third of three buttons appended to `actions`). Immediately after the line `actions.appendChild(abortBtn);`, insert:

```javascript

  if(isSandboxMode()){
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost-btn';
    editBtn.textContent = 'Edit fake reactions';
    editBtn.addEventListener('click', () => {
      const record = loadSandboxRecord();
      if(record) openFakeVoteWindow(record);
    });
    actions.appendChild(editBtn);
  }
```

- [ ] **Step 3: Manual verification**

With Sandbox Mode on and a vote already posted (from Task 5's verification, or post a new one), close Window 1 by clicking its ×. Confirm:
1. An "Edit fake reactions" button now appears next to Check Status/Start Rolling Now/Abort.
2. Clicking it reopens Window 1 with the same reaction counts you'd set before (not reset to 0).
3. Set a couple of items' counts to nonzero values, close the window again, then click "Check Status" - confirm the status message reads like "N people have reacted so far (sandbox)." with the correct distinct-name count, and the Names panel (read-only, above Roll Options) populates with those fake names.
4. Confirm no network request fires for any of this (Network tab stays empty for Worker calls).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Sandbox Mode Check Status and reopen-window-1 button"
```

---

### Task 7: Sandbox branch for Start Rolling Now (Window 2) and Abort

**Files:**
- Modify: `index.html` (`finalizeVoteNow`, search for `async function finalizeVoteNow(voteId)`; `abortVoteNow`, search for `async function abortVoteNow(voteId)`; `consumeVoteResults`, search for `async function consumeVoteResults(record)`)

**Interfaces:**
- Consumes: `isSandboxMode()`, `loadSandboxRecord`, `saveSandboxRecord`, `clearSandboxRecord`, `buildSandboxResultsBlocks`, `mdPreviewToHtml`, `createFloatingPanel`, `consumeVoteResults` (existing - reused unmodified for the roll computation itself).
- Produces: `openResultsPreviewWindow(...)`.

- [ ] **Step 1: Add the results-preview window builder**

Insert this immediately after `openFakeVoteWindow`'s closing brace from Task 5:

```javascript
// ---- Sandbox Mode: Window 2 (results preview) ----
function renderResultsBlockHtml(block, accentColor){
  const fieldsHtml = block.fields.map(([label, value]) =>
    '<div style="margin-bottom:10px;">' +
      '<div class="modal-label" style="margin-bottom:4px;">' + escapeHtml(label) + '</div>' +
      '<div style="white-space:pre-wrap;">' + mdPreviewToHtml(value) + '</div>' +
    '</div>'
  ).join('');
  return (
    '<div style="border-left:3px solid ' + accentColor + '; padding-left:12px; margin-bottom:16px;">' +
      '<div style="font-family:\'Space Grotesk\', sans-serif; font-weight:700; margin-bottom:10px;">' + escapeHtml(block.title) + '</div>' +
      fieldsHtml +
    '</div>'
  );
}

function openResultsPreviewWindow(record, names, buckets, leftover, spreadEven, capOne){
  const { main, results } = buildSandboxResultsBlocks(record, names, buckets, leftover, spreadEven, capOne);
  const bodyHtml = renderResultsBlockHtml(main, 'var(--gold)') + renderResultsBlockHtml(results, 'var(--violet)');
  createFloatingPanel({
    title: 'Sandbox: would post as results',
    bodyHtml,
  });
}

```

- [ ] **Step 2: Branch `finalizeVoteNow`**

Find:

```javascript
async function finalizeVoteNow(voteId){
  setVoteStatusMsg('Rolling…');
  try{
```

Replace with:

```javascript
async function finalizeVoteNow(voteId){
  if(isSandboxMode()){
    const record = loadSandboxRecord();
    if(!record){ setVoteStatusMsg('No sandbox vote found.', 'err'); return; }
    record.status = 'ready';
    record.finalizedAt = Date.now();
    saveSandboxRecord(record);
    if(fakeVoteWindow) fakeVoteWindow.close();
    await consumeVoteResults(record);
    return;
  }

  setVoteStatusMsg('Rolling…');
  try{
```

The rest of the function (the existing `workerFetch('/vote/' + voteId + '/finalize', ...)` block through its closing `}`) stays exactly as it already is.

- [ ] **Step 3: Branch `abortVoteNow`**

Find:

```javascript
async function abortVoteNow(voteId){
  setVoteStatusMsg('Cancelling…');
  try{
```

Replace with:

```javascript
async function abortVoteNow(voteId){
  if(isSandboxMode()){
    const record = loadSandboxRecord();
    if(record){ record.status = 'aborted'; saveSandboxRecord(record); }
    if(fakeVoteWindow) fakeVoteWindow.close();
    clearPendingVote();
    renderVoteStatus();
    return;
  }

  setVoteStatusMsg('Cancelling…');
  try{
```

The rest of the function (the existing `workerFetch('/vote/' + voteId + '/abort', ...)` block through its closing `}`) stays exactly as it already is.

- [ ] **Step 4: Branch the announce step inside `consumeVoteResults`**

Find (near the end of `consumeVoteResults`, search for the comment `// Results are announced by the bot itself`):

```javascript
  // Results are announced by the bot itself, into the same channel the vote was
  // posted in — no separately-configured webhook needed for that, since the bot
  // already has authorization there. The Worker builds the embeds once and, if
  // a history-log webhook is enabled, posts the exact same embeds there too —
  // a single source of truth for the content rather than a separately-built
  // copy. Idempotent server-side, so a failed/retried call here can't double-post.
  // The webhook URL itself lives only in the Worker's HISTORY_WEBHOOK_URL secret —
  // this just tells it whether to use it for this particular roll.
  try{
    const res = await workerFetch('/vote/' + record.id + '/announce', {
      method: 'POST',
      body: JSON.stringify({
        names: allNames, buckets, leftover: unclaimed.map(it => it.name),
        spreadEven: evenSpread.checked, capOne: oneEach.checked,
        logToHistory: historyWebhookEnabled.checked,
      }),
    });
    if(res.ok){
      discordStatusEl.textContent = '✓ Results posted to Discord.';
      discordStatusEl.className = 'ok';
    } else {
      discordStatusEl.textContent = 'Failed to post results to Discord.';
      discordStatusEl.className = 'err';
    }
  }catch(e){
    discordStatusEl.textContent = 'Could not reach the Worker to post results.';
    discordStatusEl.className = 'err';
  }
}
```

Replace with:

```javascript
  // Results are announced by the bot itself, into the same channel the vote was
  // posted in — no separately-configured webhook needed for that, since the bot
  // already has authorization there. The Worker builds the embeds once and, if
  // a history-log webhook is enabled, posts the exact same embeds there too —
  // a single source of truth for the content rather than a separately-built
  // copy. Idempotent server-side, so a failed/retried call here can't double-post.
  // The webhook URL itself lives only in the Worker's HISTORY_WEBHOOK_URL secret —
  // this just tells it whether to use it for this particular roll.
  //
  // In Sandbox Mode, nothing is actually sent anywhere - Window 2 (opened by
  // openResultsPreviewWindow) already shows exactly what would have been
  // posted, so there's nothing left to announce.
  if(isSandboxMode()){
    openResultsPreviewWindow(record, allNames, buckets, unclaimed.map(it => it.name), evenSpread.checked, oneEach.checked);
    discordStatusEl.textContent = 'Sandbox roll complete - nothing was posted to Discord.';
    discordStatusEl.className = 'ok';
    clearSandboxRecord();
    return;
  }

  try{
    const res = await workerFetch('/vote/' + record.id + '/announce', {
      method: 'POST',
      body: JSON.stringify({
        names: allNames, buckets, leftover: unclaimed.map(it => it.name),
        spreadEven: evenSpread.checked, capOne: oneEach.checked,
        logToHistory: historyWebhookEnabled.checked,
      }),
    });
    if(res.ok){
      discordStatusEl.textContent = '✓ Results posted to Discord.';
      discordStatusEl.className = 'ok';
    } else {
      discordStatusEl.textContent = 'Failed to post results to Discord.';
      discordStatusEl.className = 'err';
    }
  }catch(e){
    discordStatusEl.textContent = 'Could not reach the Worker to post results.';
    discordStatusEl.className = 'err';
  }
}
```

- [ ] **Step 5: Manual verification**

With Sandbox Mode on, post a vote, set a few items' fake reaction counts (some 0, some 1, some 2+) via Window 1, close Window 1, then click "Start Rolling Now" and confirm the "End voting now..." confirm dialog. Confirm:
1. No network request fires anywhere in this sequence.
2. A "Sandbox: would post as results" floating panel opens, showing a gold-accented block (Date & Time, Participants, Roll Mode, Loot Pool) and a violet-accented block (Results per person, Unclaimed Items if any item had 0 reactions) - values matching what you set in Window 1 (items with 1 reactor went straight to that person, items with 2+ got split among their reactors according to the current Spread/Cap checkboxes, items with 0 show under Unclaimed).
3. The normal results card at the bottom of the page shows the same winners.
4. Open the History modal - the roll appears there, and it's absent from the real history (toggle Sandbox Mode off, reopen History, confirm it's gone from that view and the earlier `live-test`-style entries, if any, are unaffected).
5. Separately: post a new sandbox vote, then click "Abort" from the Vote Status panel and confirm it clears the panel with no network call and no results window opens.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: Sandbox Mode Start Rolling Now (results preview) and Abort"
```

---

### Task 8: Skip Worker recovery call while Sandbox Mode is on

**Files:**
- Modify: `index.html` (the page-load bootstrap block, search for `if(isSessionValidLocally()){` immediately followed by `renderVoteStatus();`)

**Interfaces:**
- Consumes: `isSandboxMode()`.

This closes a gap: on page load, if no pending vote is found locally, the app currently always calls `recoverActiveVoteIfNeeded()`, which hits the real Worker's `/vote/active` endpoint - that must not happen while Sandbox Mode is on and there's no sandbox vote to recover (recovery is a real-vote-only concept; the Worker has no idea sandbox votes exist).

- [ ] **Step 1: Guard the bootstrap block**

Find:

```javascript
if(isSessionValidLocally()){
  renderVoteStatus();
  if(loadPendingVote()){
    checkVoteResults();
  }else{
    recoverActiveVoteIfNeeded();
  }
}
```

Replace with:

```javascript
if(isSessionValidLocally()){
  renderVoteStatus();
  if(loadPendingVote()){
    checkVoteResults();
  }else if(!isSandboxMode()){
    recoverActiveVoteIfNeeded();
  }
}
```

- [ ] **Step 2: Manual verification**

1. With Sandbox Mode on and no sandbox vote pending, reload the page. Open devtools Network tab before/during reload - confirm no request to the Worker's `/vote/active` fires.
2. Leave Sandbox Mode, with no real vote pending, reload the page - confirm `/vote/active` *does* fire as before (this is expected, existing live-mode behavior, unchanged).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "fix: skip Worker vote-recovery call while Sandbox Mode is on"
```

---

### Task 9: End-to-end manual walkthrough

**Files:** None (verification only).

This task has no code changes - it's a full walkthrough of the spec to catch anything the per-task verifications above might have missed in isolation, especially interactions between tasks.

- [ ] **Step 1: Full sandbox lifecycle**

Open the app fresh (clear `localStorage` first if it has leftover test data from earlier tasks), log in, and:
1. Open Discord Settings, click "Enter Sandbox Mode". Confirm the border/badge appear and the button now reads "Leave Sandbox Mode".
2. Add a title, flavor text, a role selection (if any are configured), and 3-4 items with varying quality/SCU.
3. Click "Post to Discord for Voting". Confirm Window 1 opens showing correct title/flavor/deadline/item list text, and the normal Vote Status panel shows a live countdown.
4. Set reaction counts: one item to 0, one to 1, one to 3+. Close Window 1.
5. Click "Edit fake reactions" to confirm it reopens with the same counts preserved.
6. Click "Check Status" - confirm the reported voter count and Names panel match the counts you set.
7. Click "Start Rolling Now", confirm the dialog, and confirm Window 2 shows correct Participants/Roll Mode/Loot Pool/Results/Unclaimed Items text matching what was set.
8. Confirm the results card at the bottom of the page and the History modal both show the same roll.
9. In the History modal, confirm the "Reimport unclaimed items" button (from the earlier feature) appears on this entry if it had unclaimed items, and works correctly using the sandbox-scoped history entry.
10. Click "Leave Sandbox Mode". Confirm the border/badge disappear, and the History modal now shows real history only (the sandbox roll from this walkthrough is gone from view, not deleted - re-entering Sandbox Mode should bring it back).

- [ ] **Step 2: Mode-switch confirm dialog**

1. Leave Sandbox Mode if not already. Post a real vote (or, if you don't want to actually post to Discord, skip this specific check and note it in your report instead).
2. With a real vote pending, click "Enter Sandbox Mode" - confirm the "A live vote is still running and won't be affected. Enter Sandbox Mode anyway?" dialog appears, and clicking Cancel leaves Sandbox Mode off.
3. Click "Enter Sandbox Mode" again and confirm this time - confirm Sandbox Mode turns on and the Vote Status panel now shows nothing (since no sandbox vote is pending yet), while the real vote continues to exist (verify by leaving Sandbox Mode again - the real vote's status panel should reappear with its original countdown intact).

- [ ] **Step 3: No unintended Worker calls**

With devtools Network tab open and filtered to your Worker's domain, repeat step 1 in full. Confirm zero requests appear at any point during the sandbox walkthrough (posting, checking status, editing reactions, finalizing).

- [ ] **Step 4: Final commit (if any fixes were needed)**

If the walkthrough surfaced any bugs, fix them, then:

```bash
git add index.html
git commit -m "fix: address issues found in Sandbox Mode end-to-end walkthrough"
```

If no fixes were needed, no commit is required for this task - just report the walkthrough passed.

---

## Self-Review Notes

- **Spec coverage:** Section 1 (toggle/indicator) → Task 1. Section 2 (storage namespace) → Task 2. Section 3 (vote flow rewiring, all 5 endpoints) → Tasks 5-7 (post, check, finalize, abort) plus Task 3 (record shape). Section 4 (shared floating panel) → Task 4. Section 5 (Window 1) → Task 5. Section 6 (Window 2) → Task 7. "Out of scope" items are not built anywhere in this plan, matching the spec.
- **Mode-switch confirm** (spec section 1) → Task 1, Step 4 (`setSandboxMode`).
- **Skip-recovery gap**: not explicitly named as a task in the spec's numbered sections, but required by the spec's "Explicit non-goal" (zero Worker calls while Sandbox Mode is on) - added as Task 8 since without it, entering Sandbox Mode with no sandbox vote pending would still silently call the Worker on next reload.
