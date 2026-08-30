# Social Command Center — Low-Level Build Plan

Telegram bot → AI copy + image generation → Zernio multi-platform publishing.
Stack: Bun + grammY + TypeScript, bun:sqlite, Claude Haiku (copy), Flux via fal.ai (images), Zernio (publishing), single Ubuntu droplet behind Caddy.

---

## 0. Division of Labor

### Pedro does (manual, ~2 hours total)
| # | Task | Output |
|---|------|--------|
| 1 | BotFather: `/newbot`, set name/username, `/setcommands` (post, dream, status, help) | `TELEGRAM_BOT_TOKEN` |
| 2 | DNS: A record `bot.<yourdomain>.com` → droplet IP | Webhook-able HTTPS domain |
| 3 | Droplet: install Bun, Caddy (`apt install caddy`), open 80/443 | Runtime ready |
| 4 | Zernio: sign up, generate API key, connect YOUR test IG + LinkedIn (free tier = 2 accounts), copy the account IDs from dashboard. If X is ever connected: set monthly spend cap in dashboard FIRST | `ZERNIO_API_KEY`, account IDs |
| 5 | Get Anthropic API key + fal.ai API key | `ANTHROPIC_API_KEY`, `FAL_KEY` |
| 6 | Get your Telegram chat_id (message @userinfobot, or run bot in dev and read the log) | `ALLOWED_CHAT_IDS` |
| 7 | **Validation gate (before any real build):** one manual `curl` post to Zernio with an image URL, confirm it lands on IG/LinkedIn. If flaky → fall back to Ayrshare trial, only `publisher/zernio.ts` changes | Go/no-go on Zernio |
| 8 | Client onboarding (post-sale): connect client's socials in Zernio dashboard, add their chat_id to allowlist, add account-ID mapping | New tenant live |

### Claude Code builds (everything else)
All code, schema, deployment files, and docs below — phase by phase, each phase ends with passing acceptance criteria.

**Standing instructions for Claude Code (put in CLAUDE.md):**
- Fetch and follow current docs at docs.zernio.com, grammy.dev, fal.ai/docs, docs.claude.com before writing each integration — do NOT invent endpoint shapes.
- All publishing goes through the `PublishAdapter` interface. No Zernio types outside `services/publisher/`.
- TypeScript strict mode. No `any`. Zod for all external input (env, webhooks, API responses).
- Every external call wrapped with timeout + 1 retry (except publish, which retries via user-facing button only).
- Never log tokens or full API keys.

---

## 1. Repo Structure

```
social-bot/
├── CLAUDE.md                  # standing instructions above
├── PLAN.md                    # this file
├── .env.example
├── package.json               # bun
├── tsconfig.json
├── Caddyfile
├── deploy/
│   ├── social-bot.service     # systemd unit
│   └── backup.sh              # nightly sqlite + media backup
├── data/                      # gitignored: app.db, media/
└── src/
    ├── index.ts               # Bun.serve: grammY webhookCallback + /media static + /health
    ├── config.ts              # zod-validated env
    ├── db.ts                  # bun:sqlite init, migrations, typed queries
    ├── bot.ts                 # grammY instance, middleware chain, handler registration
    ├── middleware/
    │   ├── allowlist.ts       # reject chat_id not in ALLOWED_CHAT_IDS
    │   └── errors.ts          # global error boundary → user-friendly message + log
    ├── commands/
    │   ├── post.ts            # Track A
    │   ├── dream.ts           # Track B
    │   ├── status.ts          # connected accounts + today's usage
    │   └── help.ts
    ├── callbacks.ts           # inline button router (pub|rgi|rgc|twk|cancel)
    ├── services/
    │   ├── copy.ts            # Haiku → per-platform copy JSON
    │   ├── image.ts           # fal.ai Flux text-to-image
    │   └── publisher/
    │       ├── types.ts       # PublishAdapter interface + shared types
    │       └── zernio.ts      # the ONLY file that knows Zernio exists
    ├── media.ts               # save/download images, public URL builder, cleanup
    └── limits.ts              # daily /dream cap per chat
```

---

## 2. Environment (.env.example)

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=        # random 64 hex chars; verified by grammY
ALLOWED_CHAT_IDS=               # comma-separated
PUBLIC_BASE_URL=https://bot.example.com
PORT=3000

ANTHROPIC_API_KEY=
COPY_MODEL=claude-haiku-4-5     # current cheap tier; update as models ship
FAL_KEY=
FLUX_MODEL=fal-ai/flux/dev      # or schnell for cheaper drafts

ZERNIO_API_KEY=
DAILY_DREAM_LIMIT=20
MEDIA_RETENTION_DAYS=14
```

---

## 3. Database Schema (bun:sqlite, WAL mode)

```sql
CREATE TABLE IF NOT EXISTS tenants (
  chat_id      INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  account_ids  TEXT NOT NULL,        -- JSON array of Zernio social-account IDs
  platforms    TEXT NOT NULL,        -- JSON array: ["instagram","linkedin",...]
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,     -- nanoid(10) → fits 64-byte callback_data
  chat_id      INTEGER NOT NULL,
  kind         TEXT NOT NULL,        -- 'post' | 'dream'
  prompt       TEXT NOT NULL,        -- original caption or dream prompt
  image_path   TEXT,                 -- relative path under data/media/
  copy_json    TEXT NOT NULL,        -- {"instagram": "...", "linkedin": "...", ...}
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|published|failed|cancelled
  preview_msg  INTEGER,              -- Telegram message_id of the preview (for editing)
  error        TEXT,
  created_at   INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage (
  chat_id      INTEGER NOT NULL,
  day          TEXT NOT NULL,        -- YYYY-MM-DD
  dreams       INTEGER NOT NULL DEFAULT 0,
  posts        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, day)
);
```

Migrations: numbered SQL strings applied in `db.ts` against a `PRAGMA user_version` counter.

---

## 4. Core Flows (exact behavior)

### 4.1 Middleware chain (every update)
1. grammY `webhookCallback` with `secretToken` → drops requests lacking the header.
2. `allowlist.ts` → if chat_id unknown: reply "This bot is private." and stop.
3. `errors.ts` → catch-all: log structured error, reply "Algo falló ⚠️ — inténtalo de nuevo." Never crash the process.

### 4.2 Track A — `/post` (photo + caption)
1. Trigger: photo message whose caption starts with `/post `. (Also handle: `/post` text sent without photo → reply asking for a photo with the caption.)
2. Download largest `PhotoSize` via `getFile` → save to `data/media/<draftId>.jpg`.
3. `copy.ts`: one Haiku call. System prompt produces strict JSON `{ "instagram": str, "linkedin": str, "x": str, "facebook": str }` — only keys for the tenant's platforms. Per-platform rules baked into prompt: IG = hook + line breaks + 8–15 hashtags; LinkedIn = professional, no hashtag spam, 1300 char sweet spot; X = ≤280 chars; FB = conversational. Language: mirror the input language (ES/EN).
4. Insert draft. Reply with the photo + copy preview (one section per platform, HTML parse mode) + keyboard:
   `[✅ Publicar] [🔄 Texto] [❌ Cancelar]` → callback_data `pub:<id>` / `rgc:<id>` / `cxl:<id>`.

### 4.3 Track B — `/dream <prompt>`
1. Check `limits.ts` (DAILY_DREAM_LIMIT). Over limit → polite refusal with count.
2. Send `sendChatAction('upload_photo')` + a "🎨 Generando…" message.
3. `Promise.all([ image.ts → fal.ai Flux (returns image URL → download to data/media/), copy.ts ])`. Flux timeout 60s.
4. Insert draft. Edit the placeholder into photo + copy + keyboard:
   `[✅ Publicar] [🔄 Imagen] [🔄 Texto] [❌ Cancelar]` → `pub:` / `rgi:` / `rgc:` / `cxl:`.

### 4.4 Callbacks (`callbacks.ts`)
- `pub:<id>` → load draft (must be `pending`); `answerCallbackQuery('Publicando…')`; call adapter `publish()` with `PUBLIC_BASE_URL/media/<file>` as media URL; on success: status=published, edit message to "✅ Publicado" + post links/IDs returned by Zernio; on failure: status=failed, store error, edit keyboard to `[🔁 Reintentar] [❌ Cancelar]`.
- `rgi:` → re-run Flux only (counts against dream limit), update photo via `editMessageMedia`.
- `rgc:` → re-run copy only, update caption.
- `twk:` (v1.1, build last) → bot replies "Responde a este mensaje con tus cambios"; a reply-to handler regenerates copy with the user's instruction appended.
- `cxl:` → status=cancelled, edit message, delete media file.
- All callbacks idempotent: ignore if draft status ≠ expected.

### 4.5 Publisher adapter (`services/publisher/types.ts`)
```ts
export interface PublishAdapter {
  publish(input: {
    accountIds: string[];
    content: Record<string, string>;   // platform → copy
    mediaUrls: string[];
  }): Promise<{ ok: true; results: PlatformResult[] } | { ok: false; error: string }>;
  listAccounts(): Promise<SocialAccount[]>;   // powers /status
}
```
`zernio.ts` implements it against docs.zernio.com (fetch docs at build time — endpoints not assumed here). Bearer auth, 30s timeout, map per-platform results.

### 4.6 Media serving (`media.ts` + index.ts)
- `GET /media/:file` from `data/media/` — validate filename against `^[a-zA-Z0-9_-]+\.(jpg|png|webp)$` (no traversal), `Cache-Control: public, max-age=86400`, 404 otherwise. Filenames are nanoid-random → unguessable.
- Daily cleanup (setInterval at boot): delete media older than `MEDIA_RETENTION_DAYS` whose draft is not `pending`.

### 4.7 `/status`
Reply: connected accounts (via `listAccounts()`), today's usage (`X/20 dreams`), bot version.

---

## 5. Production Deployment

### Caddyfile
```
bot.example.com {
    reverse_proxy localhost:3000
}
```
(Caddy handles TLS automatically — Telegram requires HTTPS for webhooks.)

### deploy/social-bot.service
```ini
[Unit]
Description=Social Command Center bot
After=network.target

[Service]
WorkingDirectory=/opt/social-bot
ExecStart=/usr/local/bin/bun run src/index.ts
EnvironmentFile=/opt/social-bot/.env
Restart=always
RestartSec=3
User=socialbot
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/social-bot/data

[Install]
WantedBy=multi-user.target
```

### Ops details Claude Code must implement
- **Webhook registration:** `bun run scripts/set-webhook.ts` → calls `setWebhook` with `secret_token` + `drop_pending_updates`.
- **Graceful shutdown:** SIGTERM → stop accepting, finish in-flight handlers, close DB.
- **Logging:** structured JSON to stdout (journald captures it). Log: update type, chat_id, draft_id, latency, errors. View: `journalctl -u social-bot -f`.
- **Health:** `GET /health` → `{ok, uptime, db:'ok'}`.
- **Backups:** `deploy/backup.sh` — nightly cron: `sqlite3 data/app.db ".backup data/backups/app-$(date +%F).db"` + keep 7; rsync media optional.
- **Deploy flow:** `git pull && bun install && systemctl restart social-bot`. (CI later; not v1.)

---

## 6. Build Phases × Acceptance Criteria

| Phase | Scope | Done when |
|---|---|---|
| **P0** (Pedro) | Tasks table §0 + curl validation against Zernio | Manual image post lands on IG/LinkedIn |
| **P1** | Scaffold: config, db+migrations, bot.ts, middleware, /help, /status (stubbed accounts), index.ts server, set-webhook script, Caddyfile, systemd unit | Bot answers /help on the droplet over HTTPS; non-allowlisted chat rejected; /health returns ok |
| **P2** | Track A end-to-end: media download+serving, copy.ts, draft persistence, preview, pub/rgc/cxl callbacks, zernio.ts, /status real | Photo + `/post` caption → preview → ✅ → live on IG & LinkedIn with correct per-platform copy; failure path shows Reintentar |
| **P3** | Track B: image.ts (Flux), Promise.all flow, rgi callback, limits.ts | `/dream` prompt → image+copy in <90s → regenerate works → publish works; 21st dream of the day refused |
| **P4** | Polish: twk flow, ES/EN mirroring verified, media cleanup, backup.sh + cron, graceful shutdown, README runbook | Kill -TERM mid-flow loses nothing; restore-from-backup tested once; demo script rehearsed |

Each phase = one Claude Code session. Start each session: "Read CLAUDE.md and PLAN.md. Build Phase N. Fetch current provider docs before integrations."

---

## 7. Known Risks & Mitigations
- **Zernio is young (ex-Late).** Adapter isolation (§4.5) = swap cost ≈ 1 file. Ayrshare = fallback.
- **X per-call pass-through billing.** Don't connect X accounts until a client asks; set Zernio dashboard spend cap first.
- **Flux content/quality misses.** Regenerate button is the product answer; `flux/schnell` for cheap retries if cost matters.
- **Telegram 64-byte callback_data.** Solved by design: `pfx:<nanoid10>`.
- **Droplet dies.** Nightly DB backup + .env in your password manager → full rebuild < 30 min.
