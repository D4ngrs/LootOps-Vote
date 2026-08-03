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
// voting is already over by then). Quality/SCU/info are supplied by the
// frontend (already deduped there, e.g. via buildDetailLabel) and are only
// included when present — never shown as empty/placeholder segments.
function formatItemSummary(it){
  const namePart = `**${it.name}**` + (it.info ? ` _(${it.info})_` : '');
  const segments = [namePart];
  if(it.quality) segments.push(it.quality);
  if(it.scu) segments.push(it.scu);
  segments.push(`x${it.qty}`);
  return segments.join('  |  ');
}
function formatItemLine(it){
  return it.emoji + '  |  ' + formatItemSummary(it);
}

function formatBatchContent(batch, meta, batchIndex, totalBatches){
  const { title, when, flavorText, roleId } = meta;
  const lines = [];
  if(roleId && batchIndex === 0){
    // Spoilered so the raw mention text is hidden until clicked, but the
    // role still receives a real ping/notification.
    lines.push(`||<@&${roleId}>||`);
  }
  const titleLine = `**${title || 'LootOps Vote'}**` + (when ? ` — ${when}` : '');
  lines.push(totalBatches > 1 ? `${titleLine} (part ${batchIndex + 1}/${totalBatches})` : titleLine);
  if(flavorText && batchIndex === 0){
    lines.push(`_${flavorText}_`);
  }
  lines.push('React to claim interest:');
  lines.push(...batch.map(formatItemLine));
  return lines.join('\n');
}

async function postVote(request, env){
  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { items, title, deadlineDays, roleId, when, flavorText } = body;
  if(!Array.isArray(items) || items.length === 0){
    return jsonResponse({ error: 'items must be a non-empty array' }, 400);
  }

  const batches = buildMessageBatches(items);
  const messageIds = [];
  const emojiMap = [];
  const meta = { title, when, flavorText, roleId };

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
  const { names, buckets, leftover, when, spreadEven, capOne } = body;
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
      { name: 'Date & Time', value: when || new Date().toISOString(), inline: false },
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

  record.announced = true;
  await env.VOTES_KV.put(`vote:${voteId}`, JSON.stringify(record));
  return jsonResponse({ announced: true });
}

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

export default {
  async fetch(request, env, ctx){
    if(request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if(!isAuthorized(request, env)){
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    if(url.pathname === '/vote' && request.method === 'POST'){
      return postVote(request, env);
    }

    if(url.pathname === '/roles' && request.method === 'GET'){
      try{
        const roles = await getGuildRoles(env);
        return jsonResponse({ roles });
      }catch(e){
        return jsonResponse({ error: 'Failed to fetch roles', detail: String(e) }, 502);
      }
    }

    const voteMatch = url.pathname.match(/^\/vote\/([^/]+)(\/finalize|\/announce)?$/);
    if(voteMatch && request.method === 'GET' && !voteMatch[2]){
      return getVote(voteMatch[1], env);
    }
    if(voteMatch && request.method === 'POST' && voteMatch[2] === '/finalize'){
      return finalizeVoteEndpoint(voteMatch[1], env);
    }
    if(voteMatch && request.method === 'POST' && voteMatch[2] === '/announce'){
      return announceResults(voteMatch[1], request, env);
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
