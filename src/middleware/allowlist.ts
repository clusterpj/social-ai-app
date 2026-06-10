import type { MiddlewareFn } from "grammy";
import { config } from "../config";
import { log } from "../log";

const allowed: ReadonlySet<number> = new Set(config.ALLOWED_CHAT_IDS);

/** Rejects every update whose chat is not in ALLOWED_CHAT_IDS. */
export const allowlist: MiddlewareFn = async (ctx, next) => {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId !== undefined && allowed.has(chatId)) {
    await next();
    return;
  }
  log("warn", "chat_rejected", { chat_id: chatId, update_id: ctx.update.update_id });
  if (ctx.callbackQuery !== undefined) {
    await ctx.answerCallbackQuery({ text: "This bot is private." });
  } else if (ctx.chat !== undefined) {
    await ctx.reply("This bot is private.");
  }
};
