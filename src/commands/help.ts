import type { Context } from "grammy";

const HELP_TEXT = [
  "<b>Social Command Center</b> 🚀",
  "",
  "📸 <b>Foto</b> — envíame cualquier <i>foto</i> y escribo el copy para cada red. El caption es tu idea (opcional — si no, te la pregunto). / Send me any <i>photo</i> and I'll write per-platform copy. The caption is your idea (optional — I'll ask if it's missing).",
  "",
  "🎨 <b>/dream</b> — <code>/dream descripción de la imagen</code> y genero imagen + copy. / <code>/dream image description</code> generates image + copy.",
  "",
  "📊 <b>/status</b> — cuentas conectadas y uso de hoy. / Connected accounts and today's usage.",
  "",
  "❓ <b>/help</b> — este mensaje. / This message.",
].join("\n");

export async function helpCommand(ctx: Context): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
}
