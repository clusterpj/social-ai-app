import { Bot } from "grammy";
import { config } from "./config";
import { errorBoundary } from "./middleware/errors";
import { allowlist } from "./middleware/allowlist";
import { helpCommand } from "./commands/help";
import { statusCommand } from "./commands/status";
import { errorFields, log } from "./log";

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

bot.use(errorBoundary);
bot.use(allowlist);

bot.command(["start", "help"], helpCommand);
bot.command("status", statusCommand);

// Safety net for anything the boundary middleware cannot reach.
bot.catch((err) => {
  log("error", "bot_uncaught", {
    update_id: err.ctx.update.update_id,
    chat_id: err.ctx.chat?.id,
    ...errorFields(err.error),
  });
});
