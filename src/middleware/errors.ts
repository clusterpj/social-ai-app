import type { MiddlewareFn } from "grammy";
import { errorFields, log } from "../log";

/**
 * Global error boundary — first middleware in the chain. Logs the failure and
 * tells the user something went wrong; never lets an error crash the process.
 */
export const errorBoundary: MiddlewareFn = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    log("error", "handler_error", {
      update_id: ctx.update.update_id,
      chat_id: ctx.chat?.id,
      ...errorFields(err),
    });
    try {
      if (ctx.callbackQuery !== undefined) {
        await ctx.answerCallbackQuery({ text: "Algo falló ⚠️ — inténtalo de nuevo." });
      } else if (ctx.chat !== undefined) {
        await ctx.reply("Algo falló ⚠️ — inténtalo de nuevo.");
      }
    } catch (replyErr) {
      log("error", "error_reply_failed", errorFields(replyErr));
    }
  }
};
