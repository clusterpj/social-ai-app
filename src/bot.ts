import { Bot } from "grammy";
import { config } from "./config";
import { errorBoundary } from "./middleware/errors";
import { allowlist } from "./middleware/allowlist";
import { helpCommand } from "./commands/help";
import { statusCommand } from "./commands/status";
import { postCommand } from "./commands/post";
import { dreamCommand } from "./commands/dream";
import { callbackRouter } from "./callbacks";
import { errorFields, log } from "./log";

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

bot.use(errorBoundary);
bot.use(allowlist);

bot.command(["start", "help"], helpCommand);
bot.command("status", statusCommand);

// Track A: /post — handle both as a command on text and as a caption on photos.
// grammY `command` only matches text messages, so we also listen for photos
// whose caption starts with /post.
bot.command("post", postCommand);
bot.on("message:photo", async (ctx, next) => {
  const caption = ctx.message.caption ?? "";
  if (caption.startsWith("/post")) {
    await postCommand(ctx);
  } else {
    await next();
  }
});

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
  const tweakInstruction = ctx.message.text;

  // We can just reuse handleRegenerateCopy, but we need to pass the tweak.
  // Wait, handleRegenerateCopy is in callbacks.ts and expects a context.
  // Instead of tightly coupling, let's import the specific tweak copy function from callbacks.ts.
  const { handleTweakReply } = await import("./callbacks");
  await handleTweakReply(ctx, draftId, tweakInstruction);
});

// Safety net for anything the boundary middleware cannot reach.
bot.catch((err) => {
  log("error", "bot_uncaught", {
    update_id: err.ctx.update.update_id,
    chat_id: err.ctx.chat?.id,
    ...errorFields(err.error),
  });
});
