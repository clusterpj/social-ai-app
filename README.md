# Social Command Center

> A Telegram bot that turns one line into ready-to-publish social posts — per-platform copy, AI images with text that actually renders, and one-tap publishing to **Instagram, LinkedIn, Facebook and X**.

One of the projects from [pedrojimenez.dev](https://pedrojimenez.dev/work/social-command) — built and run solo, in production, by Pedro Jimenez.

## What it does

You tell the bot what to promote (a photo, a product, a one-line idea). It:

1. **Writes per-platform copy** — a LinkedIn post is not an X post is not an Instagram caption. One module deals with the tone and length for each.
2. **Generates images that get the text right** — the hard part of AI images is legible text, so it tiles the copy onto the image the right way (see the image engine) instead of hoping the model spells it.
3. **Publishes everywhere** through [Zernio](https://zernio.com) — Instagram, LinkedIn, Facebook, X — to the right account, with the right copy, on demand. One command instead of four logins.
4. **Is safe to run unattended**: a daily generation cap bounds the worst case, every image call is pinned to resolution, a failed publish retries against already-generated assets (no extra cost), and a chat allow-list means any other message is ignored outright.

## Architecture

Clean separation so the risky parts are testable and the platform details stay in one place:

```
src/
  bot.ts        # Telegram entry (grammY)
  commands/     # /new, /promote, /status + inline keyboard
  media.ts      # image engine (fal.ai) — resolution pinning + retries
  callbacks.ts  # Zernio publish + per-platform copy
  limits.ts     # daily generation cap
  db.ts         # SQLite (bun:sqlite) storage
  config.ts     # env-var loading (typed)
```

- **Runtime**: [Bun](https://bun.sh) (single binary, fast, zero-config)
- **LLM**: Anthropic Claude / DeepSeek (swappable via env)
- **Images**: fal.ai (Flux) with a text-aware pipeline
- **Publish**: Zernio API → Instagram / LinkedIn / Facebook / X
- **Storage**: local SQLite
- **Deploy**: systemd on a single Droplet

## Run it

```bash
bun install
cp .env.example .env   # fill in your keys
bun run start
```

Every secret is read from env — nothing is committed. The bot runs as a systemd service (`deploy/` has the unit).

## Why it's interesting

- The **image text problem**: most AI image models mangle words. This bot's pipeline is built around getting text *onto* images reliably, not hoping.
- **Cost discipline**: a hard daily cap + per-call resolution pinning + retry-on-generated-assets means the worst case is bounded before it happens.
- **Single-responsibility publish module**: only one file knows which platform API is used, so adding/bypassing a platform is trivial and testable.

## License

MIT — see [LICENSE](LICENSE).
