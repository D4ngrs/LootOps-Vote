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

// Layout: Emoji | Item name (info, italic) | Quality | SCU size | Quantity
// Quality/SCU/info are supplied by the frontend (already deduped there, e.g.
// via buildDetailLabel) and are only included in the line when present —
// never shown as empty/placeholder segments.
function formatItemLine(it){
  const namePart = `**${it.name}**` + (it.info ? ` _(${it.info})_` : '');
  const segments = [it.emoji, namePart];
  if(it.quality) segments.push(it.quality);
  if(it.scu) segments.push(it.scu);
  segments.push(`x${it.qty}`);
  return segments.join('  |  ');
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

    const voteMatch = url.pathname.match(/^\/vote\/([^/]+)(\/finalize)?$/);
    if(voteMatch && request.method === 'GET' && !voteMatch[2]){
      return getVote(voteMatch[1], env);
    }
    if(voteMatch && request.method === 'POST' && voteMatch[2]){
      return finalizeVoteEndpoint(voteMatch[1], env);
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
