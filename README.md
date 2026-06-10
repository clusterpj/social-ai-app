# Social Command Center

Telegram bot → AI copy + image generation → multi-platform publishing.
See [PLAN.md](PLAN.md) for the build plan and [CLAUDE.md](CLAUDE.md) for coding rules.

## Local dev

```sh
bun install
cp .env.example .env   # fill in values
bun run typecheck
bun run dev            # serves /health, /media/*, POST /webhook on PORT
```

## Deploy (Ubuntu droplet, Phase 1)

```sh
# as root, once:
adduser --system --group --home /opt/social-bot socialbot
git clone <repo> /opt/social-bot && cd /opt/social-bot
bun install
cp .env.example .env && nano .env          # fill in all values
chown -R socialbot:socialbot /opt/social-bot

cp deploy/social-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now social-bot

# Caddy: edit Caddyfile with your real domain, then
cp Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy

# register the webhook (after DNS + Caddy are live):
sudo -u socialbot bun run set-webhook
```

Verify:

- `curl https://bot.<yourdomain>.com/health` → `{"ok":true,...,"db":"ok"}`
- Message the bot `/help` from an allowlisted chat → command list
- Message from any other account → "This bot is private."
- Logs: `journalctl -u social-bot -f`

## Generating TELEGRAM_WEBHOOK_SECRET

```sh
openssl rand -hex 32
```
