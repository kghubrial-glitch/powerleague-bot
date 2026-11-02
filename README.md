# powerleague-bot

A Discord bot for organizing **Brawl Stars 3v3 scrims** (bs-nb), inspired by the
original Power League format. Players queue up, the bot drafts two Elo-balanced
teams, drops them into a private channel with a TeamCode and ready check, and
after the series the players vote on the result. Confirmed results update Elo,
profiles, streaks and the leaderboard.

> This is a coordination bot only. It never connects to, controls, or modifies
> the Brawl Stars client.

---

## Features

- **Persistent matchmaking panel** — permanent embed with Join/Leave/Refresh
  buttons. Queue state lives in SQLite and survives restarts.
- **Elo-balanced random teams** — evaluates all 10 unique 3v3 splits, keeps the
  balanced ones (configurable tolerance), draws one at random, and randomly
  assigns Team A / Team B.
- **Player profiles & Elo** — starting Elo 1000, team-based Elo with
  K=40 for the first 10 matches and K=24 after, peak tracking, win/loss/draw
  totals, signed streaks, configurable rank tiers.
- **Map pool** — the 14 classic Power League maps seeded by default. Admins can
  add/remove/toggle maps and set optional game modes. Selection avoids recently
  used maps when alternatives exist.
- **Private match channels** — only the six players, staff, and the bot can view
  the match channel. Initial message shows teams, map, and format.
- **TeamCode flow** — any participant submits the in-game TeamCode through a
  modal; the first valid submission is locked in, staff can reset it.
- **Readiness check** — each player presses READY after joining; once all six
  are ready the match starts and the series deadline begins.
- **Result voting** — a participant proposes the winner; the six players vote
  privately. A result needs **4 of 6** matching votes **including at least one
  vote from each team**. Unresolved votes are marked disputed for staff.
- **Timeouts & cancellation** — teamcode, readiness, match, voting and fault
  reporting all have persisted deadlines that survive a bot restart.
- **Fault & dodge reporting** — cancelled/timed-out matches let participants
  report what happened. Dodge accusations need cross-team quorum to be
  escalated, and only moderators decide on cooldowns (no auto-punishment).
- **Match history & leaderboard** — paginated history per player, default
  competitive leaderboard filter by minimum matches (configurable).
- **Audit log** — every admin action is recorded.

---

## Architecture

```
src/
  index.ts           bot client, command registration, dependency wiring
  commands/          player + admin slash commands
  interactions/      buttons, modals, select menus
  matchmaking/       queueManager, teamBalancer, mapSelector
  matches/           matchManager, resultVoting
  elo/               eloCalculator, rankManager
  database/          SQLite connection, schema, repositories
  services/          timerManager (persisted deadlines), mutex, auditLogger
  config/            environment settings
  format.ts          shared embeds / action rows
```

- **Queue → match flow** is serialized by a database transaction that claims
  the six players atomically, so no two matchmaking runs process the same group.
- **Deadlines** are rows in `match_deadlines`; on boot `recoverAll()` re-arms
  them and the sweep fires anything overdue. A restart mid-countdown continues
  the remaining time.
- **Elo is applied exactly once** — `applyConfirmedResult` is guarded by an
  in-process idempotency set plus a status guard against cancelled/timed-out
  matches.

---

## Requirements

- Node.js >= 20
- A Discord application with a bot token (see Discord Developer Portal)
  - Required intents: **Guilds** and **Guild Messages**.

## Setup

```bash
npm install
cp .env.example .env
# fill in DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID,
# QUEUE_CHANNEL_ID, STAFF_ROLE_ID (see Config below)

npm run build
npm start        # or: npm run dev
```

The first run registers all slash commands for the configured guild and
creates the SQLite database file (`./data/scrims.db`).

### Create the panel

1. Create a public channel for the queue.
2. Run `/scrim setup` **in that channel**. A permanent matchmaking panel is
   posted and tracked; the `REFRESH` button and bot restarts keep it in sync.

---

## Configuration (`.env`)

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | — | Bot token (required). |
| `DISCORD_APPLICATION_ID` | — | Application ID (required). |
| `DISCORD_GUILD_ID` | — | Guild ID (required). |
| `QUEUE_CHANNEL_ID` | — | Channel for the panel / staff pings. |
| `STAFF_ROLE_ID` | — | Role allowed to use admin commands. |
| `DATABASE_PATH` | `./data/scrims.db` | SQLite file location. |
| `QUEUE_SIZE` | `6` | Players needed to start a match. |
| `MIN_ELO` / `MAX_ELO` | unset | Optional queue Elo range. |
| `TEAM_BALANCE_TOLERANCE` | `40` | Max average-Elo gap vs. the best split still considered. |
| `MATCH_FORMAT` | `best_of_3` | `best_of_3` or `best_of_1`. |
| `MAP_ROTATION_MODE` | `unique` | `unique` avoids recently used maps, `random` is fully random. |
| `TIMER_TEAMCODE` | `300` | Seconds to submit a TeamCode, else the match is cancelled. |
| `TIMER_READY` | `300` | Seconds for readiness after the TeamCode is posted. |
| `TIMER_MATCH` | `900` | Seconds to finish the series after all are ready. |
| `TIMER_VOTE` | `900` | Seconds for result voting, else disputed. |
| `TIMER_FAULT_REPORT` | `300` | Seconds fault reporting stays open. |
| `RANK_BRONZE`…`RANK_LEGENDARY` | 1000…1800 | Elo thresholds. |
| `LEADERBOARD_MIN_MATCHES` | `0` | Minimum matches to appear on the leaderboard. |

---

## Commands

### Player commands

| Command | Description |
| --- | --- |
| `/profile [player]` | Show a player’s profile (Elo, rank, streaks, record). |
| `/leaderboard` | Top players by Elo, with pagination buttons. |
| `/history [player]` | Paginated match history. |
| `/queue` | Show the live queue panel. |
| `/maps` | Show the map pool and recent map usage. |
| `/match` | Show your current match channel. |
| `/leave` | Leave the queue. |

### Admin commands (`/scrim …`)

| Command | Description |
| --- | --- |
| `/scrim setup` | Create/replace the matchmaking panel in the current channel. |
| `/scrim cancel <match_id> [reason]` | Cancel a match. |
| `/scrim result <match_id> <winner> [score_a] [score_b]` | Confirm/correct a result (applies Elo once). |
| `/scrim elo <player> <amount>` | Direct Elo adjustment (logged). |
| `/scrim map add/remove/toggle/gamemode` | Manage the map pool. |
| `/scrim cooldown <player> <minutes> [reason]` | Apply a matchmaking cooldown. |
| `/scrim resetcode <match_id>` | Reset a TeamCode for re-submission. |
| `/scrim dodge <match_id> <player> <cooldown\|clear> [minutes]` | Moderator decision on a dodge report. |
| `/scrim stats` | Server-wide statistics. |
| `/scrim audit [limit]` | Recent audit log entries. |

All admin commands require the configured `STAFF_ROLE_ID` or
`Administrator` permission.

---

## How a scrim works end to end

1. Six players press **JOIN QUEUE**.
2. The bot locks the queue and drafts two Elo-balanced teams.
3. A private channel `scrim-0042` is created with the map and format.
4. Anyone submits the in-game **TeamCode** (modal) — locked after first accept.
5. Everyone presses **READY** once they join the in-game team.
6. The series starts; the winner is proposed via **MATCH FINISHED**.
7. The six players vote privately. 4 matching votes across both teams confirm.
8. Confirmed results update Elo exactly once and stats/leaderboard refresh.

If a step times out, the bot cancels the match, keeps Elo untouched, and opens
fault reporting so moderators can review.

---

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run build         # tsc
npm test              # vitest run
```

Unit tests cover the team balancer, Elo math, result-vote evaluation, map
selection, repositories/persistence, and timer recovery.

---

## Roadmap (Power League extras)

- Brawler ban/pick phase with team captains
- Map-specific win rates, head-to-head statistics
- Automatic captain nomination (highest Elo / most matches)

These are intentionally optional and out of the way of the core scrim flow.

## License

Private project.
