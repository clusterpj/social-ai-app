/**
 * Local-only smoke test: verifies webhookCallback enforces the secret token,
 * without talking to Telegram (botInfo is pre-supplied so getMe is skipped).
 * Usage: bun run scripts/smoke-webhook.ts
 */
import { Bot, webhookCallback } from "grammy";

const SECRET = "test-secret-token-0123456789abcdef";

const bot = new Bot("123456:dummy", {
  botInfo: {
    id: 123456,
    is_bot: true,
    first_name: "smoke",
    username: "smoke_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    can_manage_bots: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  },
});
const handle = webhookCallback(bot, "bun", { secretToken: SECRET });

const update = JSON.stringify({ update_id: 1 });
const mkReq = (secret?: string) =>
  new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: update,
  });

const noSecret = await handle(mkReq());
const wrongSecret = await handle(mkReq("wrong"));
const rightSecret = await handle(mkReq(SECRET));

process.stdout.write(
  `no secret: ${noSecret.status}\nwrong secret: ${wrongSecret.status}\nright secret: ${rightSecret.status}\n`,
);

const pass = noSecret.status === 401 && wrongSecret.status === 401 && rightSecret.status === 200;
process.stdout.write(pass ? "PASS\n" : "FAIL\n");
process.exit(pass ? 0 : 1);
