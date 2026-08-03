# Roll History Log Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, independent Discord webhook to `LootOps-Vote` that — when enabled — posts a duplicate copy of every roll's result embed to a separate "history log" channel, for internal fallback reference if org members have questions later.

**Architecture:** Reuses the exact pattern already in `index.html` for the primary Discord webhook (URL + enabled toggle in localStorage, settings modal fields, post-after-roll call) as a fully separate second instance with its own keys, UI fields, and toggle. The embed-building logic is extracted into a shared function so both webhooks post identical content without duplicating the embed-construction code.

**Tech Stack:** Vanilla JS, `fetch`, Discord webhook embeds — no new dependencies.

## Global Constraints

- Single-file static app — all changes go in `LootOps-Vote/index.html`, no build step, no new files.
- `APP_VERSION` and `CHANGELOG_ENTRIES` are not touched unless explicitly asked.
- The history webhook is entirely independent of the primary "Post to Discord" webhook — its own URL, its own enabled toggle, its own localStorage keys — per the design spec (`docs/superpowers/specs/2026-08-03-discord-vote-roll-design.md` in the `LootOps` repo).
- Scope for this stage: duplicate the same roll-result embeds (title, date/time, who won what, unrolled leftovers) to the second channel. The "voting window" field mentioned in the spec is deferred until the vote-to-roll feature (a later stage) actually exists — there is no vote data to include yet.
- Undo notices (`postUndoToDiscord`) are out of scope for this stage — the spec only calls for logging roll results, not undo events.

---

### Task 1: History webhook state + settings UI

**Files:**
- Modify: `index.html:1495-1511` (settings modal markup — add a second section)
- Modify: `index.html:1643-1652` (main options row — add a second toggle)
- Modify: `index.html:3301-3420` (Discord webhook JS section — add parallel state/handlers)

**Interfaces:**
- Produces: `loadHistoryWebhookEnabled()`, `saveHistoryWebhookEnabled(enabled)`, `loadHistoryWebhookUrl()`, `saveHistoryWebhookUrl(url)`, `clearHistoryWebhookUrl()` — same signatures/shapes as the existing `loadWebhookEnabled`/`saveWebhookEnabled`/`loadWebhookUrl`/`saveWebhookUrl`/`clearWebhookUrl`, used by Task 2.
- Produces: DOM elements `historyWebhookEnabled` (checkbox), `historyWebhookUrlInput`, `saveHistoryWebhookBtn`, `testHistoryWebhookBtn`, `clearHistoryWebhookBtn`, `historyWebhookStatusEl` — used by Task 2's send logic and this task's own test button.

- [ ] **Step 1: Add the second settings section to the modal**

In `index.html`, immediately after the existing webhook modal's closing `</div>` at line 1510 (the one that closes `<div class="modal-panel">` for `settingsOverlay`, i.e. right before its outer `</div>` at line 1511), the modal panel currently ends after `<div class="modal-status" id="webhookStatus"></div>`. Add a divider and a second field group inside the same `modal-panel`, before that panel's closing tag:

```html
      <div class="modal-status" id="webhookStatus"></div>

      <hr class="modal-divider">

      <div class="modal-title">History Log Webhook</div>
      <label class="modal-label" for="historyWebhookUrlInput">Webhook URL</label>
      <input type="text" class="entry-input" id="historyWebhookUrlInput" placeholder="https://discord.com/api/webhooks/…" autocomplete="off">
      <div class="modal-hint">Optional second channel. When enabled, every roll also posts the same result summary here as an internal log — useful as a fallback reference if members have questions later.</div>
      <div class="modal-actions">
        <button type="button" class="primary-btn" id="saveHistoryWebhookBtn">Save</button>
        <button type="button" class="ghost-btn" id="testHistoryWebhookBtn">Send test</button>
        <button type="button" class="ghost-btn danger" id="clearHistoryWebhookBtn">Clear</button>
      </div>
      <div class="modal-status" id="historyWebhookStatus"></div>
    </div>
  </div>
```

(That last `</div></div>` replaces the original closing tags of the modal panel and overlay — the panel now contains both webhook sections.)

If `.modal-divider` isn't already a defined CSS class, add this to the `<style>` block, near the other `.modal-*` rules:

```css
.modal-divider{border:none;border-top:1px solid var(--panel);margin:16px 0;}
```

- [ ] **Step 2: Add the second toggle to the main options row**

In `index.html` at the `.options` div (around line 1643-1652), add a second `discord-row`-styled entry after the existing one:

```html
  <div class="options">
    <label><input type="checkbox" id="evenSpread"> Spread items as evenly as possible</label>
    <div class="sep"></div>
    <label><input type="checkbox" id="oneEach"> Cap at 1 item per name</label>
    <div class="sep"></div>
    <div class="discord-row">
      <label><input type="checkbox" id="discordEnabled"> Post to Discord</label>
      <span class="discord-warning" id="discordWarning"></span>
    </div>
    <div class="sep"></div>
    <div class="discord-row">
      <label><input type="checkbox" id="historyWebhookEnabled"> Log to history channel</label>
      <span class="discord-warning" id="historyWebhookWarning"></span>
    </div>
  </div>
```

- [ ] **Step 3: Add the JS state functions and wiring**

In `index.html`, immediately after the existing webhook JS block ends (after the `testWebhookBtn` click handler, i.e. right after line 3420's closing `});`), add:

```js
// ---- History log webhook (separate channel, independent toggle) ----
const HISTORY_WEBHOOK_KEY = 'rollcall_vote_history_webhook_v1';
const HISTORY_WEBHOOK_ENABLED_KEY = 'rollcall_vote_history_webhook_enabled_v1';

function loadHistoryWebhookEnabled(){
  try{
    const raw = localStorage.getItem(HISTORY_WEBHOOK_ENABLED_KEY);
    return raw === null ? false : raw === 'true'; // default off
  }catch(e){ return false; }
}
function saveHistoryWebhookEnabled(enabled){
  try{ localStorage.setItem(HISTORY_WEBHOOK_ENABLED_KEY, String(enabled)); }catch(e){ /* ignore */ }
}
const historyWebhookEnabled = document.getElementById('historyWebhookEnabled');
historyWebhookEnabled.checked = loadHistoryWebhookEnabled();
historyWebhookEnabled.addEventListener('change', () => saveHistoryWebhookEnabled(historyWebhookEnabled.checked));

const historyWebhookWarningEl = document.getElementById('historyWebhookWarning');
function refreshHistoryWebhookWarning(){
  historyWebhookWarningEl.textContent = loadHistoryWebhookUrl() ? '' : '(no webhook set)';
}
refreshHistoryWebhookWarning();

const historyWebhookUrlInput = document.getElementById('historyWebhookUrlInput');
const saveHistoryWebhookBtn = document.getElementById('saveHistoryWebhookBtn');
const testHistoryWebhookBtn = document.getElementById('testHistoryWebhookBtn');
const clearHistoryWebhookBtn = document.getElementById('clearHistoryWebhookBtn');
const historyWebhookStatusEl = document.getElementById('historyWebhookStatus');

function loadHistoryWebhookUrl(){
  try{ return localStorage.getItem(HISTORY_WEBHOOK_KEY) || ''; }
  catch(e){ return ''; }
}
function saveHistoryWebhookUrl(url){
  try{ localStorage.setItem(HISTORY_WEBHOOK_KEY, url); }catch(e){ /* storage unavailable, ignore */ }
}
function clearHistoryWebhookUrl(){
  try{ localStorage.removeItem(HISTORY_WEBHOOK_KEY); }catch(e){ /* ignore */ }
}

function setHistoryWebhookStatus(msg, kind){
  historyWebhookStatusEl.textContent = msg;
  historyWebhookStatusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
}

saveHistoryWebhookBtn.addEventListener('click', () => {
  const url = historyWebhookUrlInput.value.trim();
  if(!url){ setHistoryWebhookStatus('Enter a webhook URL first.', 'err'); return; }
  if(!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)){
    setHistoryWebhookStatus('That doesn\'t look like a Discord webhook URL.', 'err');
    return;
  }
  saveHistoryWebhookUrl(url);
  setHistoryWebhookStatus('Saved. Rolls will now also log to this webhook when enabled.', 'ok');
  refreshHistoryWebhookWarning();
});

clearHistoryWebhookBtn.addEventListener('click', async () => {
  if(!await confirmModal('Remove the saved history log webhook?', 'Remove')) return;
  clearHistoryWebhookUrl();
  historyWebhookUrlInput.value = '';
  setHistoryWebhookStatus('Webhook removed.');
  refreshHistoryWebhookWarning();
});

testHistoryWebhookBtn.addEventListener('click', async () => {
  const url = historyWebhookUrlInput.value.trim();
  if(!url){ setHistoryWebhookStatus('Enter a webhook URL first.', 'err'); return; }
  testHistoryWebhookBtn.disabled = true;
  setHistoryWebhookStatus('Sending test message…');
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'LootOps - History log test message',
          description: 'If you can see this, your history log webhook is set up correctly.',
          color: EMBED_COLOR
        }]
      })
    });
    if(res.ok || res.status === 204){
      setHistoryWebhookStatus('Test message sent — check Discord.', 'ok');
    } else {
      setHistoryWebhookStatus('Discord returned an error (HTTP ' + res.status + ').', 'err');
    }
  }catch(e){
    setHistoryWebhookStatus('Could not reach Discord. Check the URL and your connection.', 'err');
  }
  testHistoryWebhookBtn.disabled = false;
});
```

- [ ] **Step 4: Populate the history webhook field when settings open**

In `openSettings()` (around `index.html:3351-3359`), add the history field alongside the primary one:

```js
function openSettings(){
  webhookUrlInput.value = loadWebhookUrl();
  historyWebhookUrlInput.value = loadHistoryWebhookUrl();
  const hasUrl = !!loadWebhookUrl();
  let msg = hasUrl ? 'Webhook is saved on this device.' : 'No webhook saved yet.';
  if(hasUrl && !discordEnabled.checked) msg += ' Posting is currently turned off via the "Post to Discord" checkbox on the main page.';
  setWebhookStatus(msg);
  settingsOverlay.classList.remove('hidden');
  lockBodyScroll();
}
```

- [ ] **Step 5: Verify in browser**

Open `LootOps-Vote/index.html` locally (or the live Pages site), log in, click "Discord webhook". Confirm:
- A second "History Log Webhook" section renders below the existing one, with its own URL field, Save/Send test/Clear buttons, and status line.
- Typing a non-Discord URL and clicking Save shows the same validation error as the primary field.
- Saving a valid-looking Discord URL persists across a page reload (check via the browser's Application → Local Storage panel for `rollcall_vote_history_webhook_v1`).
- On the main page, a second checkbox "Log to history channel" appears next to "Post to Discord", and shows `(no webhook set)` until a URL is saved.

---

### Task 2: Duplicate roll-result posting to the history channel

**Files:**
- Modify: `index.html:3428-3484` (`postRollToDiscord` — extract shared embed builder)
- Modify: `index.html:3538-3559` (roll click handler — also fire the history post)

**Interfaces:**
- Consumes: `loadHistoryWebhookUrl()`, `historyWebhookEnabled` from Task 1.
- Produces: `buildRollEmbeds(data)` returning `[mainEmbed, resultsEmbed]` (same shape `postRollToDiscord` already builds) — used by both the primary and history posting calls.
- Produces: `postRollToHistoryLog(url, data)` — same `data` shape as `postRollToDiscord`.

- [ ] **Step 1: Extract the embed-building logic into a shared function**

Replace the body of `postRollToDiscord` (`index.html:3428-3484`) with an extracted builder plus two thin senders:

```js
function buildRollEmbeds(data){
  const { title, when, names, buckets, leftover, itemsSnapshot, spreadEven, capOne } = data;

  const participantsText = trimForEmbed(names.map(escDiscord).join(', ') || '—');
  const lootPoolText = trimForEmbed(
    itemsSnapshot.map(it => `${escDiscord(it.label)} ×${it.qty}`).join('\n') || '—'
  );
  const resultsText = trimForEmbed(
    names.map((name, i) => {
      const got = buckets[i] || [];
      return `**${escDiscord(name)}:** ${got.length ? got.map(escDiscord).join(', ') : '_nothing_'}`;
    }).join('\n')
  );

  const mainEmbed = {
    title: title || 'Untitled Roll',
    color: EMBED_COLOR,
    fields: [
      { name: 'Date & Time', value: when, inline: false },
      { name: 'Participants', value: participantsText, inline: false },
      { name: 'Roll Mode', value: `Spread evenly: ${spreadEven ? 'Yes' : 'No'}\nCap at 1 item: ${capOne ? 'Yes' : 'No'}`, inline: false },
      { name: 'Loot Pool', value: lootPoolText, inline: false }
    ]
  };

  const resultsFields = [
    { name: 'Results', value: resultsText, inline: false }
  ];
  if(leftover && leftover.length){
    resultsFields.push({ name: 'Leftovers (Unassigned)', value: trimForEmbed(leftover.map(escDiscord).join(', ')), inline: false });
  }
  const resultsEmbed = {
    title: (title ? title + ' - ' : '') + 'Results',
    color: EMBED_COLOR_RESULTS,
    fields: resultsFields
  };

  return [mainEmbed, resultsEmbed];
}

async function postRollToDiscord(url, data){
  const embeds = buildRollEmbeds(data);
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds })
    });
    if(res.ok || res.status === 204){
      discordStatusEl.textContent = '✓ Posted to Discord.';
      discordStatusEl.className = 'ok';
    } else {
      discordStatusEl.textContent = 'Discord post failed (HTTP ' + res.status + ').';
      discordStatusEl.className = 'err';
    }
  }catch(e){
    discordStatusEl.textContent = 'Could not reach Discord to post the roll.';
    discordStatusEl.className = 'err';
  }
}

async function postRollToHistoryLog(url, data){
  const embeds = buildRollEmbeds(data);
  try{
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds })
    });
    // Silent on success/failure — this is a best-effort internal log, not user-facing
    // feedback. The primary webhook's status line already tells the roller whether
    // the main post succeeded; a failed history log never blocks or affects the roll.
  }catch(e){ /* best-effort log, ignore */ }
}
```

- [ ] **Step 2: Fire the history post alongside the primary one**

In the `rollBtn` click handler (`index.html:3538-3559`), add the history log call next to the existing Discord post:

```js
    const webhookUrl = loadWebhookUrl();
    const willPostToDiscord = !!(webhookUrl && discordEnabled.checked);
    const historyWebhookUrl = loadHistoryWebhookUrl();
    const willLogToHistory = !!(historyWebhookUrl && historyWebhookEnabled.checked);
    render(names, buckets, leftover, title, itemsSnapshot);
    logRoll(names, buckets, leftover, title, when, itemsSnapshot, willPostToDiscord);
    rollBtn.disabled = false;

    lastRollResult = {
      title, when, names: names.slice(),
      buckets: buckets.map(b => b.slice()),
      itemsSnapshot
    };
    shareBtn.disabled = false;
    shareBtn.classList.add('ready');

    if(willPostToDiscord){
      postRollToDiscord(webhookUrl, {
        title, when, names, buckets, leftover,
        itemsSnapshot: itemsArr.map(it => ({ label: it.label || it.name, qty: it.qty })),
        spreadEven: evenSpread.checked, capOne: oneEach.checked
      });
    }
    if(willLogToHistory){
      postRollToHistoryLog(historyWebhookUrl, {
        title, when, names, buckets, leftover,
        itemsSnapshot: itemsArr.map(it => ({ label: it.label || it.name, qty: it.qty })),
        spreadEven: evenSpread.checked, capOne: oneEach.checked
      });
    }
```

- [ ] **Step 3: Verify in browser with a real test webhook**

In Discord, create (or reuse) two test channels with webhook URLs — one for "primary" and one for "history log" (can be the same channel with two different webhook URLs if you only have one test channel available). In `LootOps-Vote`:
1. Save both URLs in settings, enable both toggles ("Post to Discord" and "Log to history channel").
2. Add a name and an item, hit Roll.
3. Confirm **two separate messages** land in Discord (or two sets of embeds if using the same channel with different webhooks) — both with matching title/date/participants/results content.
4. Disable only "Log to history channel", roll again — confirm only the primary post fires this time.
5. Disable only "Post to Discord", roll again — confirm only the history log post fires.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add independent history-log webhook that duplicates roll results to a second channel"
git push
```

---

## Verification Checklist

- [ ] Settings modal shows both webhook sections, each independently save/test/clear-able.
- [ ] Main options row shows both toggles, each independently enable/disable-able, each showing its own "(no webhook set)" warning.
- [ ] Rolling with only the primary webhook enabled posts only to the primary channel.
- [ ] Rolling with only the history webhook enabled posts only to the history channel.
- [ ] Rolling with both enabled posts identical embed content to both channels.
- [ ] A failed/unreachable history webhook does not block the roll, the primary post, or show an error to the user (silent best-effort, per spec).
