import type { Context } from "grammy";
import { InputFile } from "grammy";
import { nanoid } from "nanoid";
import { getTenant, insertDraft, updateDraftPreviewMsg, incrementUsage, todayUtc } from "../db";
import { generateCopy } from "../services/copy";
import { generateImage } from "../services/image";
import { checkDreamLimit } from "../limits";
import { mediaLocalPath } from "../media";
import { errorFields, log } from "../log";
import type { Platform } from "../services/publisher/types";

/**
 * Build the preview message — photo + per-platform copy sections.
 * Returns HTML text for the caption.
 */
function buildPreview(
  copyJson: Record<string, string>,
  prompt: string,
): string {
  const lines: string[] = [
    `<b>🎨 Sueño / Dream</b>`,
    `<i>${escapeHtml(prompt)}</i>`,
    "",
  ];

  for (const [platform, copy] of Object.entries(copyJson)) {
    lines.push(`<b>▸ ${escapeHtml(platform)}</b>`);
    lines.push(escapeHtml(copy));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build the inline keyboard for the preview message.
 * Track B: [✅ Publicar] [🔄 Imagen] [🔄 Texto] [❌ Cancelar]
 */
function buildKeyboard(draftId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ Publicar", callback_data: `pub:${draftId}` }],
      [
        { text: "🔄 Imagen", callback_data: `rgi:${draftId}` },
        { text: "🔄 Texto", callback_data: `rgc:${draftId}` },
      ],
      [
        { text: "✏️ Ajustar", callback_data: `twk:${draftId}` },
        { text: "❌ Cancelar", callback_data: `cxl:${draftId}` },
      ]
    ],
  };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * /dream command handler — Track B.
 *
 * Trigger: text message starting with `/dream `.
 */
export async function dreamCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const tenant = getTenant(chatId);
  if (tenant === null) {
    await ctx.reply(
      "⚠️ No tienes cuentas configuradas. / No accounts configured.\n" +
        "Pide al administrador que configure tus cuentas. / Ask the admin to set up your accounts.",
    );
    return;
  }

  const text = ctx.message?.text ?? "";
  const match = text.match(/^\/dream\s+([\s\S]+)/);

  if (!match) {
    await ctx.reply(
      "Escribe tu idea después de /dream. / Write your idea after /dream.\n" +
      "Ejemplo: <code>/dream Un perro astronauta en marte</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  const prompt = match[1]?.trim();
  if (!prompt) {
    await ctx.reply(
      "Escribe tu idea después de /dream. / Write your idea after /dream.",
    );
    return;
  }

  // 1. Check daily limits
  const limitCheck = checkDreamLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.reply(
      `Has alcanzado el límite diario de ${limitCheck.limit} dreams. / You have reached the daily limit of ${limitCheck.limit} dreams.\n` +
      `Inténtalo mañana. / Try again tomorrow.`
    );
    return;
  }

  const draftId = nanoid(10);
  let placeholderMsgId: number | null = null;

  try {
    // 2. Send loading state
    const placeholderMsg = await ctx.reply("🎨 Generando imagen y texto... / Generating image and copy...");
    placeholderMsgId = placeholderMsg.message_id;
    await ctx.replyWithChatAction("upload_photo").catch(() => {}); // Optional visual indicator

    // 3. Generate image and copy in parallel
    const [filename, copyResult] = await Promise.all([
      generateImage(prompt),
      generateCopy(prompt, tenant.platforms),
    ]);

    const copyJson = copyResult as Record<string, string>;

    // 4. Persist draft
    insertDraft({
      id: draftId,
      chatId,
      kind: "dream",
      prompt,
      imagePath: filename,
      copyJson: JSON.stringify(copyJson),
    });

    // 5. Increment usage counter
    incrementUsage(chatId, todayUtc(), "dreams");

    // 6. Delete the placeholder message
    if (placeholderMsgId !== null) {
      await ctx.api.deleteMessage(chatId, placeholderMsgId).catch(() => {});
    }

    // 7. Send final preview with keyboard
    const previewText = buildPreview(copyJson, prompt);
    const photoPath = mediaLocalPath(filename);
    const photoFile = Bun.file(photoPath);

    const sent = await ctx.replyWithPhoto(
      new InputFile(new Uint8Array(await photoFile.arrayBuffer()), filename),
      {
        caption: previewText.slice(0, 1024),
        parse_mode: "HTML",
        reply_markup: buildKeyboard(draftId),
      },
    );

    // 8. Save message ID for future edits
    updateDraftPreviewMsg(draftId, sent.message_id);

    log("info", "dream_preview_sent", {
      chat_id: chatId,
      draft_id: draftId,
      platforms: tenant.platforms.join(","),
    });
  } catch (err) {
    log("error", "dream_command_error", {
      chat_id: chatId,
      draft_id: draftId,
      ...errorFields(err),
    });

    if (placeholderMsgId !== null) {
      await ctx.api.deleteMessage(chatId, placeholderMsgId).catch(() => {});
    }
    
    await ctx.reply("Algo falló al generar tu dream ⚠️ — inténtalo de nuevo.");
  }
}
