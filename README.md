# Social Command Center Bot

This Telegram bot allows you to generate AI copy (using Anthropic's Claude/Deepseek), generate images (using ComfyUI/fal.ai), and publish them directly to your connected social accounts via Zernio (Instagram, LinkedIn, Facebook, X).

## Prerequisites

- **Bun**: This project uses Bun as the runtime and package manager.
- **SQLite**: Used for the local database (`app.db`).
- **Telegram Bot Token**: Get one from [@BotFather](https://t.me/botfather).
- **Zernio API Key**: Get one from your Zernio dashboard.
- **LLM / Image API Keys**: Anthropic, Deepseek, or Fal.ai depending on your config.

## Local Development

1. **Clone & Install**
   ```bash
   bun install
   ```

2. **Environment Variables**
   Copy `.env.example` to `.env` and fill in the values:
   ```env
   TELEGRAM_BOT_TOKEN=your_token
   ALLOWED_CHAT_IDS=123456789,987654321
   PUBLIC_BASE_URL=https://your-public-url.com
   PORT=3000
   ZERNIO_API_KEY=your_zernio_key
   # Add other API keys as needed...
   ```

3. **Run the Server**
   ```bash
   bun run dev
   ```

> [!TIP]
> **Webhooks vs Polling**: If you are developing locally and `PUBLIC_BASE_URL` contains `localhost`, the bot will automatically use Telegram long-polling. If you use a public URL (like an `ngrok` or `cloudflared` tunnel), it expects Telegram webhooks.

## Production Deployment (Ubuntu)

1. **Clone the Repo** to `/opt/social-bot`
2. **Setup Caddy** (Reverse Proxy for HTTPS):
   Add this to your `/etc/caddy/Caddyfile`:
   ```caddyfile
   bot.yourdomain.com {
       reverse_proxy localhost:3000
   }
   ```
   Run `systemctl reload caddy`.

3. **Set the Webhook**
   Run the following script to tell Telegram your production URL:
   ```bash
   bun run scripts/set-webhook.ts
   ```

4. **Systemd Service**
   Copy the `deploy/social-bot.service` to `/etc/systemd/system/`:
   ```bash
   sudo cp deploy/social-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now social-bot
   ```

> [!IMPORTANT]
> The service expects the code to be in `/opt/social-bot` and run under a user called `socialbot`. Update the service file paths and user if your environment is different.

## Automated Backups

The project includes a backup script (`deploy/backup.sh`) that safely dumps the SQLite WAL database and keeps the last 7 days of backups.

**Setup Cron Job:**
```bash
crontab -e
```
Add the following line to run the backup every night at 2:00 AM:
```cron
0 2 * * * /opt/social-bot/deploy/backup.sh >> /opt/social-bot/data/backups/backup.log 2>&1
```

## Troubleshooting

- **Bot is not responding**:
  - Check the logs: `journalctl -u social-bot -f`
  - Ensure the user's Telegram `chat_id` is in the `ALLOWED_CHAT_IDS` list in `.env`.
  - Check the health endpoint: `curl https://bot.yourdomain.com/health`

- **Images not posting to Facebook/Instagram**:
  - Check the Zernio dashboard to ensure the social accounts haven't expired or become disconnected.
  - Zernio requires the `PUBLIC_BASE_URL` to be publicly accessible so it can download the images.

## Adding New Clients
1. Add their social accounts in the Zernio Dashboard and note the Account IDs.
2. Add their Telegram `chat_id` to `ALLOWED_CHAT_IDS` in `.env`.
3. Add a mapping in `src/db.ts` (or update via a future admin command) so the bot knows which chat maps to which Zernio accounts.
