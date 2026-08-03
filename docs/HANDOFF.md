# Session Handoff — Discord Vote-to-Roll Feature

Written 2026-08-03 at ~70% context, for continuing this work in a fresh session.

## What this is

`LootOps-Vote` (`https://github.com/D4ngrs/LootOps-Vote`, live at `https://d4ngrs.github.io/LootOps-Vote/`) is a fork of `LootOps` (`https://github.com/D4ngrs/LootOps`, untouched, stays manual-entry-only). It adds a Discord vote-to-roll workflow: post an item list to Discord, people react to claim interest, then the results get rolled automatically. Full design spec: `LootOps/docs/superpowers/specs/2026-08-03-discord-vote-roll-design.md` (read this first for the "why").

## Status: functionally complete and verified end-to-end

All 5 planned stages are done except the printable results page:

1. **Repo fork** — done. Plan: `LootOps-Vote/docs/superpowers/plans/2026-08-03-lootops-vote-repo-fork.md`.
2. **History-log webhook** — done (later partly superseded, see below). Plan: `.../2026-08-03-roll-history-log-webhook.md`.
3. **Cloudflare Worker backend** — done. Plan: `.../2026-08-03-cloudflare-worker-backend.md`. Source: `LootOps-Vote/worker/src/index.js`, deployed at `https://lootops-vote-worker.lootopsd4.workers.dev`.
4. **Frontend integration** — done. Plan: `.../2026-08-03-frontend-vote-integration.md`. All in `LootOps-Vote/index.html`.
5. **Printable A4 results page — NOT STARTED.** This is the only remaining planned piece. No plan doc exists for it yet.

All plan docs have their checkboxes marked complete and include "added during execution" notes for things that changed after the plan was written — read those notes, they matter (several real bugs were found and fixed via live testing against a real Discord test server).

## Architecture as it actually ended up (important — diverged from the original plan)

Partway through end-to-end testing, we discovered the original design (primary Discord webhook + manual Roll button + Undo Roll) was redundant/dead once names could only come from votes. This was fixed live, **not** captured in the original spec's "Consuming results" section in detail — if you touch this area, trust the code over the spec's earlier wording:

- **No manual Roll button.** Removed entirely — rolling only ever happens via `consumeVoteResults()` in `index.html`, triggered by vote results coming back ready.
- **No Undo Roll.** Removed entirely (button, modal, `postUndoToDiscord`, `LAST_UNDONE_KEY`, everything). Reasoning: its original use cases (wrong/missing name, wrong/missing item) don't apply anymore — names come only from real reactions, and item mistakes happen before a vote posts, not after rolling.
- **No primary "Discord webhook" setting.** Removed entirely. Replaced by the **bot posting results directly** into the same channel the vote was posted in, via a new Worker endpoint: `POST /vote/:id/announce`.
- **The Worker is the single source of truth for the results embed.** `announceResults()` in `worker/src/index.js` builds `[mainEmbed, resultsEmbed]` once, posts them via the bot to the main channel, and — if the frontend passes `historyWebhookUrl` in the request body — posts the *exact same* embeds to that webhook too. The frontend no longer builds its own copy of this content (the old `buildRollEmbeds`/`formatWonItemText`/`postRollToHistoryLog` functions were deleted from `index.html`).
- **History Log webhook still exists as a setting** (`index.html` settings modal, `rollcall_vote_history_webhook_v1` in localStorage) — it's just now only a *destination URL* passed to the Worker, not something the frontend posts to directly.

## A subtle bug worth knowing about if you touch item quality/SCU formatting

`record.items[].quality` and `.scu` (stored in Worker KV, originally posted by `buildVoteItemsPayload()` in `index.html`) are **raw values** (e.g. `500`, `1`), not pre-formatted strings. This was a real bug fixed in the last commit (`6dfd8fd`): earlier code sent pre-formatted `"Q500"`/`"1 SCU"` strings, which caused double-formatting ("QQ500", "1 SCU SCU") wherever that data was later formatted again (both in the Worker's Discord embeds and in the frontend's on-screen result cards, which have *always* expected raw numbers via `formatWonItemHtml`). If you add new code that touches `quality`/`scu`, keep them raw until the final display layer, and format ("Q" prefix, " SCU" suffix) exactly once, right before rendering.

Item display quantity convention (also just settled, after several rounds of back-and-forth with the user): quantity is a **prefix**, e.g. `2× Gold`, shown even at `1×` — not a trailing `x2` suffix. This lives in `formatItemSummary()` in `worker/src/index.js`.

## Test environment (all real, currently pointed at a personal test server, not the org's real server yet)

- Discord bot: registered, invited to a personal test Discord server (not the real org server — user hasn't gotten owner approval yet). Switching servers later is just: invite the bot to the new server via the same OAuth2 URL, get the new channel ID, update `DISCORD_CHANNEL_ID` in `worker/wrangler.toml`, `wrangler deploy`. Guild ID auto-derives from the channel, no separate config needed.
- Cloudflare Worker deployed at `https://lootops-vote-worker.lootopsd4.workers.dev`. Secrets (`DISCORD_BOT_TOKEN`, `SHARED_AUTH_SECRET`) are set via `wrangler secret put` — **not** in any file. The shared secret's plaintext value lives locally (only) in `worker/.shared_secret_tmp` (gitignored) — read it from there if you need to run manual `curl`/`node` test scripts against the Worker; don't ask the user to retype it.
- `LootOps-Vote` settings (Worker URL, shared secret, history webhook URL) are stored in the browser's `localStorage` per-origin — they do **not** carry over between `d4ngrs.github.io/LootOps-Vote/` (the real site) and any `localhost` test server. Re-enter them each time you spin up a local server for testing (see any recent commit message or the plan docs for the exact values used, or ask the user).
- Login: no real password known — bypass via `localStorage.setItem('lootops_vote_auth_v1', String(Date.now()))` then reload (documented as intentional in the app's own code comments: this auth is "a casual deterrent, not real security").

## Known workflow gotchas hit this session (don't rediscover these)

- **GitHub Pages build lag**: after pushing to `LootOps-Vote`, the live site can take a minute+ to reflect the new commit; `gh api repos/D4ngrs/LootOps-Vote/pages/builds/latest --jq '.commit'` to check, and `gh api repos/D4ngrs/LootOps-Vote/pages/builds -X POST` to force a rebuild if it seems stuck.
- **Cloudflare Worker edge propagation lag**: similarly, right after `wrangler deploy`, a test hitting the Worker can occasionally still get the previous version for up to ~30-60s. If a fix "doesn't seem to have applied," wait and retry before assuming the code is wrong.
- **`curl` via Git Bash on this machine fails TLS to `*.workers.dev`** (schannel error) — use `node -e "fetch(...)"` instead for testing the Worker; `curl` works fine for GitHub Pages/other hosts.
- Discord reaction-add is rate-limited hard when done back-to-back — the Worker already retries on `429` using `Retry-After` (see `addReaction()`), don't remove that.
- If the Discord bot can't see the channel (403 on any endpoint), it's almost always a **channel-specific permission overwrite** issue (common in servers where channels are hidden-by-default) — the bot's role needs an explicit allow overwrite on that channel, not just base role permissions. Also: Discord won't let a user edit a role positioned above their own highest role in the hierarchy, even with Administrator — true server owner (crown icon) bypasses this, a custom "Owner"-named role does not.

## Next step

Printable A4 results page (stage 5 from the original roadmap) — reuses the app's existing dark visual theme as-is (not a stripped light print stylesheet, since it's meant to be saved as PDF via the browser's print dialog, never physically printed), per earlier discussion with the user. No plan written yet — brainstorm/plan this fresh when picked back up.

## Style/working notes for this user

- Wants terse, no fluff. Confirms fixes by checking the live Discord messages themselves (screenshots) rather than trusting descriptions — expect to be asked to verify claims.
- Prefers inline execution over subagent-driven for plans this size (single shared file, sequential dependencies) — re-asked and re-confirmed this reasoning twice already, don't re-litigate unless the plan shape changes materially (e.g. a much bigger, more parallel plan).
- Catches real bugs by testing thoroughly and comparing actual Discord output against expectations — take "still wrong" feedback seriously and verify against real output, not just code review.
- Direct commits to `main` on both repos throughout this project — no PR/branch workflow has been used or requested.
