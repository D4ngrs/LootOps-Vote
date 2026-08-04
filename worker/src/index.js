const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function isAuthorizedSession(request, env){
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if(!match) return false;
  const payload = await verifyToken(env.SESSION_SIGNING_SECRET, match[1]);
  if(!payload || typeof payload.exp !== 'number') return false;
  return payload.exp > Math.floor(Date.now() / 1000);
}

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
  const officerRoleIds = (env.OFFICER_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if(!roles.some(r => officerRoleIds.includes(r))){
    return Response.redirect(returnTo + '#error=' + encodeURIComponent('Your Discord account does not have an authorized role.'), 302);
  }

  const username = member.user && (member.user.global_name || member.user.username) || 'Officer';
  const sessionToken = await signToken(env.SESSION_SIGNING_SECRET, {
    sub: member.user && member.user.id,
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S,
  });

  return Response.redirect(returnTo + '#session=' + encodeURIComponent(sessionToken), 302);
}

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
  const a = Math.floor(digitIndex / KEYCAP_DIGITS.length) - 1;
  const b = digitIndex % KEYCAP_DIGITS.length;
  return digitEmoji(KEYCAP_DIGITS[a]) + digitEmoji(KEYCAP_DIGITS[b]);
}

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
    // allowed_mentions restricts pings to just the role we intend (if any) —
    // without this, Discord would also parse @everyone/@here or any other
    // role/user mention accidentally present in an item name as a real ping.
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [], roles: extractRoleIdsFromContent(content) },
    }),
  });
  if(!res.ok) throw new Error(`Discord message post failed: HTTP ${res.status}`);
  return res.json();
}

function extractRoleIdsFromContent(content){
  const matches = content.match(/<@&(\d+)>/g) || [];
  return matches.map(m => m.match(/\d+/)[0]);
}

// Guild (server) ID isn't configured directly — it's derived from the
// already-configured channel, so switching servers only means updating one
// config value (DISCORD_CHANNEL_ID) instead of two.
async function getGuildId(env){
  const res = await discordFetch(env, `/channels/${env.DISCORD_CHANNEL_ID}`, { method: 'GET' });
  if(!res.ok) throw new Error(`Discord channel lookup failed: HTTP ${res.status}`);
  const channel = await res.json();
  return channel.guild_id;
}

async function getGuildRoles(env){
  const guildId = await getGuildId(env);
  const res = await discordFetch(env, `/guilds/${guildId}/roles`, { method: 'GET' });
  if(!res.ok) throw new Error(`Discord role list failed: HTTP ${res.status}`);
  const roles = await res.json();
  // @everyone is technically a role but never useful to ping from this picker.
  return roles
    .filter(r => r.name !== '@everyone')
    .map(r => ({ id: r.id, name: r.name }));
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Discord rate-limits reaction additions fairly aggressively when added back-to-back.
// Retry on 429 using the Retry-After Discord gives us, up to a few attempts.
async function addReaction(env, messageId, emoji){
  const MAX_ATTEMPTS = 5;
  for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
    const res = await discordFetch(
      env,
      `/channels/${env.DISCORD_CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'PUT' }
    );
    if(res.ok) return;
    if(res.status === 429 && attempt < MAX_ATTEMPTS){
      let retryAfterMs = 1000;
      try{
        const data = await res.json();
        if(typeof data.retry_after === 'number') retryAfterMs = Math.ceil(data.retry_after * 1000) + 50;
      }catch(e){ /* fall back to default backoff */ }
      await sleep(retryAfterMs);
      continue;
    }
    throw new Error(`Discord reaction add failed: HTTP ${res.status}`);
  }
  throw new Error('Discord reaction add failed: exhausted retries after repeated HTTP 429');
}

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

// Item name (info, italic) | Quality | SCU size | Quantity — the shared part
// of the item layout, reused both for the voting message (with an emoji
// prefixed) and the Loot Pool line in the results announcement (no emoji,
// voting is already over by then). info/quality/scu are supplied by the
// frontend as raw values (already deduped there, e.g. via buildDetailLabel)
// — this function does the "Q"/"SCU" display formatting itself, and only
// includes a field when present (quality 0 is a valid value, not "absent").
function formatItemSummary(it){
  const namePart = `${it.qty}× **${it.name}**` + (it.info ? ` _(${it.info})_` : '');
  const segments = [namePart];
  if(it.quality !== null && it.quality !== undefined) segments.push('Q' + it.quality);
  if(it.scu !== null && it.scu !== undefined) segments.push(it.scu + ' SCU');
  return segments.join('  |  ');
}
function formatItemLine(it){
  return it.emoji + '  |  ' + formatItemSummary(it);
}

// Discord renders <t:SECONDS:STYLE> client-side in each viewer's own local
// timezone/locale — no timezone math needed on our end, and :R> ("in 3 days")
// stays live/ticking on its own without any polling or backend involvement.
function discordTimestamp(msEpoch, style){
  return `<t:${Math.floor(msEpoch / 1000)}:${style}>`;
}

function formatBatchContent(batch, meta, batchIndex, totalBatches){
  const { title, postedAt, deadline, flavorText, roleId } = meta;
  const lines = [];
  if(roleId && batchIndex === 0){
    // Spoilered so the raw mention text is hidden until clicked, but the
    // role still receives a real ping/notification.
    lines.push(`||<@&${roleId}>||`);
  }
  const titleLine = `**${title || 'LootOps Vote'}**` + (postedAt ? ` — ${discordTimestamp(postedAt, 'F')}` : '');
  lines.push(totalBatches > 1 ? `${titleLine} (part ${batchIndex + 1}/${totalBatches})` : titleLine);
  if(flavorText && batchIndex === 0){
    lines.push(flavorText);
  }
  if(deadline && batchIndex === 0){
    lines.push(`⏳ Voting closes ${discordTimestamp(deadline, 'R')} (${discordTimestamp(deadline, 'F')})`);
  }
  lines.push('React to claim interest:');
  lines.push(...batch.map(formatItemLine));
  return lines.join('\n');
}

async function postVote(request, env){
  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { items, title, deadlineHours, roleId, flavorText } = body;
  if(!Array.isArray(items) || items.length === 0){
    return jsonResponse({ error: 'items must be a non-empty array' }, 400);
  }

  // Computed once up front (not per-request-received-then-again-later) so the
  // "posted at" timestamp shown to Discord viewers and the one stored in KV
  // for the deadline sweep are exactly the same instant.
  const postedAt = Date.now();
  const hours = Number.isFinite(deadlineHours) && deadlineHours > 0 ? deadlineHours : 72; // default 3 days
  const deadline = postedAt + hours * 60 * 60 * 1000;

  const batches = buildMessageBatches(items);
  const messageIds = [];
  const emojiMap = [];
  const meta = { title, postedAt, deadline, flavorText, roleId };

  try{
    for(let b = 0; b < batches.length; b++){
      const batch = batches[b];
      const content = formatBatchContent(batch, meta, b, batches.length);
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
  const record = {
    id: voteId,
    items,
    title: title || '',
    channelId: env.DISCORD_CHANNEL_ID,
    messageIds,
    emojiMap,
    createdAt: postedAt,
    deadline,
    status: 'pending',
    results: null,
  };
  await env.VOTES_KV.put(`vote:${voteId}`, JSON.stringify(record));

  return jsonResponse({ voteId, messageIds, emojiMap, deadline: record.deadline });
}

// Fetching reactions for every item in sequence can trip Discord's rate limit
// the same way rapid-fire reaction *adds* do (see addReaction) — retry on 429
// using the Retry-After Discord gives us, instead of failing the whole roll.
async function fetchReactionUsers(env, messageId, emoji){
  const MAX_ATTEMPTS = 5;
  for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
    const res = await discordFetch(
      env,
      `/channels/${env.DISCORD_CHANNEL_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`,
      { method: 'GET' }
    );
    if(res.ok){
      const users = await res.json();
      // Exclude the bot's own self-reaction from the voter list.
      return users.filter(u => !u.bot).map(u => u.username);
    }
    if(res.status === 429 && attempt < MAX_ATTEMPTS){
      let retryAfterMs = 1000;
      try{
        const data = await res.json();
        if(typeof data.retry_after === 'number') retryAfterMs = Math.ceil(data.retry_after * 1000) + 50;
      }catch(e){ /* fall back to default backoff */ }
      await sleep(retryAfterMs);
      continue;
    }
    throw new Error(`Discord reaction fetch failed: HTTP ${res.status} (message ${messageId}, emoji ${emoji})`);
  }
  throw new Error(`Discord reaction fetch failed: exhausted retries after repeated HTTP 429 (message ${messageId}, emoji ${emoji})`);
}

async function finalizeVote(env, voteId){
  const raw = await env.VOTES_KV.get(`vote:${voteId}`);
  if(!raw) return { ok: false, error: 'not_found' };

  const record = JSON.parse(raw);
  if(record.status === 'ready' || record.status === 'aborted') return { ok: true, record }; // idempotent

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

// Discord uses simple markdown — escape characters that would otherwise format unexpectedly
function escDiscord(s){
  return String(s).replace(/([*_~`|>])/g, '\\$1');
}

// Trims a field value to fit Discord's 1024-char embed field limit
function trimForEmbed(text){
  if(text.length <= 1024) return text;
  return text.slice(0, 1000) + '\n…(truncated)';
}

async function postDiscordEmbeds(env, embeds){
  const res = await discordFetch(env, `/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ embeds, allowed_mentions: { parse: [] } }),
  });
  if(!res.ok) throw new Error(`Discord embed post failed: HTTP ${res.status}`);
  return res.json();
}

// Posts the final roll outcome (who won what) into the same channel the vote
// was posted in, authored by the bot itself — no separate webhook needed for
// this, since the bot already has authorization there. Idempotent: once
// announced, repeat calls are a no-op rather than posting duplicates.
async function announceResults(voteId, request, env){
  const raw = await env.VOTES_KV.get(`vote:${voteId}`);
  if(!raw) return jsonResponse({ error: 'Vote not found' }, 404);
  const record = JSON.parse(raw);
  if(record.announced) return jsonResponse({ announced: true }); // idempotent

  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { names, buckets, leftover, spreadEven, capOne, logToHistory } = body;
  if(!Array.isArray(names) || !Array.isArray(buckets)){
    return jsonResponse({ error: 'names and buckets are required arrays' }, 400);
  }

  // Mirrors the frontend's buildRollEmbeds() two-embed format, just authored
  // by the bot instead of posted via a webhook — and, unlike that version,
  // enriches per-person results with the same quality/SCU/info fields the
  // Loot Pool line already shows, rather than bare item names.
  const itemMetaByName = new Map(record.items.map(it => [it.name, it]));
  function formatWonGroup(itemName, wonQty){
    const meta = itemMetaByName.get(itemName) || {};
    return formatItemSummary({ name: itemName, info: meta.info, quality: meta.quality, scu: meta.scu, qty: wonQty });
  }
  function groupWonItems(bucket){
    const counts = new Map();
    bucket.forEach(n => counts.set(n, (counts.get(n) || 0) + 1));
    return Array.from(counts.entries());
  }

  const participantsText = trimForEmbed(names.map(escDiscord).join(', ') || '—');
  const lootPoolText = trimForEmbed(
    record.items.map(formatItemSummary).join('\n') || '—'
  );
  const resultsText = names.length
    ? names.map((name, i) => {
        const got = buckets[i] || [];
        if(!got.length) return `**${escDiscord(name)}:**\n_nothing_`;
        const itemLines = groupWonItems(got).map(([itemName, qty]) => formatWonGroup(itemName, qty)).join('\n');
        return `**${escDiscord(name)}:**\n${itemLines}`;
      }).join('\n\n')
    : '_No one reacted to any item._';

  const mainEmbed = {
    title: record.title || 'Untitled Roll',
    color: 0xE8A33D, // matches --gold, same convention as the frontend's main embed
    fields: [
      { name: 'Date & Time', value: discordTimestamp(record.finalizedAt || Date.now(), 'F'), inline: false },
      { name: 'Participants', value: participantsText, inline: false },
      { name: 'Roll Mode', value: `Spread evenly: ${spreadEven ? 'Yes' : 'No'}\nCap at 1 item: ${capOne ? 'Yes' : 'No'}`, inline: false },
      { name: 'Loot Pool', value: lootPoolText, inline: false },
    ],
  };

  const resultsFields = [{ name: 'Results', value: trimForEmbed(resultsText), inline: false }];
  if(leftover && leftover.length){
    resultsFields.push({ name: 'Unwanted (no reactions)', value: trimForEmbed(leftover.map(escDiscord).join(', ')), inline: false });
  }
  const resultsEmbed = {
    title: (record.title ? record.title + ' - ' : '') + 'Results',
    color: 0x7C6FF0, // matches --violet, same convention as the frontend's results embed
    fields: resultsFields,
  };

  try{
    await postDiscordEmbeds(env, [mainEmbed, resultsEmbed]);
  }catch(e){
    return jsonResponse({ error: 'Failed to post results', detail: String(e) }, 502);
  }

  // Optional second channel, posted with the exact same embeds as the main
  // announcement — the two are meant to be identical, so this is a single
  // source of truth for the content rather than a separately-built copy.
  // The URL itself is a credential (holding it is enough to post to that
  // channel), so it lives only in this secret — never in the frontend/request
  // body — and this is a best-effort add-on: the main announcement already
  // succeeded regardless of whether this part works.
  if(logToHistory && env.HISTORY_WEBHOOK_URL){
    try{
      await fetch(env.HISTORY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [mainEmbed, resultsEmbed] }),
      });
    }catch(e){ /* best-effort, main announcement already succeeded */ }
  }

  record.announced = true;
  await env.VOTES_KV.put(`vote:${voteId}`, JSON.stringify(record));
  return jsonResponse({ announced: true });
}

async function getVote(voteId, env){
  const raw = await env.VOTES_KV.get(`vote:${voteId}`);
  if(!raw) return jsonResponse({ error: 'Vote not found' }, 404);
  return jsonResponse(JSON.parse(raw));
}

// Recovery path for a browser that lost its local "which vote is pending"
// pointer (rollcall_vote_pending_v1 — e.g. cleared history/localStorage, new
// device). The vote itself always lives here in KV regardless of any
// browser's state and the cron sweep finalizes it on schedule either way —
// this just lets the app re-find it so Check Status/Start Rolling Now/Abort
// and the eventual announce step are still reachable. Assumes at most one
// vote is normally in flight at a time; if several are somehow pending, just
// returns whichever KV happens to list first.
async function getActiveVoteEndpoint(env){
  const list = await env.VOTES_KV.list({ prefix: 'vote:' });
  for(const key of list.keys){
    const raw = await env.VOTES_KV.get(key.name);
    if(!raw) continue;
    const record = JSON.parse(raw);
    if(record.status === 'pending') return jsonResponse(record);
  }
  return jsonResponse({ error: 'No active vote' }, 404);
}

// Non-destructive: reads current reaction state from Discord for a still-open
// vote so the app can preview who's reacted so far, without finalizing (no
// KV write, status stays "pending"). Once the vote is no longer pending, just
// returns the stored record as-is — there's nothing live left to read.
async function previewVoteEndpoint(voteId, env){
  const raw = await env.VOTES_KV.get(`vote:${voteId}`);
  if(!raw) return jsonResponse({ error: 'Vote not found' }, 404);

  const record = JSON.parse(raw);
  if(record.status !== 'pending') return jsonResponse(record);

  try{
    const results = {};
    for(const entry of record.emojiMap){
      results[entry.itemIndex] = await fetchReactionUsers(env, entry.messageId, entry.emoji);
    }
    return jsonResponse({ ...record, results });
  }catch(e){
    return jsonResponse({ error: 'Preview failed', detail: String(e) }, 502);
  }
}

async function finalizeVoteEndpoint(voteId, env){
  const result = await finalizeVote(env, voteId);
  if(!result.ok){
    if(result.error === 'not_found') return jsonResponse({ error: 'Vote not found' }, 404);
    return jsonResponse({ error: 'Finalize failed, still pending', detail: result.error }, 502);
  }
  return jsonResponse(result.record);
}

// Cancels a vote before it's rolled — the officer's escape hatch after
// posting when they need to change the item list. Doesn't touch the
// already-posted Discord message(s); it just stops the vote from ever being
// finalized (the cron sweep only picks up status "pending", and finalizeVote
// treats "aborted" as a terminal, idempotent no-op) so the officer is free to
// post a fresh vote instead.
async function abortVoteEndpoint(voteId, env){
  const raw = await env.VOTES_KV.get(`vote:${voteId}`);
  if(!raw) return jsonResponse({ error: 'Vote not found' }, 404);

  const record = JSON.parse(raw);
  if(record.status === 'pending'){
    record.status = 'aborted';
    record.abortedAt = Date.now();
    await env.VOTES_KV.put(`vote:${voteId}`, JSON.stringify(record));
  }
  return jsonResponse(record);
}

export default {
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

    if(url.pathname === '/vote' && request.method === 'POST'){
      return postVote(request, env);
    }

    if(url.pathname === '/config' && request.method === 'GET'){
      return jsonResponse({ historyWebhookConfigured: !!env.HISTORY_WEBHOOK_URL });
    }

    if(url.pathname === '/roles' && request.method === 'GET'){
      try{
        const roles = await getGuildRoles(env);
        return jsonResponse({ roles });
      }catch(e){
        return jsonResponse({ error: 'Failed to fetch roles', detail: String(e) }, 502);
      }
    }

    if(url.pathname === '/vote/active' && request.method === 'GET'){
      return getActiveVoteEndpoint(env);
    }

    const voteMatch = url.pathname.match(/^\/vote\/([^/]+)(\/finalize|\/announce|\/abort|\/preview)?$/);
    if(voteMatch && request.method === 'GET' && !voteMatch[2]){
      return getVote(voteMatch[1], env);
    }
    if(voteMatch && request.method === 'GET' && voteMatch[2] === '/preview'){
      return previewVoteEndpoint(voteMatch[1], env);
    }
    if(voteMatch && request.method === 'POST' && voteMatch[2] === '/finalize'){
      return finalizeVoteEndpoint(voteMatch[1], env);
    }
    if(voteMatch && request.method === 'POST' && voteMatch[2] === '/announce'){
      return announceResults(voteMatch[1], request, env);
    }
    if(voteMatch && request.method === 'POST' && voteMatch[2] === '/abort'){
      return abortVoteEndpoint(voteMatch[1], env);
    }

    return jsonResponse({ error: 'Not found', path: url.pathname }, 404);
  },

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
};
