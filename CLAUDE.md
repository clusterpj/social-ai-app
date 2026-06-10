# Social Command Center — Standing Instructions

Telegram bot → AI copy + image generation → Zernio multi-platform publishing.
Stack: Bun + grammY + TypeScript, bun:sqlite, Claude Haiku (copy), Flux via fal.ai (images), Zernio (publishing), single Ubuntu droplet behind Caddy.

Read PLAN.md for the full build plan, phases, and acceptance criteria.

## Rules (apply to every change)

- Fetch and follow current docs at docs.zernio.com, grammy.dev, fal.ai/docs, docs.claude.com before writing each integration — do NOT invent endpoint shapes.
- All publishing goes through the `PublishAdapter` interface (`src/services/publisher/types.ts`). No Zernio types outside `src/services/publisher/`.
- TypeScript strict mode. No `any`. Zod for all external input (env, webhooks, API responses).
- Every external call wrapped with timeout + 1 retry (except publish, which retries via user-facing button only).
- Never log tokens or full API keys.

## Commands

- `bun install` — install deps
- `bun run typecheck` — `tsc --noEmit`, must pass before any phase is done
- `bun run dev` — local server with watch
- `bun run set-webhook` — register the Telegram webhook (needs .env)

## Conventions

- Structured JSON logging via `src/log.ts` only — no bare `console.log`.
- DB access via the typed helpers in `src/db.ts`; migrations are numbered SQL strings against `PRAGMA user_version`.
- Telegram callback_data format: `pfx:<nanoid10>` (`pub` | `rgi` | `rgc` | `twk` | `cxl`), stays under the 64-byte limit.
- User-facing copy mirrors the user's language (ES/EN).
