# Officer Discord OAuth Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single static `SHARED_AUTH_SECRET` used to authorize all Worker calls with per-officer Discord OAuth login, so access is tied to a live Discord role check instead of a standing bearer secret.

**Architecture:** The Worker gains two new unauthenticated routes (`/auth/login`, `/auth/callback`) that run the OAuth2 authorization-code flow against Discord, check the resulting user's roles in the guild live, and — only if they hold the Officer role — mint a short-lived HMAC-signed session token. Every existing protected route swaps its `X-LootOps-Auth` shared-secret check for verification of that session token sent as `Authorization: Bearer`. The frontend gets a "Log in with Discord" button in place of the shared-secret field, picks the token up from the OAuth redirect, and attaches it to every Worker call.

**Tech Stack:** Cloudflare Worker (`worker/src/index.js`, vanilla JS, no framework), Web Crypto API (`crypto.subtle`) for HMAC-SHA256 signing — available natively in the Workers runtime, no new dependency. Frontend is plain JS in `index.html`, no framework.

## Global Constraints

- No new npm dependencies — this repo has none (`worker/package.json` only lists `wrangler` as a devDependency) and the design doesn't need any; Web Crypto covers HMAC signing.
- Never put `DISCORD_CLIENT_SECRET` or `SESSION_SIGNING_SECRET` literal values in any file, command, or chat message — both are set via `wrangler secret put` run by the user directly in their own terminal, same rule already established for `DISCORD_BOT_TOKEN`.
- The Discord bot token (`DISCORD_BOT_TOKEN`) and its usage (`discordFetch`, posting messages/reactions) are untouched by this plan.
- Per repo convention (`worker/CLAUDE.md` equivalent — see root `CLAUDE.md`'s "no build step" spirit applied to the Worker too): this is a single-file Worker (`worker/src/index.js`); keep additions in that file rather than splitting into modules.
- There is no automated test framework in this repo (`worker/package.json`'s `test` script is a stub, and `index.html` has none either) — verification throughout this plan is manual: pure-logic pieces (token signing/verification) are checked with a throwaway Node script run locally and discarded; the OAuth redirect flow itself can only be verified by actually clicking through it in a browser against a running `wrangler dev` instance, since it requires a real Discord login. Follow the existing project pattern of live-testing against the real (personal test) Discord server before considering a task done.

---

### Task 1: Session-token and state-token signing helpers (Worker)

**Files:**
- Modify: `worker/src/index.js` (add new functions near the top, after the existing `isAuthorized`/`jsonResponse` block around line 17)

**Interfaces:**
- Produces: `base64urlEncode(bytes: Uint8Array): string`, `base64urlDecode(str: string): Uint8Array`, `hmacSign(env_secret: string, data: string): Promise<string>` (returns base64url signature), `hmacVerify(env_secret: string, data: string, signature: string): Promise<boolean>`, `signToken(env_secret: string, payload: object): Promise<string>` (returns `<payloadB64>.<sigB64>`), `verifyToken(env_secret: string, token: string): Promise<object|null>` (returns parsed payload if signature valid and not tampered, else `null` — does NOT check `exp`, callers check expiry themselves since state-tokens and session-tokens have different freshness rules).
- Consumes: nothing new — uses the Workers runtime's global `crypto.subtle`.

- [ ] **Step 1: Add base64url + HMAC helpers**

Add this block in `worker/src/index.js` right after the existing `isAuthorized` function (currently ends at line 17):

```js
function base64urlEncode(bytes){
  let binary = '';
  for(const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str){
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + (4 - str.length % 4) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret){
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}
async function hmacSign(secret, data){
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64urlEncode(new Uint8Array(sigBuf));
}
async function hmacVerify(secret, data, signatureB64){
  const key = await hmacKey(secret);
  let sigBytes;
  try{ sigBytes = base64urlDecode(signatureB64); }catch(e){ return false; }
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
}

// Generic signed-token helpers, used for both the short-lived OAuth `state`
// param and the longer-lived officer session token. Signature verification
// only proves the payload wasn't tampered with — callers must separately
// check any `exp` field themselves, since state-tokens and session-tokens
// use different freshness windows.
async function signToken(secret, payload){
  const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}
async function verifyToken(secret, token){
  if(typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const ok = await hmacVerify(secret, payloadB64, sig);
  if(!ok) return null;
  try{
    return JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  }catch(e){
    return null;
  }
}
```

- [ ] **Step 2: Verify with a throwaway Node script**

Web Crypto's `crypto.subtle` and `btoa`/`atob` are also available globally in modern Node (v20+). Write a temporary script (do NOT commit it) at the path given by your scratchpad directory, e.g. `verify-token-helpers.mjs`:

```js
// Paste the base64urlEncode/base64urlDecode/hmacKey/hmacSign/hmacVerify/signToken/verifyToken
// functions from worker/src/index.js here unchanged, then:

const secret = 'test-secret';
const token = await signToken(secret, { sub: '123', exp: Math.floor(Date.now()/1000) + 60 });
console.log('token:', token);
console.log('verify with correct secret:', await verifyToken(secret, token)); // should print the payload object
console.log('verify with wrong secret:', await verifyToken('wrong', token)); // should print null
console.log('verify tampered token:', await verifyToken(secret, token + 'x')); // should print null
```

Run: `node verify-token-helpers.mjs`
Expected: first verify prints `{ sub: '123', exp: ... }`, the other two print `null`. Delete the script once confirmed.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): add signed-token helpers for OAuth state and sessions"
```

---

### Task 2: OAuth login and callback endpoints (Worker)

**Files:**
- Modify: `worker/src/index.js` (add new functions after Task 1's block, and two new route handlers before `export default`)
- Modify: `worker/wrangler.toml` (add new `[vars]` entries)

**Interfaces:**
- Consumes: `signToken`/`verifyToken` from Task 1; existing `getGuildId(env)` (worker/src/index.js:81) and `DISCORD_API` constant.
- Produces: `handleAuthLogin(request, env): Promise<Response>`, `handleAuthCallback(request, env): Promise<Response>` — both wired into the router in Task 3's routing changes but written standalone here so Task 3 only needs to add two `if` branches.
- New env vars this task depends on existing at runtime: `env.DISCORD_CLIENT_ID`, `env.DISCORD_CLIENT_SECRET` (secret), `env.OFFICER_ROLE_ID`, `env.ALLOWED_RETURN_ORIGINS` (comma-separated string), `env.SESSION_SIGNING_SECRET` (secret, shared with Task 1's helpers).

- [ ] **Step 1: Add OAuth constants and origin/redirect validation helper**

Add after Task 1's block:

```js
const DISCORD_OAUTH_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_OAUTH_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes to complete the Discord login
const SESSION_MAX_AGE_S = 8 * 60 * 60; // 8 hours

function isAllowedReturnOrigin(returnTo, env){
  try{
    const origin = new URL(returnTo).origin;
    const allowed = (env.ALLOWED_RETURN_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return allowed.includes(origin);
  }catch(e){
    return false;
  }
}

function callbackUrl(request, env){
  return new URL('/auth/callback', request.url).toString();
}
```

- [ ] **Step 2: Add `handleAuthLogin`**

```js
async function handleAuthLogin(request, env){
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('returnTo') || '';
  if(!isAllowedReturnOrigin(returnTo, env)){
    return jsonResponse({ error: 'returnTo origin not allowed' }, 400);
  }

  const state = await signToken(env.SESSION_SIGNING_SECRET, { returnTo, ts: Date.now() });

  const authorizeUrl = new URL(DISCORD_OAUTH_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl(request, env));
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify guilds.members.read');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('prompt', 'consent');

  return Response.redirect(authorizeUrl.toString(), 302);
}
```

- [ ] **Step 3: Add `handleAuthCallback`**

```js
async function handleAuthCallback(request, env){
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');

  const statePayload = stateToken ? await verifyToken(env.SESSION_SIGNING_SECRET, stateToken) : null;
  if(!statePayload || !isAllowedReturnOrigin(statePayload.returnTo, env) || (Date.now() - statePayload.ts) > STATE_MAX_AGE_MS){
    return jsonResponse({ error: 'Invalid or expired login attempt. Please try logging in again.' }, 400);
  }
  const returnTo = statePayload.returnTo;

  if(!code){
    return Response.redirect(returnTo + '#error=' + encodeURIComponent('Discord login was cancelled or failed.'), 302);
  }

  // Exchange the authorization code for a short-lived Discord access token.
  const tokenRes = await fetch(DISCORD_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(request, env),
    }),
  });
  if(!tokenRes.ok){
    return Response.redirect(returnTo + '#error=' + encodeURIComponent('Discord login failed during token exchange.'), 302);
  }
  const tokenData = await tokenRes.json();

  // Live role check: ask Discord, right now, whether this specific user
  // currently holds the Officer role in our guild. This is the check that
  // makes the whole flow safe to revoke instantly from Discord's side.
  const guildId = await getGuildId(env);
  const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
  });
  if(!memberRes.ok){
    return Response.redirect(returnTo + '#error=' + encodeURIComponent('Could not verify your server membership.'), 302);
  }
  const member = await memberRes.json();
  const roles = member.roles || [];
  if(!roles.includes(env.OFFICER_ROLE_ID)){
    return Response.redirect(returnTo + '#error=' + encodeURIComponent('Your Discord account does not have the Officer role.'), 302);
  }

  const username = member.user && (member.user.global_name || member.user.username) || 'Officer';
  const sessionToken = await signToken(env.SESSION_SIGNING_SECRET, {
    sub: member.user && member.user.id,
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S,
  });

  return Response.redirect(returnTo + '#session=' + encodeURIComponent(sessionToken), 302);
}
```

- [ ] **Step 4: Add new `wrangler.toml` vars**

Modify `worker/wrangler.toml`'s `[vars]` section (currently just `DISCORD_CHANNEL_ID`):

```toml
[vars]
DISCORD_CHANNEL_ID = "1533862779407175812"
DISCORD_CLIENT_ID = "REPLACE_WITH_YOUR_APPLICATION_CLIENT_ID"
OFFICER_ROLE_ID = "REPLACE_WITH_OFFICER_ROLE_ID"
ALLOWED_RETURN_ORIGINS = "https://d4ngrs.github.io"
```

Leave the `REPLACE_WITH_...` placeholders for the user to fill in during Task 5's manual setup — these are public identifiers (not secrets), safe to commit once filled in.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js worker/wrangler.toml
git commit -m "feat(worker): add /auth/login and /auth/callback OAuth handlers"
```

(Verification for these two handlers happens end-to-end in Task 3's manual test, once they're actually wired into routing and there's a session-protected endpoint to confirm the token works against.)

---

### Task 3: Swap route authorization to session verification (Worker)

**Files:**
- Modify: `worker/src/index.js` (replace `isAuthorized`, update `CORS_HEADERS`, update the `fetch` router)

**Interfaces:**
- Consumes: `verifyToken` from Task 1, `handleAuthLogin`/`handleAuthCallback` from Task 2.
- Produces: `isAuthorizedSession(request, env): Promise<boolean>` — replaces the old `isAuthorized`.

- [ ] **Step 1: Replace `isAuthorized` with `isAuthorizedSession`**

Replace (worker/src/index.js:14-17):
```js
function isAuthorized(request, env){
  const provided = request.headers.get('X-LootOps-Auth') || '';
  return provided.length > 0 && provided === env.SHARED_AUTH_SECRET;
}
```
with:
```js
async function isAuthorizedSession(request, env){
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if(!match) return false;
  const payload = await verifyToken(env.SESSION_SIGNING_SECRET, match[1]);
  if(!payload || typeof payload.exp !== 'number') return false;
  return payload.exp > Math.floor(Date.now() / 1000);
}
```

- [ ] **Step 2: Update CORS header**

Change (worker/src/index.js:4):
```js
  'Access-Control-Allow-Headers': 'Content-Type, X-LootOps-Auth',
```
to:
```js
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
```

- [ ] **Step 3: Update the router to expose `/auth/*` before the auth gate and use the new check everywhere else**

Replace the top of `fetch` (worker/src/index.js:395-402):
```js
  async fetch(request, env, ctx){
    if(request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if(!isAuthorized(request, env)){
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);
```
with:
```js
  async fetch(request, env, ctx){
    if(request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Auth endpoints must be reachable *without* an existing session — that's
    // the whole point of logging in.
    if(url.pathname === '/auth/login' && request.method === 'GET'){
      return handleAuthLogin(request, env);
    }
    if(url.pathname === '/auth/callback' && request.method === 'GET'){
      return handleAuthCallback(request, env);
    }

    if(!await isAuthorizedSession(request, env)){
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
```

(The rest of `fetch` — the `/vote`, `/roles`, `/vote/:id...` branches — is unchanged; they now run after the new session check instead of the old shared-secret check. The `const url = new URL(request.url);` line that used to appear after the auth check is removed since it now appears earlier, before the `/auth/*` branches.)

- [ ] **Step 4: Deploy to the test Worker**

Run: `cd worker && wrangler deploy`
Expected: deploy succeeds. Note: `env.DISCORD_CLIENT_ID`/`OFFICER_ROLE_ID` in `wrangler.toml` still have placeholder values at this point (filled in during Task 5) — that's fine, this deploy is just to confirm the code compiles and routes correctly; full login can't be tested until Task 5's Discord Developer Portal setup is done.

- [ ] **Step 5: Verify the auth gate behavior with a throwaway Node script**

Once Task 5's manual setup (Discord app OAuth config + secrets) is done and at least one successful login has produced a real session token (copy it from the browser URL fragment during Task 4/5 testing), verify the gate directly:

```js
// verify-auth-gate.mjs — do not commit
const base = 'https://lootops-vote-worker.lootopsd4.workers.dev';

const noAuth = await fetch(base + '/roles');
console.log('no auth header:', noAuth.status); // expect 401

const badAuth = await fetch(base + '/roles', { headers: { Authorization: 'Bearer garbage' } });
console.log('garbage token:', badAuth.status); // expect 401

const goodAuth = await fetch(base + '/roles', { headers: { Authorization: 'Bearer PASTE_REAL_SESSION_TOKEN_HERE' } });
console.log('real session token:', goodAuth.status); // expect 200
```

Run: `node verify-auth-gate.mjs`
Expected: `401`, `401`, `200` in that order. Delete the script once confirmed.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): gate all routes on verified Discord session tokens"
```

---

### Task 4: Frontend login/logout integration

**Files:**
- Modify: `index.html` (settings modal markup around line 1504-1514; JS around lines 3157-3333 and the `#postVoteBtn` guard around line 3456)

**Interfaces:**
- Consumes: nothing new from other tasks — talks to the deployed Worker's `/auth/login` redirect and reads the `#session=`/`#error=` fragment it redirects back with (Task 2/3).
- Produces: `loadSession()`, `saveSession(token)`, `clearSession()`, `decodeSessionPayload(token)`, `isSessionValidLocally()`, `updateLoginUI()` — used by `workerFetch` and the vote-posting flow.

- [ ] **Step 1: Replace the settings modal's secret field with login UI**

Replace (index.html:1504-1514):
```html
      <div class="modal-title">Discord Vote Worker</div>
      <label class="modal-label" for="workerUrlInput">Worker URL</label>
      <input type="text" class="entry-input" id="workerUrlInput" placeholder="https://lootops-vote-worker.your-subdomain.workers.dev" autocomplete="off">
      <label class="modal-label" for="workerSecretInput" style="margin-top:10px;">Shared Secret</label>
      <input type="password" class="entry-input" id="workerSecretInput" placeholder="Shared secret from wrangler secret put" autocomplete="off">
      <div class="modal-hint">Connects to the Cloudflare Worker that posts item lists to Discord for voting and reads back results. Both values come from the Worker's own setup.</div>
      <div class="modal-actions">
        <button type="button" class="primary-btn" id="saveWorkerConfigBtn">Save</button>
        <button type="button" class="ghost-btn danger" id="clearWorkerConfigBtn">Clear</button>
      </div>
      <div class="modal-status" id="workerConfigStatus"></div>
```
with:
```html
      <div class="modal-title">Discord Vote Worker</div>
      <label class="modal-label" for="workerUrlInput">Worker URL</label>
      <input type="text" class="entry-input" id="workerUrlInput" placeholder="https://lootops-vote-worker.your-subdomain.workers.dev" autocomplete="off">
      <div class="modal-hint">The Cloudflare Worker that posts item lists to Discord for voting and reads back results.</div>
      <div class="modal-actions">
        <button type="button" class="primary-btn" id="saveWorkerUrlBtn">Save URL</button>
      </div>
      <div class="modal-status" id="workerConfigStatus"></div>

      <hr class="modal-divider">

      <div class="modal-title">Officer Login</div>
      <div class="modal-hint">Log in with Discord to authorize posting votes and rolling results. Only accounts with the Officer role can proceed; access is checked live at login and expires automatically.</div>
      <div class="modal-status" id="workerLoginStatus"></div>
      <div class="modal-actions">
        <button type="button" class="primary-btn" id="workerLoginBtn">Log in with Discord</button>
        <button type="button" class="ghost-btn danger hidden" id="workerLogoutBtn">Log out</button>
      </div>
```

- [ ] **Step 2: Replace the worker-secret storage helpers with session storage helpers**

Replace (index.html:3275-3305):
```js
// ---- Discord Vote Worker connection ----
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
```
with:
```js
// ---- Discord Vote Worker connection ----
const WORKER_URL_KEY = 'rollcall_vote_worker_url_v1';
const WORKER_SESSION_KEY = 'rollcall_vote_session_v1';

function loadWorkerUrl(){
  try{ return (localStorage.getItem(WORKER_URL_KEY) || '').replace(/\/+$/, ''); }
  catch(e){ return ''; }
}
function saveWorkerUrl(url){
  try{ localStorage.setItem(WORKER_URL_KEY, url.replace(/\/+$/, '')); }catch(e){ /* ignore */ }
}
function loadSession(){
  try{ return localStorage.getItem(WORKER_SESSION_KEY) || ''; }
  catch(e){ return ''; }
}
function saveSession(token){
  try{ localStorage.setItem(WORKER_SESSION_KEY, token); }catch(e){ /* ignore */ }
}
function clearSession(){
  try{ localStorage.removeItem(WORKER_SESSION_KEY); }catch(e){ /* ignore */ }
}
// Client-side decode for display only (e.g. "Logged in as X") — this is not
// a security check. The Worker independently verifies the signature and
// expiry of every token on every request; a tampered token simply gets a
// 401 from the Worker regardless of what this function shows on screen.
function decodeSessionPayload(token){
  if(!token || !token.includes('.')) return null;
  try{
    const [payloadB64] = token.split('.');
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(payloadB64.length + (4 - payloadB64.length % 4) % 4, '=');
    return JSON.parse(atob(padded));
  }catch(e){
    return null;
  }
}
function isSessionValidLocally(){
  const payload = decodeSessionPayload(loadSession());
  return !!payload && typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
}

async function workerFetch(path, options = {}){
  const base = loadWorkerUrl();
  if(!base) throw new Error('No Worker URL configured');
  const res = await fetch(base + path, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + loadSession(),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if(res.status === 401){
    clearSession();
    updateLoginUI();
  }
  return res;
}
```

- [ ] **Step 3: Replace the settings-modal wiring for the login/logout buttons**

Replace (index.html:3307-3333, the `workerUrlInput`/`workerSecretInput` element refs through the end of `clearWorkerConfigBtn`'s handler):
```js
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
with:
```js
const workerUrlInput = document.getElementById('workerUrlInput');
const saveWorkerUrlBtn = document.getElementById('saveWorkerUrlBtn');
const workerConfigStatusEl = document.getElementById('workerConfigStatus');
const workerLoginBtn = document.getElementById('workerLoginBtn');
const workerLogoutBtn = document.getElementById('workerLogoutBtn');
const workerLoginStatusEl = document.getElementById('workerLoginStatus');

function setWorkerConfigStatus(msg, kind){
  workerConfigStatusEl.textContent = msg;
  workerConfigStatusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
}

saveWorkerUrlBtn.addEventListener('click', () => {
  const url = workerUrlInput.value.trim();
  if(!url){ setWorkerConfigStatus('Enter the Worker URL.', 'err'); return; }
  saveWorkerUrl(url);
  setWorkerConfigStatus('Saved.', 'ok');
});

function updateLoginUI(){
  const payload = isSessionValidLocally() ? decodeSessionPayload(loadSession()) : null;
  if(payload){
    workerLoginStatusEl.textContent = 'Logged in as ' + payload.username + '.';
    workerLoginStatusEl.className = 'modal-status ok';
    workerLoginBtn.classList.add('hidden');
    workerLogoutBtn.classList.remove('hidden');
  }else{
    workerLoginStatusEl.textContent = 'Not logged in.';
    workerLoginStatusEl.className = 'modal-status';
    workerLoginBtn.classList.remove('hidden');
    workerLogoutBtn.classList.add('hidden');
  }
}

workerLoginBtn.addEventListener('click', () => {
  const base = loadWorkerUrl();
  if(!base){ setWorkerConfigStatus('Save the Worker URL first.', 'err'); return; }
  const returnTo = location.href.split('#')[0];
  location.href = base + '/auth/login?returnTo=' + encodeURIComponent(returnTo);
});

workerLogoutBtn.addEventListener('click', () => {
  clearSession();
  updateLoginUI();
});
```

- [ ] **Step 4: Pick up the session token (or error) from the OAuth redirect on page load, and update `openSettings`**

Replace (index.html:3161-3167):
```js
function openSettings(){
  historyWebhookUrlInput.value = loadHistoryWebhookUrl();
  workerUrlInput.value = loadWorkerUrl();
  workerSecretInput.value = loadWorkerSecret();
  settingsOverlay.classList.remove('hidden');
  lockBodyScroll();
}
```
with:
```js
function openSettings(){
  historyWebhookUrlInput.value = loadHistoryWebhookUrl();
  workerUrlInput.value = loadWorkerUrl();
  updateLoginUI();
  settingsOverlay.classList.remove('hidden');
  lockBodyScroll();
}
```

Then add, near the end of the script (after `updateLoginUI` is defined, run once on load):
```js
// Pick up the OAuth redirect's #session=... or #error=... fragment, if present.
(function consumeAuthRedirect(){
  const hash = location.hash;
  if(!hash) return;
  const params = new URLSearchParams(hash.slice(1));
  const session = params.get('session');
  const error = params.get('error');
  if(session){
    saveSession(session);
  }
  if(session || error){
    history.replaceState(null, '', location.pathname + location.search);
  }
  if(error){
    // Surfaced the next time settings are opened via updateLoginUI/workerLoginStatusEl;
    // also shown immediately if settings happen to already be open.
    setTimeout(() => {
      workerLoginStatusEl.textContent = error;
      workerLoginStatusEl.className = 'modal-status err';
    }, 0);
  }
})();
updateLoginUI();
```

- [ ] **Step 5: Update the post-vote guard to check session validity instead of the old secret**

Replace (index.html:3456):
```js
  if(!loadWorkerUrl() || !loadWorkerSecret()){ errorEl.textContent = 'Configure the Discord Vote Worker in settings first.'; return; }
```
with:
```js
  if(!loadWorkerUrl() || !isSessionValidLocally()){ errorEl.textContent = 'Log in with Discord in settings first.'; return; }
```

- [ ] **Step 6: Manual end-to-end verification in a browser**

This step can only be done after Task 5's Discord Developer Portal setup (OAuth client ID/secret, redirect URI, Officer role ID) is complete and the Worker is deployed with real (non-placeholder) `wrangler.toml` vars and secrets.

1. Open `index.html` (local static server or the deployed GitHub Pages site), open Settings, confirm it shows "Not logged in."
2. Click "Log in with Discord" — confirm it redirects to Discord's real login/consent screen.
3. Approve as an account that has the Officer role on the test server. Confirm you land back in the app with Settings showing "Logged in as {your Discord name}."
4. Confirm `localStorage.getItem('rollcall_vote_session_v1')` (via devtools) holds a token and the URL bar no longer has a `#session=...` fragment.
5. Try again with a Discord account that does NOT have the Officer role — confirm you land back with an error message and no session saved.
6. With a valid session, use "Post to Discord for Voting" — confirm it succeeds (this exercises `workerFetch` sending the real `Authorization: Bearer` header end to end).
7. Click "Log out" — confirm "Post to Discord for Voting" is blocked again with "Log in with Discord in settings first."

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: replace shared-secret Worker auth with Discord officer login"
```

---

### Task 5: Manual Discord/Cloudflare setup and old-secret cleanup

**Files:**
- Modify: `worker/wrangler.toml` (fill in the placeholders from Task 2, done manually by the user)
- Modify: `worker/.gitignore` (no change expected, just confirm `.shared_secret_tmp` entry is still accurate or remove it if no longer used)
- Modify: `docs/HANDOFF.md` (update the auth section to describe the new flow instead of the shared secret)

This task is mostly manual steps for the user — Claude should present them clearly and wait rather than attempting to perform any of them, consistent with the existing rule that bot-adjacent secrets are never typed into this chat.

- [ ] **Step 1 (user): Configure OAuth2 on the existing Discord application**

In the Discord Developer Portal, open the same application the bot already belongs to → OAuth2 tab:
- Copy the **Client ID** → this is not secret, paste it into `worker/wrangler.toml`'s `DISCORD_CLIENT_ID` (replacing the Task 2 placeholder).
- Generate/reveal the **Client Secret** → do NOT paste it into chat or any file; run `wrangler secret put DISCORD_CLIENT_SECRET` in your own terminal and paste it at the prompt.
- Add a **Redirect** entry: `https://lootops-vote-worker.lootopsd4.workers.dev/auth/callback` (adjust if the Worker's deployed URL differs).

- [ ] **Step 2 (user): Get the Officer role ID and set it**

With Developer Mode enabled in Discord, right-click the role you want to gate access on (on the test server) → Copy Role ID. Paste it into `worker/wrangler.toml`'s `OFFICER_ROLE_ID` (replacing the Task 2 placeholder).

- [ ] **Step 3 (user): Generate and set the session signing secret**

Generate a random value yourself (e.g. `openssl rand -hex 32`, or any password generator) and run `wrangler secret put SESSION_SIGNING_SECRET` in your own terminal, pasting it at the prompt. This value never needs to be typed anywhere else — the Worker is the only thing that ever needs it.

- [ ] **Step 4 (user + Claude): Deploy and confirm `ALLOWED_RETURN_ORIGINS` is correct**

Confirm `worker/wrangler.toml`'s `ALLOWED_RETURN_ORIGINS` lists every origin the app is actually served from that you test from (e.g. `https://d4ngrs.github.io` for the real site; add `http://localhost:PORT` temporarily, comma-separated, if testing locally — remove local entries before considering this "production-ready" for the real org).

Run: `cd worker && wrangler deploy`

- [ ] **Step 5: Run Task 4 Step 6's manual end-to-end browser verification now that setup is complete**

(See Task 4 Step 6 above — this is the point where that verification actually becomes possible.)

- [ ] **Step 6 (user): Retire the old shared secret**

Once the new login flow is confirmed working:
```bash
wrangler secret delete SHARED_AUTH_SECRET
```
Delete `worker/.shared_secret_tmp` locally (it's gitignored, never committed, but no longer needed):
```bash
rm worker/.shared_secret_tmp
```

- [ ] **Step 7: Update `docs/HANDOFF.md`'s auth description**

Replace the paragraph in `docs/HANDOFF.md` under "Test environment" that currently reads:
> Cloudflare Worker deployed at `https://lootops-vote-worker.lootopsd4.workers.dev`. Secrets (`DISCORD_BOT_TOKEN`, `SHARED_AUTH_SECRET`) are set via `wrangler secret put` — **not** in any file. The shared secret's plaintext value lives locally (only) in `worker/.shared_secret_tmp` (gitignored) — read it from there if you need to run manual `curl`/`node` test scripts against the Worker; don't ask the user to retype it.

with:
> Cloudflare Worker deployed at `https://lootops-vote-worker.lootopsd4.workers.dev`. Secrets (`DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`, `SESSION_SIGNING_SECRET`) are set via `wrangler secret put` — **not** in any file. Officer access uses real Discord OAuth (see `docs/superpowers/specs/2026-08-03-officer-oauth-auth-design.md`): officers log in via the app's Settings modal, which checks their Discord role live and issues a short-lived signed session token — there is no standing shared secret anymore. To run manual test scripts against protected endpoints, log in via a browser first and copy the resulting session token out of `localStorage`/the URL fragment; don't ask the user to hand you a static credential.

- [ ] **Step 8: Commit the doc and config updates**

```bash
git add worker/wrangler.toml docs/HANDOFF.md
git commit -m "docs: describe officer OAuth login, retire shared-secret references"
```

---

## Plan self-review notes

- **Spec coverage:** every element of the design spec (`docs/superpowers/specs/2026-08-03-officer-oauth-auth-design.md`) has a task: session-token helpers (Task 1), `/auth/login`+`/auth/callback` (Task 2), route auth swap + config (Task 3), frontend login UI + `workerFetch` header change + hash pickup (Task 4), manual Discord/Cloudflare setup + old-secret retirement + docs (Task 5).
- **No placeholders:** all code blocks are complete, runnable snippets, not sketches.
- **Type/name consistency:** `signToken`/`verifyToken` (Task 1) are used identically in Task 2's `handleAuthLogin`/`handleAuthCallback` and Task 3's `isAuthorizedSession`; `loadSession`/`saveSession`/`clearSession`/`isSessionValidLocally`/`updateLoginUI` (Task 4) are used consistently across the settings wiring, `workerFetch`, the redirect-consuming IIFE, and the post-vote guard.
