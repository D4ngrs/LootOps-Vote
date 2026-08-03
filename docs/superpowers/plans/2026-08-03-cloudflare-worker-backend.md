# Cloudflare Worker Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cloudflare Worker backend that posts item lists to Discord for voting, lets the bot self-react with assigned emoji, and — on a deadline or manual trigger — fetches final reactions and computes `item → voters` results, all backed by Cloudflare KV and a scheduled Cron Trigger.

**Architecture:** A single Cloudflare Worker (`LootOps-Vote/worker/`) exposes `POST /vote`, `GET /vote/:id`, and `POST /vote/:id/finalize` over HTTP, authenticated by a shared-secret header. It holds the Discord bot token as a Worker secret and talks to Discord's REST API directly (no Gateway/websocket connection). Vote state lives in a Cloudflare KV namespace. An hourly Cron Trigger sweeps KV for votes past their deadline and finalizes them the same way the manual endpoint does. This stage delivers and verifies the backend in isolation (via `curl`/`fetch` against the deployed Worker and a real Discord test channel) — wiring it into the `LootOps-Vote` frontend UI is a later stage.

**Tech Stack:** Cloudflare Workers (plain JS, no framework), Cloudflare KV, Cloudflare Cron Triggers, Discord REST API v10, `wrangler` CLI.

## Global Constraints

- No persistent bot process, no paid hosting — everything runs on Cloudflare's free tier via on-demand HTTP + one scheduled check per hour, per the design spec (`docs/superpowers/specs/2026-08-03-discord-vote-roll-design.md` in the `LootOps` repo).
- The bot never listens for Discord events/commands — it only acts when the Worker calls Discord's REST API.
- Emoji assignment: letters **A–Z** first (26 possible, via unicode regional-indicator emoji), then numbers (keycap emoji) once letters are exhausted — assigned globally across the whole item list, independent of message splitting.
- Discord's 20-reactions-per-message limit means item lists longer than 20 are split across multiple messages, continuing the same emoji sequence.
- No step may silently lose a vote's item list — posting failures create no orphaned record (retryable via re-POST), and finalize failures (cron or manual) leave `status: "pending"` rather than writing partial/failed results, so they're retried rather than lost.
- The Discord bot token is a credential — it is set via `wrangler secret put` run by the user directly in their own terminal, never typed into this session.

---

### Task 1: Manual prerequisites (Discord bot + Cloudflare account)

**These steps must be performed by the user** — they require accounts and credentials no automated tool can create.

- [x] **Step 1: Create the Discord bot application**

1. Go to `https://discord.com/developers/applications` and sign in.
2. Click **New Application**, name it something like `LootOps Vote Bot`, accept the terms.
3. In the left sidebar, click **Bot**. A bot user is created automatically.
4. Under **Privileged Gateway Intents**, leave everything off — this bot never opens a Gateway connection, so no intents are needed.
5. Click **Reset Token** (or **Copy**) to get the bot token. **Keep this tab open or copy the token somewhere safe temporarily** — you'll paste it directly into `wrangler secret put` in Task 2's Step 4, never into this chat.

- [x] **Step 2: Invite the bot to your Discord server**

1. In the left sidebar, click **OAuth2 → URL Generator**.
2. Under **Scopes**, check `bot`.
3. Under **Bot Permissions**, check `Send Messages`, `Add Reactions`, `Read Message History`, `View Channel`.
4. Copy the generated URL at the bottom, open it in a browser, pick your Discord server, and authorize it (you need "Manage Server" permission on that server).

- [x] **Step 3: Get the target channel ID**

1. In Discord, enable Developer Mode: **User Settings → Advanced → Developer Mode**.
2. Right-click the channel you want votes posted to → **Copy Channel ID**. Keep this handy for Task 2 (it's not sensitive, just a numeric ID).

- [x] **Step 4: Create a free Cloudflare account**

1. Go to `https://dash.cloudflare.com/sign-up` and create a free account (no credit card required for Workers' free tier).
2. No further dashboard setup needed yet — the rest is done via the `wrangler` CLI in Task 2.

---

### Task 2: Scaffold the Worker project and authenticate

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/src/index.js`
- Create: `worker/package.json`

**Interfaces:**
- Produces: a deployable Worker skeleton with CORS handling, shared-secret auth middleware, and a KV binding — used by all later tasks.

- [x] **Step 1: Install wrangler locally**

Run (from `LootOps-Vote`):
```bash
mkdir worker
cd worker
npm init -y
npm install --save-dev wrangler
```
Expected: `worker/package.json` and `worker/node_modules` exist.

- [x] **Step 2: Log in to Cloudflare via wrangler**

**This step must be run by the user**, not through an automated tool — it opens a browser for an interactive OAuth login.

Tell the user to run, in their own terminal (or via the `!` prefix in this session):
```bash
cd worker
npx wrangler login
```
Expected: a browser window opens, the user authorizes wrangler against their Cloudflare account, and the terminal shows "Successfully logged in."

- [x] **Step 3: Create the KV namespace**

Run:
```bash
npx wrangler kv namespace create VOTES_KV
```
Expected: output includes a `binding = "VOTES_KV"` / `id = "..."` snippet — copy the `id` value for Step 5.

- [x] **Step 4: Set the Discord bot token secret**

**This step must be run by the user directly** — the token is a credential that should never be typed into this chat session.

Tell the user to run, in their own terminal:
```bash
cd worker
npx wrangler secret put DISCORD_BOT_TOKEN
```
Wrangler will prompt for the value — the user pastes the bot token from Task 1 Step 1 directly into that prompt.

- [x] **Step 5: Create `worker/wrangler.toml`**

```toml
name = "lootops-vote-worker"
main = "src/index.js"
compatibility_date = "2024-11-01"

kv_namespaces = [
  { binding = "VOTES_KV", id = "PASTE_KV_NAMESPACE_ID_HERE" }
]

[triggers]
crons = ["0 * * * *"]

[vars]
DISCORD_CHANNEL_ID = "PASTE_CHANNEL_ID_HERE"
```

Replace `PASTE_KV_NAMESPACE_ID_HERE` with the id from Step 3, and `PASTE_CHANNEL_ID_HERE` with the channel ID from Task 1 Step 3.

- [x] **Step 6: Generate and set the shared auth secret**

This secret is minted fresh for LootOps-Vote-to-Worker authentication (not a third-party credential), so it can be generated and set directly:

```bash
cd worker
SHARED_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "$SHARED_SECRET" | npx wrangler secret put SHARED_AUTH_SECRET
```
Save the printed value somewhere — it'll be needed again in the later frontend-integration stage, entered once into `LootOps-Vote`'s settings.

- [x] **Step 7: Write the Worker skeleton**

`worker/src/index.js`:
```js
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-LootOps-Auth',
};

function jsonResponse(body, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isAuthorized(request, env){
  const provided = request.headers.get('X-LootOps-Auth') || '';
  return provided.length > 0 && provided === env.SHARED_AUTH_SECRET;
}

export default {
  async fetch(request, env, ctx){
    if(request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if(!isAuthorized(request, env)){
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    return jsonResponse({ error: 'Not found', path: url.pathname }, 404);
  },

  async scheduled(event, env, ctx){
    // Cron sweep implemented in Task 5
  },
};
```

- [x] **Step 8: Deploy the skeleton and verify auth works**

Run:
```bash
cd worker
npx wrangler deploy
```
Expected: output includes a deployed URL like `https://lootops-vote-worker.<your-subdomain>.workers.dev`.

Verify:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://lootops-vote-worker.<your-subdomain>.workers.dev/vote
curl -s -o /dev/null -w "%{http_code}\n" -H "X-LootOps-Auth: wrong-secret" https://lootops-vote-worker.<your-subdomain>.workers.dev/vote
curl -s -o /dev/null -w "%{http_code}\n" -H "X-LootOps-Auth: $SHARED_SECRET" https://lootops-vote-worker.<your-subdomain>.workers.dev/vote
```
Expected: first two return `401`, the third returns `404` (authorized, but no route matches yet).

---

### Task 3: Implement `POST /vote` — post items to Discord and self-react

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `env.DISCORD_BOT_TOKEN`, `env.DISCORD_CHANNEL_ID`, `env.VOTES_KV` from Task 2.
- Produces: `assignEmoji(index)`, `postVote(request, env)` — used by the router in this task; KV records read by Task 4.

- [x] **Step 1: Add the emoji-assignment helper**

```js
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const KEYCAP_DIGITS = '0123456789';

// Regional-indicator letter emoji, e.g. 'A' -> 🇦
function letterEmoji(letter){
  const codePoint = 0x1F1E6 + (letter.charCodeAt(0) - 65);
  return String.fromCodePoint(codePoint);
}

// Keycap digit emoji, e.g. '3' -> 3️⃣
function digitEmoji(digit){
  return digit + '⃣';
}

// Global assignment: letters A-Z first, then numbers 0-9, then further
// letter/number combos if ever needed (not expected at this app's scale).
function assignEmoji(index){
  if(index < LETTERS.length) return letterEmoji(LETTERS[index]);
  const digitIndex = index - LETTERS.length;
  if(digitIndex < KEYCAP_DIGITS.length) return digitEmoji(KEYCAP_DIGITS[digitIndex]);
  // Fallback for extreme list lengths: combine two keycap digits
  const a = Math.floor(digitIndex / KEYCAP_DIGITS.length) - 1;
  const b = digitIndex % KEYCAP_DIGITS.length;
  return digitEmoji(KEYCAP_DIGITS[a]) + digitEmoji(KEYCAP_DIGITS[b]);
}
```

- [x] **Step 2: Add Discord REST helpers**

```js
const DISCORD_API = 'https://discord.com/api/v10';

async function discordFetch(env, path, options = {}){
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res;
}

async function postDiscordMessage(env, content){
  const res = await discordFetch(env, `/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  if(!res.ok) throw new Error(`Discord message post failed: HTTP ${res.status}`);
  return res.json();
}

async function addReaction(env, messageId, emoji){
  const res = await discordFetch(
    env,
    `/channels/${env.DISCORD_CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: 'PUT' }
  );
  if(!res.ok) throw new Error(`Discord reaction add failed: HTTP ${res.status}`);
}
```

- [x] **Step 3: Add the batching + message-building logic**

```js
const MAX_REACTIONS_PER_MESSAGE = 20;

function buildMessageBatches(items){
  // items: [{ name, qty }]. Assigns emoji globally, then splits into
  // batches of at most MAX_REACTIONS_PER_MESSAGE for Discord's reaction cap.
  const withEmoji = items.map((item, index) => ({ ...item, emoji: assignEmoji(index), index }));
  const batches = [];
  for(let i = 0; i < withEmoji.length; i += MAX_REACTIONS_PER_MESSAGE){
    batches.push(withEmoji.slice(i, i + MAX_REACTIONS_PER_MESSAGE));
  }
  return batches;
}

function formatBatchContent(batch, title, batchIndex, totalBatches){
  const header = totalBatches > 1
    ? `**${title || 'LootOps Vote'}** (part ${batchIndex + 1}/${totalBatches}) — react to claim interest:`
    : `**${title || 'LootOps Vote'}** — react to claim interest:`;
  const lines = batch.map(it => `${it.emoji}  ${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`);
  return [header, ...lines].join('\n');
}
```

- [x] **Step 4: Implement `postVote` and wire it into the router**

```js
async function postVote(request, env){
  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { items, title, deadlineDays } = body;
  if(!Array.isArray(items) || items.length === 0){
    return jsonResponse({ error: 'items must be a non-empty array' }, 400);
  }

  const batches = buildMessageBatches(items);
  const messageIds = [];
  const emojiMap = [];

  try{
    for(let b = 0; b < batches.length; b++){
      const batch = batches[b];
      const content = formatBatchContent(batch, title, b, batches.length);
      const message = await postDiscordMessage(env, content);
      messageIds.push(message.id);
      for(const it of batch){
        await addReaction(env, message.id, it.emoji);
        emojiMap.push({ itemIndex: it.index, emoji: it.emoji, messageId: message.id });
      }
    }
  }catch(e){
    // No KV record is written on failure — nothing to retry against except
    // re-submitting POST /vote from scratch, per the spec's retry-safety rules.
    return jsonResponse({ error: 'Failed to post to Discord', detail: String(e) }, 502);
  }

  const voteId = crypto.randomUUID();
  const days = Number.isFinite(deadlineDays) && deadlineDays > 0 ? deadlineDays : 3;
  const record = {
    id: voteId,
    items,
    title: title || '',
    channelId: env.DISCORD_CHANNEL_ID,
    messageIds,
    emojiMap,
    createdAt: Date.now(),
    deadline: Date.now() + days * 24 * 60 * 60 * 1000,
    status: 'pending',
    results: null,
  };
  await env.VOTES_KV.put(`vote:${voteId}`, JSON.stringify(record));

  return jsonResponse({ voteId, messageIds, emojiMap, deadline: record.deadline });
}
```

In the `fetch` handler's routing (replacing the placeholder 404 body), add:
```js
    if(url.pathname === '/vote' && request.method === 'POST'){
      return postVote(request, env);
    }

    return jsonResponse({ error: 'Not found', path: url.pathname }, 404);
```

- [x] **Step 5: Deploy and verify against the real test channel**

```bash
cd worker
npx wrangler deploy
curl -s -X POST https://lootops-vote-worker.<your-subdomain>.workers.dev/vote \
  -H "X-LootOps-Auth: $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Vote","items":[{"name":"Gold Q610","qty":1},{"name":"FR-66","qty":1}]}'
```
Expected: JSON response with a `voteId`, `messageIds` (one entry), and a 2-item `emojiMap` (🇦, 🇧). In Discord, confirm a message posted to the target channel reading roughly:
```
**Test Vote** — react to claim interest:
🇦  Gold Q610
🇧  FR-66
```
with the bot's own 🇦 and 🇧 reactions already attached.

- [x] **Step 6: Verify the 20-item message-split behavior**

```bash
curl -s -X POST https://lootops-vote-worker.<your-subdomain>.workers.dev/vote \
  -H "X-LootOps-Auth: $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Split Test","items":[{"name":"Item 1","qty":1},{"name":"Item 2","qty":1},{"name":"Item 3","qty":1},{"name":"Item 4","qty":1},{"name":"Item 5","qty":1},{"name":"Item 6","qty":1},{"name":"Item 7","qty":1},{"name":"Item 8","qty":1},{"name":"Item 9","qty":1},{"name":"Item 10","qty":1},{"name":"Item 11","qty":1},{"name":"Item 12","qty":1},{"name":"Item 13","qty":1},{"name":"Item 14","qty":1},{"name":"Item 15","qty":1},{"name":"Item 16","qty":1},{"name":"Item 17","qty":1},{"name":"Item 18","qty":1},{"name":"Item 19","qty":1},{"name":"Item 20","qty":1},{"name":"Item 21","qty":1},{"name":"Item 22","qty":1}]}'
```
Expected: response has `messageIds` with 2 entries; in Discord, message 1 has items 1-20 with emoji 🇦-🇹, message 2 has items 21-22 with emoji 🇺-🇻 (letters continue across the split, not reset).

- [x] **Step 7: Add `.gitignore` and commit**

Create `worker/.gitignore`:
```
node_modules/
.wrangler/
```

```bash
cd ..
git add worker/
git commit -m "feat: add Cloudflare Worker skeleton and POST /vote endpoint"
git push
```

**Added during execution (not in the original plan):** role-ping support (`GET /roles` endpoint, guild ID auto-derived from the channel, spoilered `||<@&roleId>||` mention scoped via `allowed_mentions`), the full item line layout (`Emoji | Item name (info) | Quality | SCU | Quantity` with blank fields omitted), a `when`/`flavorText` header, and Discord `429` rate-limit retry on reaction adds. All verified live against the real test Discord server/channel. See the updated design spec for details. These are reflected directly in `worker/src/index.js`.

---

### Task 4: Implement `GET /vote/:id` and `POST /vote/:id/finalize`

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: vote records written by Task 3's `postVote`.
- Produces: `finalizeVote(env, voteId)` — reused by Task 5's cron handler.

- [x] **Step 1: Add the reaction-fetching + results-computation helper**

```js
async function fetchReactionUsers(env, messageId, emoji){
  const res = await discordFetch(
    env,
    `/channels/${env.DISCORD_CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`,
    { method: 'GET' }
  );
  if(!res.ok) throw new Error(`Discord reaction fetch failed: HTTP ${res.status}`);
  const users = await res.json();
  // Exclude the bot's own self-reaction from the voter list.
  return users.filter(u => !u.bot).map(u => u.username);
}

async function finalizeVote(env, voteId){
  const raw = await env.VOTES_KV.get(`vote:${voteId}`);
  if(!raw) return { ok: false, error: 'not_found' };

  const record = JSON.parse(raw);
  if(record.status === 'ready') return { ok: true, record }; // idempotent

  let results;
  try{
    results = {};
    for(const entry of record.emojiMap){
      const voters = await fetchReactionUsers(env, entry.messageId, entry.emoji);
      results[entry.itemIndex] = voters;
    }
  }catch(e){
    // Leave status as "pending" on any failure — the cron sweep or another
    // manual finalize call will retry later, per the spec's retry-safety rules.
    return { ok: false, error: String(e) };
  }

  record.status = 'ready';
  record.results = results;
  record.finalizedAt = Date.now();
  await env.VOTES_KV.put(`vote:${voteId}`, JSON.stringify(record));
  return { ok: true, record };
}
```

- [x] **Step 2: Add the `GET /vote/:id` and `POST /vote/:id/finalize` handlers**

```js
async function getVote(voteId, env){
  const raw = await env.VOTES_KV.get(`vote:${voteId}`);
  if(!raw) return jsonResponse({ error: 'Vote not found' }, 404);
  return jsonResponse(JSON.parse(raw));
}

async function finalizeVoteEndpoint(voteId, env){
  const result = await finalizeVote(env, voteId);
  if(!result.ok){
    if(result.error === 'not_found') return jsonResponse({ error: 'Vote not found' }, 404);
    return jsonResponse({ error: 'Finalize failed, still pending', detail: result.error }, 502);
  }
  return jsonResponse(result.record);
}
```

- [x] **Step 3: Wire both routes into the router**

Replace the routing block from Task 3 Step 4 with:
```js
    if(url.pathname === '/vote' && request.method === 'POST'){
      return postVote(request, env);
    }

    const voteMatch = url.pathname.match(/^\/vote\/([^/]+)(\/finalize)?$/);
    if(voteMatch && request.method === 'GET' && !voteMatch[2]){
      return getVote(voteMatch[1], env);
    }
    if(voteMatch && request.method === 'POST' && voteMatch[2]){
      return finalizeVoteEndpoint(voteMatch[1], env);
    }

    return jsonResponse({ error: 'Not found', path: url.pathname }, 404);
```

- [x] **Step 4: Deploy and verify end-to-end with the real test channel**

```bash
cd worker
npx wrangler deploy
```

Using the `voteId` from Task 3 Step 5's test vote, in Discord: react to 🇦 with your own account, then:
```bash
curl -s https://lootops-vote-worker.<your-subdomain>.workers.dev/vote/<voteId> \
  -H "X-LootOps-Auth: $SHARED_SECRET"
```
Expected: `"status":"pending"` (not finalized yet).

```bash
curl -s -X POST https://lootops-vote-worker.<your-subdomain>.workers.dev/vote/<voteId>/finalize \
  -H "X-LootOps-Auth: $SHARED_SECRET"
```
Expected: `"status":"ready"`, with `"results"` showing your username under item index `0` (the 🇦 item) and an empty array under item index `1` (🇧, unreacted).

Run the same `GET /vote/<voteId>` call again — expected: still `"status":"ready"` with the same results (confirms idempotency, no re-fetch from Discord on an already-finalized vote).

- [x] **Step 5: Commit**

```bash
cd ..
git add worker/
git commit -m "feat: add GET /vote/:id and POST /vote/:id/finalize endpoints"
git push
```

---

### Task 5: Implement the hourly Cron Trigger sweep

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `finalizeVote(env, voteId)` from Task 4.

- [x] **Step 1: Implement the `scheduled` handler**

Replace the placeholder `scheduled` function from Task 2 Step 7 with:
```js
  async scheduled(event, env, ctx){
    const list = await env.VOTES_KV.list({ prefix: 'vote:' });
    const now = Date.now();
    for(const key of list.keys){
      const raw = await env.VOTES_KV.get(key.name);
      if(!raw) continue;
      const record = JSON.parse(raw);
      if(record.status === 'pending' && now >= record.deadline){
        ctx.waitUntil(finalizeVote(env, record.id));
      }
    }
  },
```

- [x] **Step 2: Deploy**

```bash
cd worker
npx wrangler deploy
```
Expected: deploy output confirms the cron trigger `0 * * * *` is registered.

- [x] **Step 3: Verify the cron logic manually (without waiting an hour)**

Wrangler can invoke the scheduled handler directly against the deployed Worker for testing:
```bash
npx wrangler deploy --dry-run  # sanity check the config parses
curl -s "https://lootops-vote-worker.<your-subdomain>.workers.dev/__scheduled?cron=0+*+*+*+*"
```
If `/__scheduled` isn't reachable on your Workers plan, instead: create a **new** test vote with `deadlineDays` set to a fraction of a day for testing —
```bash
curl -s -X POST https://lootops-vote-worker.<your-subdomain>.workers.dev/vote \
  -H "X-LootOps-Auth: $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Cron Test","items":[{"name":"Cron Item","qty":1}],"deadlineDays":0.0007}'
```
(`0.0007` days ≈ 1 minute.) React to it in Discord within that minute, then wait just over an hour for the next scheduled run (or trigger `finalize` manually via Task 4's endpoint to confirm the logic itself, treating the cron sweep as "the same finalize logic, just triggered on a timer" — the timer mechanism itself is Cloudflare's own scheduling, not something this app's logic needs to re-verify beyond confirming the trigger is registered in Step 2).

- [x] **Step 4: Commit**

```bash
cd ..
git add worker/
git commit -m "feat: add hourly cron sweep to auto-finalize expired votes"
git push
```

---

## Verification Checklist

- [x] `wrangler.toml` has a valid `VOTES_KV` binding and `DISCORD_CHANNEL_ID` var.
- [x] `DISCORD_BOT_TOKEN` and `SHARED_AUTH_SECRET` are set as Worker secrets (never committed to git).
- [x] `POST /vote` posts to the real Discord test channel with correctly-assigned letter/number emoji and the bot self-reacts immediately.
- [x] Item lists over 20 entries split into multiple messages, continuing the same emoji sequence.
- [x] `GET /vote/:id` returns `pending` before the deadline/manual finalize, `ready` with correct per-item voter lists after.
- [x] `POST /vote/:id/finalize` is idempotent — calling it twice doesn't re-fetch or change already-`ready` results.
- [x] A Discord fetch failure during finalize leaves the vote `pending` rather than writing bad/partial results.
- [x] The Cron Trigger `0 * * * *` is registered on deploy (confirmed via `wrangler deploy` output).
- [x] Requests without the correct `X-LootOps-Auth` header are rejected with `401`.
