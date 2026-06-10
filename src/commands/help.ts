import type { Context } from "grammy";

const HELP_TEXT = [
  "<b>Social Command Center</b> 🚀",
  "",
  "📸 <b>/post</b> — envía una <i>foto</i> con el caption <code>/post tu idea</code> y genero el copy para cada red. / Send a <i>photo</i> captioned <code>/post your idea</code> and I'll write per-platform copy.",
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
