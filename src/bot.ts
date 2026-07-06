import { Bot } from "grammy";
import { config } from "./config";
import { errorBoundary } from "./middleware/errors";
import { allowlist } from "./middleware/allowlist";
import { helpCommand } from "./commands/help";
import { statusCommand } from "./commands/status";
import { postCommand, continuePostIdea } from "./commands/post";
import { dreamCommand } from "./commands/dream";
import { callbackRouter, handleTweakReply } from "./callbacks";
import { getDraft } from "./db";
import { errorFields, log } from "./log";

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

bot.use(errorBoundary);
bot.use(allowlist);

bot.command(["start", "help"], helpCommand);
bot.command("status", statusCommand);

// Track A: /post — any photo starts the flow; the caption (with or without
// a /post prefix) is the idea. `/post` as plain text shows the how-to hint.
bot.command("post", postCommand);
bot.on("message:photo", postCommand);

// Track B: /dream
bot.command("dream", dreamCommand);

// Callback query router — handles pub/rgc/cxl/twk button presses.
bot.on("callback_query:data", callbackRouter);

// Handle tweak replies
bot.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !("text" in replyTo) || !replyTo.text) {
    return next();
  }

  const match = replyTo.text.match(/\[Borrador:\s*([^\]]+)\]/);
  if (!match) {
    return next();
  }

  const draftId = match[1];
  if (!draftId) {
    return next();
  }

  // A post draft still waiting for its idea (photo sent with no caption)
  // gets completed; anything else is a copy tweak.
  const draft = getDraft(draftId);
  if (draft && draft.kind === "post" && draft.prompt === "" && draft.status === "pending") {
    await continuePostIdea(ctx, draftId, ctx.message.text);
  } else {
    await handleTweakReply(ctx, draftId, ctx.message.text);
  }
});

// Safety net for anything the boundary middleware cannot reach.
bot.catch((err) => {
  log("error", "bot_uncaught", {
    update_id: err.ctx.update.update_id,
    chat_id: err.ctx.chat?.id,
    ...errorFields(err.error),
  });
});
