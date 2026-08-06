# Sandbox Mode — Design Spec

Date: 2026-08-06

## Purpose

Let the tool's full UI and vote/roll lifecycle be exercised end-to-end without touching the real Discord server and without spending Cloudflare Worker requests. Today, testing the voting flow means posting a real message to Discord, waiting on real reactions (or asking someone to react), and burning Worker/Discord API calls in the process. Sandbox Mode replaces the parts of that flow that talk to Discord with local, in-browser equivalents, while leaving everything else in the tool - the Vote Status panel, the roll logic, results rendering, roll history, Share, Loot Sheet, the "Reimport unclaimed items" feature - completely unmodified.

**Explicit non-goal:** Sandbox Mode does not change tool functionality in any way other than (a) never contacting the Worker/Discord, and (b) sourcing "who reacted to what" from a fake-reactions editor instead of real Discord reactions.

## 1. Toggle & visual indicator

A button in the Discord Settings modal (`#settingsOverlay`), placed above the existing "Discord Vote Worker" section:

- Off: "Enter Sandbox Mode" (`ghost-btn` styling), with a one-line hint explaining what it does.
- On: "Leave Sandbox Mode" (`ghost-btn danger` styling).
- If a real vote is currently pending when "Enter Sandbox Mode" is clicked, show a confirm dialog first: **"A live vote is still running and won't be affected. Enter Sandbox Mode anyway?"** (the real vote is untouched either way - the Worker's own hourly cron still finalizes it on schedule regardless of what the frontend is showing; this confirm only exists so you don't lose track of it).

State persists in `localStorage` under `rollcall_sandbox_mode_v1` (boolean).

**Indicator, always visible while active:**
- A thick colored border frame around the full viewport (`position: fixed`, `pointer-events: none`, high `z-index`, so it never blocks clicks) in a color not otherwise used in the app's palette (avoiding confusion with `--gold`/`--violet`/`--bad`).
- A small persistent corner badge reading "SANDBOX MODE", fixed-position, always on top, non-interactive.

## 2. Parallel storage namespace

Every piece of local state the app persists gets a Sandbox-scoped counterpart, selected via key-resolver functions that check `rollcall_sandbox_mode_v1`:

| Purpose | Live key | Sandbox key |
|---|---|---|
| Roll history | `rollcall_vote_history_v1` | `rollcall_vote_test_history_v1` |
| Pending-vote pointer | `rollcall_vote_pending_v1` | `rollcall_vote_test_pending_v1` |
| Full vote record (new) | *(lives server-side in Worker KV)* | `rollcall_vote_test_record_v1` |

`loadHistory`/`saveHistory` and `loadPendingVote`/`savePendingVote`/`clearPendingVote` route through these resolvers instead of hardcoded keys. This is the key architectural move: it means the **History modal, results card, Share modal, and "Reimport unclaimed items" button all keep working completely unmodified** - they just transparently read/write Sandbox-scoped storage when Sandbox Mode is on. Turning Sandbox Mode off instantly reverts the whole app to live data with no migration step, since the two never mix.

`rollcall_vote_test_record_v1` holds the local stand-in for what the Worker's KV would normally hold: `{ id, items, title, roleId, flavorText, createdAt, deadline, status, results, finalizedAt }`.

## 3. Vote flow rewiring

Each of the five Worker touchpoints in the vote lifecycle gets a local Sandbox equivalent, chosen at the call site:

| Real (Worker) | Sandbox equivalent |
|---|---|
| `POST /vote` | Build the fake record locally (same deadline math: `Date.now() + hours*3600000`), status `pending`, `results: null`. Save to the sandbox record/pointer keys. Opens **Window 1**. |
| `GET /vote/:id/preview` (Check Status) | Read the fake record's current reaction counts, report totals into the Names panel - same UX as live. |
| `POST /vote/:id/finalize` (Start Rolling Now) | Compute `results` from the reaction counts set at that moment (same direct-assign / roll-group / unclaimed split `consumeVoteResults` already does), mark record `ready`. Opens **Window 2**, then proceeds through the same render/log-to-history path `consumeVoteResults` already uses. |
| `POST /vote/:id/abort` | Mark record `aborted` locally, clear the sandbox pending pointer, close Window 1 if open. |
| `POST /vote/:id/announce` | Skipped entirely - Window 2 *is* the "what would've been announced" preview, so there's nothing left to send. |

The normal Vote Status panel (live countdown, Check Status/Start Rolling Now/Abort buttons) is otherwise untouched - it calls these local functions instead of `workerFetch` when Sandbox Mode is on.

**Mode coexistence:** because storage is fully separate, a real pending vote and a sandbox pending vote can exist at the same time without conflicting. The Vote Status panel only ever reflects whichever mode is currently active; switching modes swaps which one it shows.

## 4. Shared floating-panel component

Windows 1 and 2 are both instances of one new, reusable UI component: a **non-modal floating panel**. "Non-modal" here specifically means: no backdrop, doesn't block interaction with the rest of the page (unlike the existing `.modal-overlay`/`.modal-panel` pattern used elsewhere in the app, e.g. Discord Settings or History, which do block). It's still rendered on the same page - not a separate browser window.

- Visually styled like the existing `.modal-panel` (same panel background, border, typography), but:
  - No backdrop/overlay.
  - Draggable by its header (pointer events: down on header starts drag, move translates the panel, up ends it).
  - Fixed positioning, high `z-index`, so it always renders on top of the rest of the page.
  - Small-to-medium drop shadow offset toward the bottom-right, for depth.
  - A close button in the header.
- Default position on open: a fixed sensible default (e.g. right side of viewport); dragging is not persisted across reopens/reloads - each open starts from the default position.

## 5. Window 1 — fake vote / reactions editor

Opens automatically when a vote is posted in Sandbox Mode. Reopenable via a button placed next to Check Status/Start Rolling Now/Abort in the Vote Status panel, for as long as the sandbox vote is pending. Does **not** auto-reopen on page load even if a sandbox vote is still pending - only the reopen button brings it back.

Contents:
1. The literal "would-post" vote message text: a Sandbox-local port of the Worker's `formatBatchContent` (title, "Voting closes ..." line using the real deadline, flavor text, "React to claim interest:", item list). Deliberately scoped down from the Worker's version - skips exact Discord emoji assignment and the 20-reactions-per-message batching (`(part X/Y)` splitting), since those exist only to satisfy Discord's own reaction cap and aren't meaningful to replicate in a preview. Items are shown with a plain running number instead of a Discord emoji.
2. Below that, one row per item with a number input, "fake reaction count" (default 0, capped at 10 - the pool size, since reactors within a single item must be distinct people). Changing a count re-rolls that item's fake voter names by drawing that many distinct names at random from the shared pool of 10 fixed names (`Test Alpha`, `Test Bravo`, `Test Charlie`, `Test Delta`, `Test Echo`, `Test Foxtrot`, `Test Golf`, `Test Hotel`, `Test India`, `Test Juliett`). Because all items draw from the same pool, the same fake name can end up claiming multiple items, letting the grouped-by-person results view be tested realistically.

## 6. Window 2 — results preview

Opens automatically when "Start Rolling Now" completes in Sandbox Mode. One-time popup: closable, not reopenable afterward (the real results card and Sandbox-scoped roll history already preserve the outcome).

Contents: a Sandbox-local port of the Worker's `announceResults` two-embed content, rendered as styled blocks approximating Discord's embed look (colored left border matching the real embed colors - `--gold` for the main embed, `--violet` for the results embed):
- Main block: date/time, participants, roll mode (spread evenly / cap at one), loot pool.
- Results block: per-person results (grouped/qty-formatted the same way the real embed and the on-screen results card already do), plus an "Unclaimed Items" line when applicable.

## Out of scope

- Automatic periodic "Check Status" polling (considered and explicitly rejected - not needed for Sandbox Mode, and risky for live mode due to Discord API rate limits, not Cloudflare cost).
- A visible/browsable UI specifically for Sandbox history beyond what the existing History modal already provides once pointed at the sandbox storage keys (section 2 already covers this - no separate history UI needs to be built).
- Persisting floating-panel drag position across reopens or reloads.
