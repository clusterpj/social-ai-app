import type { Context } from "grammy";
import { config, VERSION } from "../config";
import { getTenant, getUsage, todayUtc } from "../db";

/**
 * P1: accounts are read from the tenant record (stub). P2 replaces this with
 * live data from PublishAdapter.listAccounts().
 */
export async function statusCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const tenant = getTenant(chatId);
  const usage = getUsage(chatId, todayUtc());

  const lines: string[] = ["<b>📊 Estado / Status</b>", ""];
  if (tenant === null) {
    lines.push("⚠️ Sin cuentas configuradas todavía. / No accounts configured yet.");
  } else {
    lines.push(`👤 <b>${escapeHtml(tenant.name)}</b>`);
    lines.push(`🔗 Plataformas: ${tenant.platforms.join(", ")}`);
  }
  lines.push("");
  lines.push(`🎨 Dreams hoy: ${usage.dreams}/${config.DAILY_DREAM_LIMIT}`);
  lines.push(`📤 Posts hoy: ${usage.posts}`);
  lines.push("");
  lines.push(`<i>v${VERSION}</i>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
