# Officer Authentication via Discord OAuth — Design

## Problem

The Worker (`lootops-vote-worker`) currently authorizes every action (`POST /vote`, `POST /vote/:id/announce`, `POST /vote/:id/finalize`, `GET /roles`) with one static `SHARED_AUTH_SECRET`, pasted into the app's settings and stored in `localStorage`. Two things are wrong with that for real org use:

1. It's one value shared by everyone who's allowed to run the tool — there's no way to tell officers apart, and no way to revoke just one person.
2. It's a permanent bearer secret sitting in a browser's `localStorage`. If it ever leaks — a screenshot, a support message, a synced browser profile — anyone who has it can act as an officer indefinitely, including basic members it was never meant for. That's the scenario we're specifically trying to close off, even though officers themselves are trusted.

The Discord bot token itself is **not** part of this problem — it already lives only in Cloudflare Worker secrets and is never sent to the browser. This design doesn't touch that; it's about replacing the second, weaker credential.

## Goals

- Each officer authenticates as *themselves*, not as a shared secret.
- No long-lived static credential exists anywhere that, if leaked, grants standing access.
- Access is tied to a live Discord role check — removing someone's Officer role in Discord revokes their access automatically, no key rotation needed.
- No password, credential, or Discord login form is ever handled by our own code — auth happens entirely on Discord's real login page via standard OAuth2.

## Non-goals

- This does not add per-officer audit logging beyond what's already logged (out of scope, can be a later addition).
- This does not change who can *react to vote messages* in Discord — that's unrestricted today and stays that way; this only gates who can post votes / trigger rolls / announce results through the app.

## Design

### Flow

1. Officer opens the app, clicks **"Log in with Discord"**.
2. App redirects to `GET {WORKER_URL}/auth/login?returnTo={app URL}`.
3. Worker redirects to Discord's real OAuth authorize page (`discord.com/oauth2/authorize`) requesting scopes `identify` and `guilds.members.read` only — no scope that can post messages, read DMs, or act as the user. The `state` param is a self-encoded, HMAC-signed blob containing `returnTo` + a timestamp, so the Worker needs no server-side session storage for the OAuth handshake and can reject stale/tampered redirects.
4. Officer logs in / approves on Discord's own domain. Discord redirects back to `GET {WORKER_URL}/auth/callback?code=...&state=...`.
5. Worker verifies `state`, exchanges `code` for a Discord access token (server-to-server, using `DISCORD_CLIENT_SECRET`), then calls Discord's API **live**: `GET /users/@me/guilds/{guildId}/member` with that access token to fetch the officer's current roles.
6. If `OFFICER_ROLE_ID` is not in that list, the Worker redirects back to the app with an error and no session is issued — access denied.
7. If it is present, the Worker mints its own **short-lived signed session token** (HMAC-SHA256, ~8 hour expiry, payload = `{sub: discordUserId, username, exp}`) and redirects to `returnTo` with the token in the URL fragment (`#session=...`) — fragments aren't sent to servers or logged, so it never touches server logs on the way back.
8. The app reads the token from the URL fragment on load, stores it in `localStorage`, strips the fragment from the URL, and shows "Logged in as {username}".
9. Every subsequent Worker call (`POST /vote`, etc.) sends `Authorization: Bearer {session token}` instead of the old `X-LootOps-Auth` header. The Worker verifies the HMAC signature and expiry on every request — no database lookup needed, no Discord API call needed per request (that would be slow and rate-limit-risky); the live role check only happens once, at login time, and the short expiry bounds how stale that check can get.
10. On session expiry (or a 401 from any Worker call), the app clears the stored session and shows the login button again. Re-authenticating is one click.

### What replaces what

| Old | New |
|---|---|
| `SHARED_AUTH_SECRET` (one static value, everyone) | Per-officer session token, minted after live Discord role verification |
| `X-LootOps-Auth: <secret>` header | `Authorization: Bearer <session token>` header |
| Settings modal: paste-a-secret field | Settings modal: "Log in with Discord" / "Logged in as X, Log out" |
| No way to tell officers apart | `sub`/`username` in the verified token identify who took each action |

### New Worker config

- **Secrets** (`wrangler secret put`, never in a file): `DISCORD_CLIENT_SECRET` (from Discord Developer Portal → OAuth2), `SESSION_SIGNING_SECRET` (new random value, only this Worker needs it, used to sign/verify session tokens).
- **Vars** (`wrangler.toml`, not secret — public identifiers, not credentials): `DISCORD_CLIENT_ID`, `OFFICER_ROLE_ID` (the Discord role ID that gates access), `ALLOWED_RETURN_ORIGINS` (allowlist of app origins the `returnTo` redirect is permitted to target, to prevent this becoming an open redirect — e.g. `https://d4ngrs.github.io`).
- Existing `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are unaffected.

### New Worker endpoints

- `GET /auth/login` — starts the OAuth redirect (step 2-3 above).
- `GET /auth/callback` — Discord redirects here; performs the token exchange + role check + session mint (steps 4-7).

### Frontend changes (`index.html`)

- Settings modal's "Discord Vote Worker" section: replace the shared-secret input with a Discord-login button + logged-in-as state.
- `workerFetch()`: send `Authorization: Bearer` using the stored session token instead of the shared-secret header; on `401`, clear the stored session and prompt re-login instead of failing silently.
- New localStorage key `rollcall_vote_session_v1` replaces `rollcall_vote_worker_secret_v1`.
- On load: check `location.hash` for `#session=...`, persist it, strip the hash via `history.replaceState`.

### Manual setup steps (for the user, not automatable)

1. Discord Developer Portal → the existing bot's application → OAuth2 tab: note the **Client ID**, generate/copy the **Client Secret**, add a **Redirect URI** pointing at `{WORKER_URL}/auth/callback`.
2. Get the **Officer role's ID** from the test server (right-click role → Copy Role ID, with Developer Mode on).
3. `wrangler secret put DISCORD_CLIENT_SECRET` and `wrangler secret put SESSION_SIGNING_SECRET` (a random string the user generates themselves — Claude will not generate or see this one directly typed into chat, same rule as the bot token).
4. Add `DISCORD_CLIENT_ID`, `OFFICER_ROLE_ID`, `ALLOWED_RETURN_ORIGINS` to `wrangler.toml` `[vars]`, `wrangler deploy`.

### Migration / cleanup

- `SHARED_AUTH_SECRET` secret, `isAuthorized()`'s header check, and all `X-LootOps-Auth` usage are removed from the Worker and replaced by session-token verification.
- `worker/.shared_secret_tmp` and its usage in test scripts go away; new local test scripts use a real session token obtained by actually logging in (or, for automated testing without a browser, a Worker debug-only endpoint is explicitly out of scope — manual login-based testing is sufficient given this is a low-traffic internal tool).
- Frontend's `loadWorkerSecret`/`saveWorkerSecret` are replaced by session-token load/save/clear helpers.

## Open question resolved during brainstorming

Discord OAuth was initially a concern because "Login with Discord" flows are associated with credential-phishing tools. Resolved: real OAuth2 never touches the user's Discord password (login happens on discord.com itself), and this design requests only `identify` + `guilds.members.read` — it cannot post as the user, read their DMs, or take any action on their behalf. The remaining goal — no leaked credential should open access to non-officers — is what actually drove the design toward OAuth: unlike a shared or per-officer static secret, there's no standing credential to leak; each login is a live, short-lived proof of current Discord role membership.
