# AGENTS.md

## Project

`powerleague-bot` — Discord bot (Brawl Stars 3v3 scrims) written in
TypeScript + discord.js + better-sqlite3.

## Commands

- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `tsc` (out to `dist/`)
- `npm test` — `vitest run` (unit tests under `tests/unit/`)
- `npm run dev` — `tsx src/index.ts`

## Conventions

- **Strict TypeScript**, CommonJS modules, `rootDir: src`, `outDir: dist`.
- Database schema lives in `src/database/connection.ts` (`migrate()`).
  Default maps are seeded by `initDatabase` → `maps.ensureDefaults()`, so tests
  that construct `Repositories` directly must call `ensureDefaults()` too.
- All mutating DB work goes through `Repositories.transaction<T>(fn)` (the
  wrapper returns the result; do **not** invoke it with trailing `()`).
- Match state machine statuses: `awaiting_teamcode` → `awaiting_ready` →
  `in_progress` → `voting` → `confirmed` | `disputed` | `cancelled` | `timed_out`
  (`archived` exists for cleanup).
- Elo must be applied **exactly once** — `MatchManager.applyConfirmedResult`
  guards via `this.applyingElo` set + status checks.
- Deadlines are persisted (`match_deadlines`); `TimerManager.recoverAll()` is
  called on boot.
- Slash command definitions return `ReturnType<SlashCommandBuilder['toJSON']>[]`
  via `registerCommandDefinitions()` / `registerAdminCommandDefinitions()`.
- Button/menu/modal custom-id routing:
  `queue:*`, `match:*`, `vote:*`, `fault:*`, `lb:prev|next`, `faultreason:*`,
  `faulttarget:*`, `modal:teamcode:*`, `modal:cancel:*`.
- Never commit `.env`, `data/`, `dist/`, `node_modules/`.

## Tests

- Run `npx vitest run` to execute all test files.
- New pure logic should get tests in `tests/unit/` mirroring `src/` layout.