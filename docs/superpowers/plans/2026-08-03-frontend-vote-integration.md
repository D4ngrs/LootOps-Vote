# Frontend Vote Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `LootOps-Vote`'s UI to the deployed Cloudflare Worker: remove manual name entry, add a role picker and flavor-text field, post the current item list to Discord for voting, poll/finalize results, and feed those results into the existing roll-completion pipeline (results cards, history, both webhooks, share card) exactly as a manual roll already does.

**Architecture:** All new UI lives in `index.html` (single file, no build step, matching the rest of the app). A new "Discord Vote" settings section stores the Worker's base URL and shared secret in localStorage, mirroring the existing Discord webhook settings pattern. Posting a vote calls `POST /vote` on the Worker with items mapped from `itemsArr` (reusing the exact fields `snapshotItemsForRoll()` already computes — `displayName`, `detail`, `quality`, `scu`), stores the returned `voteId` in localStorage so it survives reloads, and shows a pending-vote status area with manual "Start Rolling Now" and "Check Status" actions. Once a vote's `GET /vote/:id` reports `status: "ready"`, results are converted into the same `(names, buckets, leftover)` shape the manual `assign()` roll flow already produces, then handed to the existing `render()` / `logRoll()` / `postRollToDiscord()` / `postRollToHistoryLog()` pipeline unchanged — no duplicate "finish a roll" logic. Items with zero voters are diverted into a separate "Unwanted Items" list with a one-click reimport, never entering the roll pipeline at all. The Names panel becomes read-only, populated only from vote results.

**Tech Stack:** Vanilla JS (no new dependencies), `fetch` against the Worker's endpoints (`docs/superpowers/plans/2026-08-03-cloudflare-worker-backend.md`), reuses `assign()`, `render()`, `logRoll()`, `postRollToDiscord()`, `postRollToHistoryLog()` as-is.

## Global Constraints

- Per the design spec (`docs/superpowers/specs/2026-08-03-discord-vote-roll-design.md` in the `LootOps` repo): no manual name entry anywhere in this app — the Names panel is read-only and vote-driven only.
- Distribution of items in-game stays manual — finalizing a vote (deadline or "Start Rolling Now") only computes results, it never auto-posts/auto-distributes beyond what the existing roll-completion pipeline already does (results cards, history, webhooks).
- Reuse `assign()`, `render()`, `logRoll()`, `postRollToDiscord()`, `postRollToHistoryLog()` unchanged — new code adapts vote results into their existing input shapes rather than duplicating their logic.
- The Worker's shared secret is entered once into a settings field (localStorage), same pattern as the existing webhook URL — never hardcoded.
- `APP_VERSION` / `CHANGELOG_ENTRIES` are not touched unless explicitly asked.

---

### Task 1: Discord Vote Worker connection settings

**Files:**
- Modify: `index.html` (new settings section near the existing `#settingsOverlay` webhook modal, ~line 1495-1524)
- Modify: `index.html` (JS, near the existing webhook settings block, ~line 3301-3420)

**Interfaces:**
- Produces: `loadWorkerUrl()`, `saveWorkerUrl(url)`, `loadWorkerSecret()`, `saveWorkerSecret(secret)` — used by all later tasks to build `fetch` calls against the Worker.
- Produces: `workerFetch(path, options)` — a thin wrapper that prefixes the Worker base URL and adds the `X-LootOps-Auth` header, used by every later task instead of raw `fetch`.

- [x] **Step 1: Add settings fields**

Add a new section to the existing settings modal (`#settingsOverlay`, alongside the Discord Webhook and History Log Webhook sections added in the previous stage), following the exact same markup pattern (`modal-label`, `entry-input`, `modal-hint`, `modal-actions` with Save/Clear, `modal-status`):

```html
<hr class="modal-divider">
<div class="modal-title">Discord Vote Worker</div>
<label class="modal-label" for="workerUrlInput">Worker URL</label>
<input type="text" class="entry-input" id="workerUrlInput" placeholder="https://lootops-vote-worker.your-subdomain.workers.dev" autocomplete="off">
<label class="modal-label" for="workerSecretInput" style="margin-top:10px;">Shared Secret</label>
<input type="password" class="entry-input" id="workerSecretInput" placeholder="Shared secret from wrangler secret put" autocomplete="off">
<div class="modal-hint">Connects to the Cloudflare Worker that posts item lists to Discord for voting and reads back results. Both values come from the Worker's own setup (see the Cloudflare Worker backend plan).</div>
<div class="modal-actions">
  <button type="button" class="primary-btn" id="saveWorkerConfigBtn">Save</button>
  <button type="button" class="ghost-btn danger" id="clearWorkerConfigBtn">Clear</button>
</div>
<div class="modal-status" id="workerConfigStatus"></div>
```

- [x] **Step 2: Add the JS state + `workerFetch` helper**

Near the existing webhook JS block:

```js
const WORKER_URL_KEY = 'rollcall_vote_worker_url_v1';
const WORKER_SECRET_KEY = 'rollcall_vote_worker_secret_v1';

function loadWorkerUrl(){
  try{ return (localStorage.getItem(WORKER_URL_KEY) || '').replace(/\/+$/, ''); }
  catch(e){ return ''; }
}
function saveWorkerUrl(url){
  try{ localStorage.setItem(WORKER_URL_KEY, url.replace(/\/+$/, '')); }catch(e){ /* ignore */ }
}
function loadWorkerSecret(){
  try{ return localStorage.getItem(WORKER_SECRET_KEY) || ''; }
  catch(e){ return ''; }
}
function saveWorkerSecret(secret){
  try{ localStorage.setItem(WORKER_SECRET_KEY, secret); }catch(e){ /* ignore */ }
}

async function workerFetch(path, options = {}){
  const base = loadWorkerUrl();
  if(!base) throw new Error('No Worker URL configured');
  return fetch(base + path, {
    ...options,
    headers: {
      'X-LootOps-Auth': loadWorkerSecret(),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

const workerUrlInput = document.getElementById('workerUrlInput');
const workerSecretInput = document.getElementById('workerSecretInput');
const saveWorkerConfigBtn = document.getElementById('saveWorkerConfigBtn');
const clearWorkerConfigBtn = document.getElementById('clearWorkerConfigBtn');
const workerConfigStatusEl = document.getElementById('workerConfigStatus');

function setWorkerConfigStatus(msg, kind){
  workerConfigStatusEl.textContent = msg;
  workerConfigStatusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
}

saveWorkerConfigBtn.addEventListener('click', () => {
  const url = workerUrlInput.value.trim();
  const secret = workerSecretInput.value.trim();
  if(!url || !secret){ setWorkerConfigStatus('Enter both the Worker URL and shared secret.', 'err'); return; }
  saveWorkerUrl(url);
  saveWorkerSecret(secret);
  setWorkerConfigStatus('Saved.', 'ok');
});

clearWorkerConfigBtn.addEventListener('click', async () => {
  if(!await confirmModal('Remove the saved Worker URL and shared secret?', 'Remove')) return;
  try{ localStorage.removeItem(WORKER_URL_KEY); localStorage.removeItem(WORKER_SECRET_KEY); }catch(e){ /* ignore */ }
  workerUrlInput.value = '';
  workerSecretInput.value = '';
  setWorkerConfigStatus('Removed.');
});
```

In `openSettings()`, populate both fields the same way `webhookUrlInput`/`historyWebhookUrlInput` already are: `workerUrlInput.value = loadWorkerUrl(); workerSecretInput.value = loadWorkerSecret();`.

- [x] **Step 3: Verify in browser**

Open the app, go to settings, save a test Worker URL + secret, reload the page, reopen settings — confirm both fields still show the saved values (via localStorage, `rollcall_vote_worker_url_v1` / `rollcall_vote_worker_secret_v1`).

- [x] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add Discord Vote Worker connection settings"
git push
```

---

### Task 2: Remove manual name entry, make Names panel read-only

**Files:**
- Modify: `index.html` (Names panel markup, ~line 1640-1652 area and the `#namesList` section)
- Modify: `index.html` (JS, `renderNamesList`/`addName`/`commitNameEntry`, ~line 2219-2295)

**Interfaces:**
- Produces: `setNamesFromVotes(names)` — replaces `namesArr` wholesale and re-renders read-only, called by Task 6's results consumption.

- [x] **Step 1: Remove the name-entry input and Add button from the Names panel markup**

Remove the `<input id="nameEntry">` and `#nameAddBtn` elements from the Names panel. Replace the panel's helper text (currently "Type and press Enter to add. Click × to remove.") with something like: `Populated automatically once vote results come in — no manual entry.`

- [x] **Step 2: Simplify `renderNamesList` to read-only (no remove button) and remove `addName`/`commitNameEntry`**

```js
function renderNamesList(){
  namesListEl.innerHTML = '';
  namesArr.forEach(name => {
    const li = document.createElement('li');
    li.className = 'entry-row-item name-row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'entry-name';
    nameSpan.textContent = name;
    li.appendChild(nameSpan);
    namesListEl.appendChild(li);
  });
  nameCount.textContent = namesArr.length;
}

function setNamesFromVotes(names){
  namesArr = names.slice();
  renderNamesList();
}
```

Remove the `nameEntry`/`nameWarningEl`/`commitNameEntry`/keydown/`nameAddBtn` event wiring entirely (no longer applicable).

- [x] **Step 3: Update `resetBtn` handler**

In the reset handler (~line 2297-2312), `namesArr = []` stays, but drop the now-removed `nameWarningEl.textContent = ''` line.

- [x] **Step 4: Verify in browser**

Confirm the Names panel shows "Nothing added yet." (or equivalent empty state) with no input/Add button, and no console errors from removed element references.

- [x] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: remove manual name entry, Names panel is now vote-results-driven only"
git push
```

---

### Task 3: Role picker (autocomplete) and flavor text field

**Files:**
- Modify: `index.html` (new fields near the Title input, ~line 1489-1493)
- Modify: `index.html` (JS, new section mirroring the wiki-suggestion autocomplete pattern at ~line 3971-4031)

**Interfaces:**
- Produces: `selectedRoleId` (module-level variable, `null` until a role is picked) and `flavorTextInput` — consumed by Task 4's `postVote` payload builder.

- [x] **Step 1: Add the markup**

Near the `#rollTitle` title-row, add:

```html
<div class="title-row">
  <label for="roleSearch">Ping role (optional)</label>
  <div style="position:relative;">
    <input type="text" class="entry-input" id="roleSearch" placeholder="Type a role name…" autocomplete="off">
    <div class="wiki-suggestions" id="roleSuggestions"></div>
  </div>
</div>
<div class="title-row">
  <label for="flavorTextInput">Flavor text (optional)</label>
  <input type="text" class="entry-input" id="flavorTextInput" placeholder="e.g. React within 3 days to claim your share!" autocomplete="off">
</div>
```

- [x] **Step 2: Add the role-fetching + autocomplete JS**

Mirroring `renderWikiSuggestions`/`selectSuggestion`/`setActiveSuggestion` (~line 3971-4031):

```js
let rolesCache = null; // [{id, name}], fetched once per session
let selectedRoleId = null;
const roleSearchInput = document.getElementById('roleSearch');
const roleSuggestions = document.getElementById('roleSuggestions');
let currentRoleMatches = [];
let currentRoleSuggestionBtns = [];
let activeRoleSuggestionIndex = -1;

async function ensureRolesLoaded(){
  if(rolesCache) return rolesCache;
  try{
    const res = await workerFetch('/roles');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    rolesCache = data.roles || [];
  }catch(e){
    rolesCache = [];
  }
  return rolesCache;
}

function selectRole(role){
  selectedRoleId = role.id;
  roleSearchInput.value = role.name;
  roleSuggestions.innerHTML = '';
  currentRoleMatches = [];
  currentRoleSuggestionBtns = [];
}

function setActiveRoleSuggestion(index){
  currentRoleSuggestionBtns.forEach(b => b.classList.remove('active'));
  activeRoleSuggestionIndex = index;
  if(index >= 0 && currentRoleSuggestionBtns[index]){
    currentRoleSuggestionBtns[index].classList.add('active');
  }
}

async function renderRoleSuggestions(){
  const query = roleSearchInput.value.trim().toLowerCase();
  roleSuggestions.innerHTML = '';
  currentRoleMatches = [];
  currentRoleSuggestionBtns = [];
  activeRoleSuggestionIndex = -1;
  selectedRoleId = null; // typing invalidates any prior selection
  if(!query) return;

  const roles = await ensureRolesLoaded();
  const matches = roles.filter(r => r.name.toLowerCase().includes(query)).slice(0, 8);
  currentRoleMatches = matches;

  matches.forEach(role => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wiki-suggestion';
    btn.textContent = role.name;
    btn.addEventListener('click', () => selectRole(role));
    roleSuggestions.appendChild(btn);
    currentRoleSuggestionBtns.push(btn);
  });
}

roleSearchInput.addEventListener('input', renderRoleSuggestions);
roleSearchInput.addEventListener('focus', () => { if(roleSearchInput.value.trim()) renderRoleSuggestions(); });
document.addEventListener('click', e => {
  if(!roleSearchInput.contains(e.target) && !roleSuggestions.contains(e.target)) roleSuggestions.innerHTML = '';
});
roleSearchInput.addEventListener('keydown', e => {
  if(e.key === 'ArrowDown'){ e.preventDefault(); setActiveRoleSuggestion(Math.min(activeRoleSuggestionIndex + 1, currentRoleMatches.length - 1)); }
  else if(e.key === 'ArrowUp'){ e.preventDefault(); setActiveRoleSuggestion(Math.max(activeRoleSuggestionIndex - 1, 0)); }
  else if(e.key === 'Enter' && activeRoleSuggestionIndex >= 0){ e.preventDefault(); selectRole(currentRoleMatches[activeRoleSuggestionIndex]); }
});

const flavorTextInput = document.getElementById('flavorTextInput');
```

- [x] **Step 3: Verify in browser**

With a Worker URL/secret configured (Task 1) and pointed at the real test server, type a few letters of an existing role name (e.g. "loot" for the `LootOps` role) — confirm suggestions appear, clicking one fills the input and clears suggestions. Typing further after a selection clears `selectedRoleId` (confirm via a temporary `console.log(selectedRoleId)` or by checking Task 4's posted payload later).

- [x] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add role-ping autocomplete and flavor text field"
git push
```

---

### Task 4: "Post to Discord for Voting" — build payload and call the Worker

**Files:**
- Modify: `index.html` (new button near the existing Roll/Share buttons, ~line 1654-1680)
- Modify: `index.html` (JS, new section after Task 3's code)

**Interfaces:**
- Consumes: `itemsArr`, `rollTitleInput`, `selectedRoleId`, `flavorTextInput`, `workerFetch` from earlier tasks.
- Produces: `PENDING_VOTE_KEY` localStorage entry `{voteId, title, postedAt}`, and `postItemsForVoting()` — triggers Task 5's status polling once called.

- [x] **Step 1: Add the button**

Near the existing `.roll-row` buttons, add (as a new row above it, since Roll no longer applies without votes — see Task 5 for how Roll's role changes):

```html
<div class="roll-row">
  <button id="postVoteBtn" type="button">
    <span class="btn-label">Post to Discord for Voting</span>
  </button>
</div>
```

- [x] **Step 2: Add the item-payload mapping and post logic**

Reuses the exact fields `snapshotItemsForRoll()` already computes, converting to the Worker's expected shape (stripping the surrounding parens `detail` already has, matching the existing `formatWonItemHtml` convention at line 2721):

```js
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

function buildVoteItemsPayload(){
  return itemsArr.map(it => ({
    name: it.displayName || it.name,
    info: it.detail ? it.detail.replace(/^\(|\)$/g, '') : null,
    quality: (it.quality !== undefined && it.quality !== null) ? ('Q' + it.quality) : null,
    scu: (it.scu !== undefined && it.scu !== null) ? (it.scu + ' SCU') : null,
    qty: it.qty,
  }));
}

const postVoteBtn = document.getElementById('postVoteBtn');
const voteStatusEl = document.getElementById('error'); // reuse existing error/status line for now

postVoteBtn.addEventListener('click', async () => {
  const title = rollTitleInput.value.trim();
  if(!title){ errorEl.textContent = 'Add a title before posting.'; return; }
  if(itemsArr.length === 0){ errorEl.textContent = 'Add at least one item before posting.'; return; }
  if(!loadWorkerUrl() || !loadWorkerSecret()){ errorEl.textContent = 'Configure the Discord Vote Worker in settings first.'; return; }

  postVoteBtn.disabled = true;
  errorEl.textContent = '';
  try{
    const res = await workerFetch('/vote', {
      method: 'POST',
      body: JSON.stringify({
        title,
        when: new Date().toLocaleString(),
        flavorText: flavorTextInput.value.trim() || undefined,
        roleId: selectedRoleId || undefined,
        items: buildVoteItemsPayload(),
      }),
    });
    if(!res.ok){
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = 'Failed to post vote: ' + (body.error || ('HTTP ' + res.status));
      return;
    }
    const data = await res.json();
    savePendingVote({ voteId: data.voteId, title, postedAt: Date.now(), deadline: data.deadline });
    renderVoteStatus(); // implemented in Task 5
  }catch(e){
    errorEl.textContent = 'Could not reach the Worker to post the vote.';
  }finally{
    postVoteBtn.disabled = false;
  }
});
```

- [x] **Step 3: Verify in browser**

Add a title and a couple of items, click "Post to Discord for Voting" (with Task 1's settings pointed at the real test Worker) — confirm a real Discord message posts (same as the manual `curl` tests from the backend stage), and `localStorage.getItem('rollcall_vote_pending_v1')` shows the returned `voteId`.

- [x] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add Post to Discord for Voting action"
git push
```

---

### Task 5: Pending-vote status, "Start Rolling Now" override, and result fetching

**Files:**
- Modify: `index.html` (status area markup near the roll buttons)
- Modify: `index.html` (JS, after Task 4's code)

**Interfaces:**
- Consumes: `loadPendingVote()`, `workerFetch` from Task 4.
- Produces: `renderVoteStatus()`, `checkVoteResults()` — called on page load and after posting; hands off to Task 6's `consumeVoteResults(record)` once a vote is `ready`.

- [x] **Step 1: Add the status area markup**

```html
<div id="voteStatus" class="hidden"></div>
```

- [x] **Step 2: Add the status rendering + manual override + polling logic**

```js
const voteStatusPanel = document.getElementById('voteStatus');

function renderVoteStatus(){
  const pending = loadPendingVote();
  if(!pending){ voteStatusPanel.classList.add('hidden'); voteStatusPanel.innerHTML = ''; return; }

  voteStatusPanel.classList.remove('hidden');
  voteStatusPanel.innerHTML = '';

  const label = document.createElement('span');
  label.textContent = `Vote posted: "${pending.title}" — `;
  voteStatusPanel.appendChild(label);

  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'ghost-btn';
  checkBtn.textContent = 'Check Status';
  checkBtn.addEventListener('click', checkVoteResults);
  voteStatusPanel.appendChild(checkBtn);

  const finalizeBtn = document.createElement('button');
  finalizeBtn.type = 'button';
  finalizeBtn.className = 'ghost-btn danger';
  finalizeBtn.textContent = 'Start Rolling Now';
  finalizeBtn.addEventListener('click', async () => {
    if(!await confirmModal('End voting now and roll with whoever has reacted so far?', 'Start Rolling')) return;
    await finalizeVoteNow(pending.voteId);
  });
  voteStatusPanel.appendChild(finalizeBtn);
}

async function checkVoteResults(){
  const pending = loadPendingVote();
  if(!pending) return;
  try{
    const res = await workerFetch('/vote/' + pending.voteId);
    if(!res.ok) return;
    const record = await res.json();
    if(record.status === 'ready') await consumeVoteResults(record); // Task 6
  }catch(e){ /* leave pending, user can retry */ }
}

async function finalizeVoteNow(voteId){
  try{
    const res = await workerFetch('/vote/' + voteId + '/finalize', { method: 'POST' });
    if(!res.ok) return;
    const record = await res.json();
    if(record.status === 'ready') await consumeVoteResults(record); // Task 6
  }catch(e){ /* leave pending, user can retry */ }
}

// On load, resume showing a pending vote's status if one exists from a previous session.
renderVoteStatus();
if(loadPendingVote()) checkVoteResults();
```

- [x] **Step 3: Verify in browser**

With a pending vote from Task 4's test: reload the page — confirm the vote-status area reappears (status persisted via localStorage) and "Check Status" re-fetches without erroring. Leave Task 6 unimplemented for now — `consumeVoteResults` will just be undefined, so this step only verifies the pending/status/fetch plumbing, not the full completion (a `ReferenceError` on `consumeVoteResults` is expected and fine until Task 6 lands).

- [x] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add pending-vote status, manual finalize override, and result fetching"
git push
```

---

### Task 6: Consume vote results into the existing roll pipeline

**Files:**
- Modify: `index.html` (JS, after Task 5's code)

**Interfaces:**
- Consumes: `assign()`, `render()`, `logRoll()`, `postRollToDiscord()`, `postRollToHistoryLog()`, `setNamesFromVotes()` (Task 2), `loadWebhookUrl()`/`discordEnabled`, `loadHistoryWebhookUrl()`/`historyWebhookEnabled` (all pre-existing).
- Produces: `consumeVoteResults(record)`, the `renderUnwantedItems(items)` UI, and `reimportUnwantedItems()`.

- [x] **Step 1: Add the unwanted-items UI**

```html
<div id="unwantedItemsPanel" class="hidden">
  <div class="modal-title">Unwanted Items</div>
  <ul id="unwantedItemsList"></ul>
  <button type="button" class="ghost-btn" id="reimportUnwantedBtn">Reimport for a new org-wide vote</button>
</div>
```

- [x] **Step 2: Implement `consumeVoteResults`**

This is the core adaptation layer: vote results (`{itemIndex: [voters]}`, keyed against `record.items`) become the same `(names, buckets, leftover)` shape `assign()`/`render()`/`logRoll()` already expect for a normal roll.

```js
let unwantedItems = []; // items with zero voters from the most recent finalized vote

async function consumeVoteResults(record){
  clearPendingVote();
  voteStatusPanel.classList.add('hidden');

  const directAssign = []; // [{ name, voter }]
  const rollGroups = [];   // [{ item, voters }]
  const unwanted = [];

  record.items.forEach((item, index) => {
    const voters = (record.results && record.results[String(index)]) || [];
    if(voters.length === 0) unwanted.push(item);
    else if(voters.length === 1) directAssign.push({ item, voter: voters[0] });
    else rollGroups.push({ item, voters });
  });

  // Union of everyone involved in this roll, for the read-only Names panel and
  // for building per-name result buckets.
  const allNames = Array.from(new Set([
    ...directAssign.map(d => d.voter),
    ...rollGroups.flatMap(g => g.voters),
  ]));
  setNamesFromVotes(allNames);

  const buckets = allNames.map(() => []);
  const nameIndex = new Map(allNames.map((n, i) => [n, i]));

  directAssign.forEach(({ item, voter }) => {
    for(let i = 0; i < item.qty; i++) buckets[nameIndex.get(voter)].push(item.name);
  });

  rollGroups.forEach(({ item, voters }) => {
    const itemCopies = [];
    for(let i = 0; i < item.qty; i++) itemCopies.push(item.name);
    const { buckets: groupBuckets } = assign(voters, itemCopies, evenSpread.checked, oneEach.checked);
    voters.forEach((voter, i) => {
      buckets[nameIndex.get(voter)].push(...groupBuckets[i]);
    });
  });

  unwantedItems = unwanted;
  renderUnwantedItems();

  const title = record.title || '';
  const when = new Date().toLocaleString();
  const itemsSnapshot = record.items.map(it => ({
    name: it.name, displayName: it.name, detail: it.info ? `(${it.info})` : '', quality: null, scu: null,
  }));

  render(allNames, buckets, [], title, itemsSnapshot);
  logRoll(allNames, buckets, [], title, when, itemsSnapshot, false);

  lastRollResult = { title, when, names: allNames.slice(), buckets: buckets.map(b => b.slice()), itemsSnapshot };
  shareBtn.disabled = false;
  shareBtn.classList.add('ready');

  const webhookUrl = loadWebhookUrl();
  if(webhookUrl && discordEnabled.checked){
    postRollToDiscord(webhookUrl, { title, when, names: allNames, buckets, leftover: [], itemsSnapshot, spreadEven: evenSpread.checked, capOne: oneEach.checked });
  }
  const historyWebhookUrl = loadHistoryWebhookUrl();
  if(historyWebhookUrl && historyWebhookEnabled.checked){
    postRollToHistoryLog(historyWebhookUrl, { title, when, names: allNames, buckets, leftover: [], itemsSnapshot, spreadEven: evenSpread.checked, capOne: oneEach.checked });
  }
}

function renderUnwantedItems(){
  const panel = document.getElementById('unwantedItemsPanel');
  const list = document.getElementById('unwantedItemsList');
  if(!unwantedItems.length){ panel.classList.add('hidden'); list.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  list.innerHTML = '';
  unwantedItems.forEach(it => {
    const li = document.createElement('li');
    li.textContent = `${it.name}${it.qty > 1 ? ' ×' + it.qty : ''}`;
    list.appendChild(li);
  });
}

document.getElementById('reimportUnwantedBtn').addEventListener('click', () => {
  unwantedItems.forEach(it => {
    for(let i = 0; i < it.qty; i++) addOrIncrementItem(it.name, null);
  });
  unwantedItems = [];
  renderUnwantedItems();
});
```

**Note on `itemInfo` round-tripping:** the item's `quality`/`scu` display strings (`"Q500"`, `"2 SCU"`) posted to Discord in Task 4 are not parsed back into numeric `quality`/`scu` here — the post-roll result cards only need `detail`/name text, which `itemsSnapshot` above supplies from `record.items[].info`. This matches how `formatWonItemHtml` already degrades gracefully when `quality`/`scu` are absent from a snapshot entry (line 2713-2723) — the roll result cards simply won't show a quality/SCU badge for vote-driven items, only the name and detail text. This is an accepted simplification for this stage.

- [x] **Step 3: Verify in browser end-to-end**

1. Configure Worker settings (Task 1), add 2-3 items, add a title, click "Post to Discord for Voting."
2. In Discord, react to one item with a single person, another item with two+ people (a second Discord account or ask a friend), leave one item unreacted.
3. Click "Start Rolling Now," confirm.
4. Verify: Names panel shows exactly the voters involved; results cards show the single-voter item assigned directly, the multi-voter item rolled among just its voters; the zero-voter item appears in "Unwanted Items" with a working reimport button; roll history has a new entry; both webhooks fire if configured (per the previous stage's toggles).

- [x] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: consume vote results into the existing roll pipeline (auto-assign, roll groups, unwanted items)"
git push
```

---

**Bugs found and fixed during execution (not in the original plan):**
- **Role-suggestion race condition** — typing several characters quickly fired overlapping async `renderRoleSuggestions()` calls; each cleared the suggestion list before awaiting `ensureRolesLoaded()`, but appended results after, without re-clearing, so fast typing produced duplicated suggestion entries. Fixed with a request-token guard (`roleSuggestionRequestId`) that discards stale calls.
- **Missing `.hidden` CSS rules** — this codebase scopes `.hidden` per-element (e.g. `#undoRollBtn.hidden`) rather than as a generic rule; the new `#voteStatus` and `#unwantedItemsPanel` elements used `class="hidden"` without matching CSS, so `unwantedItemsPanel` (which has static child markup) was visibly showing on every page load. Fixed by adding `#voteStatus.hidden{display:none;}` and `#unwantedItemsPanel.hidden{display:none;}`.

Both verified fixed live in-browser (see Task 3 and Task 6 verification notes above).

## Verification Checklist

- [x] Names panel has no manual entry UI anywhere; it populates only from `setNamesFromVotes`.
- [x] Role autocomplete correctly resolves a typed name to the role's ID (verified via a real posted vote showing the spoilered ping).
- [x] Flavor text appears in the posted Discord message when set, omitted when blank.
- [x] "Post to Discord for Voting" round-trips items through the same `quality`/`scu`/`detail` dedup logic already used elsewhere (no re-implemented rules).
- [x] A pending vote survives a page reload (localStorage) and "Check Status" correctly re-fetches.
- [x] "Start Rolling Now" requires confirmation and finalizes early.
- [x] 1-voter items are assigned directly (no roll); 2+-voter items are rolled only among their own voters; 0-voter items go to "Unwanted Items" and reimport correctly.
- [x] The existing roll-completion pipeline (results cards, history, both webhooks, share card) fires unchanged for vote-driven rolls.
