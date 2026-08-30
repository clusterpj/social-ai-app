/**
 * Registers the Telegram webhook for this bot.
 * Usage: bun run scripts/set-webhook.ts  (reads .env via Bun)
 */
import { z } from "zod";
import { config } from "../src/config";

const responseSchema = z.object({
  ok: z.boolean(),
  result: z.boolean().optional(),
  description: z.string().optional(),
});

const res = await fetch(
  `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${config.PUBLIC_BASE_URL}/webhook`,
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: true,
      allowed_updates: ["message", "callback_query"],
    }),
    signal: AbortSignal.timeout(15_000),
  },
);

const body = responseSchema.parse(await res.json());
if (!body.ok || body.result !== true) {
  process.stderr.write(`setWebhook failed: ${body.description ?? res.status}\n`);
  process.exit(1);
}
process.stdout.write(`Webhook set to ${config.PUBLIC_BASE_URL}/webhook\n`);
