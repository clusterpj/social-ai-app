import type { Context } from "grammy";
import { nanoid } from "nanoid";
import { getTenant, insertDraft, updateDraftPreviewMsg, incrementUsage, todayUtc } from "../db";
import { generateCopy, extractTextOverlay } from "../services/copy";
import { addTextToImage } from "../services/image";
import { downloadToMedia, newMediaFilename, mediaLocalPath } from "../media";
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
    `<b>📋 Vista previa / Preview</b>`,
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
 * Track A: [✅ Publicar] [🔄 Texto] [❌ Cancelar]
 */
function buildKeyboard(draftId: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Publicar", callback_data: `pub:${draftId}` },
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
 * /post command handler — Track A.
 *
 * Trigger: photo message whose caption starts with `/post `.
 * If `/post` is sent as plain text (no photo), asks the user to attach one.
 */
export async function postCommand(ctx: Context): Promise<void> {
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

  // Check if this is a photo message with /post caption
  const photo = ctx.message?.photo;
  const caption = ctx.message?.caption ?? ctx.message?.text ?? "";

  // Extract the prompt: everything after `/post `
  const match = caption.match(/^\/post\s+([\s\S]+)/);

  if (!photo || !match) {
    await ctx.reply(
      "📸 Envía una <b>foto</b> con el caption <code>/post tu idea aquí</code>.\n" +
        "/ Send a <b>photo</b> captioned <code>/post your idea here</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const prompt = match[1]?.trim();
  if (!prompt) {
    await ctx.reply(
      "Escribe tu idea después de /post. / Write your idea after /post.",
    );
    return;
  }

  const draftId = nanoid(10);
  const filename = newMediaFilename("jpg");

  try {
    // 1. Download the largest photo from Telegram
    const largestPhoto = photo[photo.length - 1];
    if (!largestPhoto) {
      await ctx.reply("No se pudo obtener la foto. / Could not get the photo.");
      return;
    }

    const file = await ctx.api.getFile(largestPhoto.file_id);
    if (!file.file_path) {
      await ctx.reply("No se pudo descargar la foto. / Could not download the photo.");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
    await downloadToMedia(fileUrl, filename);

    log("info", "post_photo_saved", {
      chat_id: chatId,
      draft_id: draftId,
      filename,
    });

    // 1b. Check if we need to overlay text and process image
    const textOverlay = await extractTextOverlay(prompt);
    if (textOverlay) {
      // Show an indicator since AI image processing takes a few seconds
      await ctx.replyWithChatAction("upload_photo").catch(() => {});
      await addTextToImage(filename, textOverlay.text, textOverlay.style);
    }

    // 2. Generate per-platform copy via Haiku
    const copyResult = await generateCopy(prompt, tenant.platforms);
    const copyJson = copyResult as Record<string, string>;

    // 3. Persist draft
    insertDraft({
      id: draftId,
      chatId,
      kind: "post",
      prompt,
      imagePath: filename,
      copyJson: JSON.stringify(copyJson),
    });

    // 4. Increment usage counter
    incrementUsage(chatId, todayUtc(), "posts");

    // 5. Send preview: photo + copy + inline keyboard
    const previewText = buildPreview(copyJson, prompt);
    const photoPath = mediaLocalPath(filename);
    const photoFile = Bun.file(photoPath);

    const sent = await ctx.replyWithPhoto(
      new InputFile(new Uint8Array(await photoFile.arrayBuffer()), filename),
      {
        caption: previewText.slice(0, 1024), // Telegram caption limit
        parse_mode: "HTML",
        reply_markup: buildKeyboard(draftId),
      },
    );

    // 6. Save the message ID so callbacks can edit it later
    updateDraftPreviewMsg(draftId, sent.message_id);

    log("info", "post_preview_sent", {
      chat_id: chatId,
      draft_id: draftId,
      platforms: tenant.platforms.join(","),
    });
  } catch (err) {
    log("error", "post_command_error", {
      chat_id: chatId,
      draft_id: draftId,
      ...errorFields(err),
    });
    await ctx.reply("Algo falló al procesar tu post ⚠️ — inténtalo de nuevo.");
  }
}

// grammY InputFile helper — re-export from grammy
import { InputFile } from "grammy";
