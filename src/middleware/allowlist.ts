import type { MiddlewareFn } from "grammy";
import { log } from "../log";
import { getSettings } from "../db";

/** Rejects every update whose chat is not in the dynamic ALLOWED_CHAT_IDS setting. */
export const allowlist: MiddlewareFn = async (ctx, next) => {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  
  const settings = getSettings();
  const allowed = new Set(
    settings.allowedChatIds
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(Number)
  );

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
