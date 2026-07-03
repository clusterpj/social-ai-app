import type { Context } from "grammy";
import { InputFile } from "grammy";
import {
  getDraft,
  getTenant,
  updateDraftStatus,
  updateDraftCopyJson,
  updateDraftPreviewMsg,
  updateDraftImagePath,
  incrementUsage,
  todayUtc,
} from "./db";
import { generateCopy } from "./services/copy";
import { generateImage } from "./services/image";
import { zernioAdapter } from "./services/publisher/zernio";
import { checkDreamLimit } from "./limits";
import { mediaPublicUrl, mediaLocalPath, deleteMedia } from "./media";
import { errorFields, log } from "./log";

/**
 * Route callback queries by prefix.
 * Format: `pfx:<nanoid10>` — stays under Telegram's 64-byte limit.
 */
export async function callbackRouter(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const sepIdx = data.indexOf(":");
  if (sepIdx === -1) return;

  const prefix = data.slice(0, sepIdx);
  const draftId = data.slice(sepIdx + 1);

  switch (prefix) {
    case "pub":
      await handlePublish(ctx, draftId);
      break;
    case "rgi":
      await handleRegenerateImage(ctx, draftId);
      break;
    case "rgc":
      await handleRegenerateCopy(ctx, draftId);
      break;
    case "twk":
      await handleTweak(ctx, draftId);
      break;
    case "cxl":
      await handleCancel(ctx, draftId);
      break;
    default:
      await ctx.answerCallbackQuery({ text: "Acción desconocida." });
  }
}

// ---------------------------------------------------------------------------
// pub:<id> — Publish the draft via Zernio
// ---------------------------------------------------------------------------

async function handlePublish(ctx: Context, draftId: string): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: "Este borrador ya no está pendiente." });
    return;
  }

  const tenant = getTenant(draft.chatId);
  if (!tenant) {
    await ctx.answerCallbackQuery({ text: "Sin cuentas configuradas." });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Publicando… ⏳" });

  try {
    const copyJson = JSON.parse(draft.copyJson) as Record<string, string>;
    const mediaUrls = draft.imagePath
      ? [
          mediaPublicUrl(draft.imagePath).includes("localhost") 
            ? "https://picsum.photos/800/600.jpg" 
            : mediaPublicUrl(draft.imagePath)
        ]
      : [];

    const result = await zernioAdapter.publish({
      accounts: tenant.accountIds.map((id, i) => ({
        id,
        platform: tenant.platforms[i]!,
      })),
      content: copyJson,
      mediaUrls,
    });

    if (result.ok) {
      updateDraftStatus(draftId, "published", { publishedAt: Date.now() });

      // Build success summary
      const lines: string[] = ["✅ <b>Publicado / Published</b>", ""];
      for (const r of result.results) {
        const status = r.ok ? "✅" : "❌";
        const link = r.url ? ` — <a href="${r.url}">ver</a>` : "";
        lines.push(`${status} ${r.platform}${link}`);
      }

      await editPreviewText(ctx, draft.chatId, draft.previewMsg, lines.join("\n"));

      log("info", "draft_published", {
        draft_id: draftId,
        chat_id: draft.chatId,
        results: result.results.length,
      });
    } else {
      updateDraftStatus(draftId, "failed", { error: result.error });

      // Show retry button
      await editPreviewKeyboard(ctx, draft.chatId, draft.previewMsg, [
        [
          { text: "🔁 Reintentar", callback_data: `pub:${draftId}` },
          { text: "❌ Cancelar", callback_data: `cxl:${draftId}` },
        ],
      ]);

      // Reset to pending so retry works
      updateDraftStatus(draftId, "pending");

      log("warn", "draft_publish_failed", {
        draft_id: draftId,
        error: result.error,
      });
    }
  } catch (err) {
    updateDraftStatus(draftId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Reset to pending so retry works
    updateDraftStatus(draftId, "pending");
    log("error", "publish_callback_error", {
      draft_id: draftId,
      ...errorFields(err),
    });
    await ctx.answerCallbackQuery({ text: "Error al publicar ⚠️" });
  }
}

// ---------------------------------------------------------------------------
// rgc:<id> — Regenerate copy only
// ---------------------------------------------------------------------------

async function handleRegenerateCopy(
  ctx: Context,
  draftId: string,
): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: "Este borrador ya no está pendiente." });
    return;
  }

  const tenant = getTenant(draft.chatId);
  if (!tenant) {
    await ctx.answerCallbackQuery({ text: "Sin cuentas configuradas." });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Regenerando texto… 🔄" });

  try {
    const newCopy = await generateCopy(draft.prompt, tenant.platforms);
    const newCopyJson = newCopy as Record<string, string>;
    updateDraftCopyJson(draftId, JSON.stringify(newCopyJson));

    // Build updated caption
    const lines: string[] = [
      `<b>📋 Vista previa / Preview</b>`,
      `<i>${escapeHtml(draft.prompt)}</i>`,
      "",
    ];
    for (const [platform, copy] of Object.entries(newCopyJson)) {
      lines.push(`<b>▸ ${escapeHtml(platform)}</b>`);
      lines.push(escapeHtml(copy));
      lines.push("");
    }

    const captionText = lines.join("\n").slice(0, 1024);

    // If the preview message has a photo, use editMessageCaption
    if (draft.previewMsg !== null) {
      try {
        await ctx.api.editMessageCaption(draft.chatId, draft.previewMsg, {
          caption: captionText,
          parse_mode: "HTML",
          reply_markup: buildKeyboard(draftId, draft.kind),
        });
      } catch (editErr) {
        log("warn", "edit_caption_failed", errorFields(editErr));
      }
    }

    log("info", "copy_regenerated", {
      draft_id: draftId,
      chat_id: draft.chatId,
    });
  } catch (err) {
    log("error", "regenerate_copy_error", {
      draft_id: draftId,
      ...errorFields(err),
    });
    await ctx.answerCallbackQuery({ text: "Error regenerando texto ⚠️" });
  }
}

// ---------------------------------------------------------------------------
// rgi:<id> — Regenerate image only
// ---------------------------------------------------------------------------

async function handleRegenerateImage(
  ctx: Context,
  draftId: string,
): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: "Este borrador ya no está pendiente." });
    return;
  }

  if (draft.kind !== "dream") {
    await ctx.answerCallbackQuery({ text: "No se puede regenerar imagen para un post manual." });
    return;
  }

  const limitCheck = checkDreamLimit(draft.chatId);
  if (!limitCheck.allowed) {
    await ctx.answerCallbackQuery({ text: `Límite diario alcanzado (${limitCheck.limit}).` });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Regenerando imagen… 🎨" });

  try {
    const newFilename = await generateImage(draft.prompt);
    
    if (draft.imagePath) {
      deleteMedia(draft.imagePath);
    }

    updateDraftImagePath(draftId, newFilename);
    incrementUsage(draft.chatId, todayUtc(), "dreams");

    if (draft.previewMsg !== null) {
      const photoPath = mediaLocalPath(newFilename);
      const photoFile = Bun.file(photoPath);
      
      try {
        await ctx.api.editMessageMedia(
          draft.chatId,
          draft.previewMsg,
          {
            type: "photo",
            media: new InputFile(new Uint8Array(await photoFile.arrayBuffer()), newFilename),
          },
          { reply_markup: buildKeyboard(draftId, draft.kind) },
        );
      } catch (editErr) {
        log("warn", "edit_media_failed", errorFields(editErr));
      }
    }

    log("info", "image_regenerated", {
      draft_id: draftId,
      chat_id: draft.chatId,
    });
  } catch (err) {
    log("error", "regenerate_image_error", {
      draft_id: draftId,
      ...errorFields(err),
    });
    await ctx.answerCallbackQuery({ text: "Error regenerando imagen ⚠️" });
  }
}

// ---------------------------------------------------------------------------
// twk:<id> — Prompt user for a copy tweak
// ---------------------------------------------------------------------------

async function handleTweak(ctx: Context, draftId: string): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: "Este borrador ya no está pendiente." });
    return;
  }

  await ctx.answerCallbackQuery();
  
  await ctx.reply(`Responde a este mensaje con tus cambios o instrucciones (ej. "hazlo más corto", "añade más emojis"). [Borrador: ${draftId}]`, {
    reply_markup: { force_reply: true },
  });
}

export async function handleTweakReply(ctx: Context, draftId: string, tweakInstruction: string): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "pending") {
    await ctx.reply("Este borrador ya no está pendiente.");
    return;
  }

  const tenant = getTenant(draft.chatId);
  if (!tenant) return;

  const msg = await ctx.reply("🔄 Ajustando texto...");
  await ctx.api.sendChatAction(draft.chatId, "typing");

  try {
    const copyResult = await generateCopy(draft.prompt, tenant.platforms, tweakInstruction);
    const copyJson = copyResult as Record<string, string>;

    updateDraftCopyJson(draftId, JSON.stringify(copyJson));

    const lines: string[] = [
      draft.kind === "dream" ? `<b>🎨 Sueño / Dream</b>` : `<b>📋 Vista previa / Preview</b>`,
      `<i>${escapeHtml(draft.prompt)}</i>`,
      "",
    ];
    for (const [platform, copy] of Object.entries(copyJson)) {
      lines.push(`<b>▸ ${escapeHtml(platform)}</b>`);
      lines.push(escapeHtml(copy));
      lines.push("");
    }
    const captionText = lines.join("\n").slice(0, 1024);
    
    // Attempt to update the preview message.
    if (draft.previewMsg) {
      await ctx.api.editMessageCaption(draft.chatId, draft.previewMsg, {
        caption: captionText,
        parse_mode: "HTML",
        reply_markup: buildKeyboard(draftId, draft.kind),
      });
    }

    log("info", "copy_tweaked", { chat_id: draft.chatId, draft_id: draftId });
    await ctx.api.editMessageText(draft.chatId, msg.message_id, "✅ Texto ajustado exitosamente.");
  } catch (err) {
    log("error", "copy_tweak_error", errorFields(err));
    await ctx.api.editMessageText(draft.chatId, msg.message_id, "⚠️ Falló al ajustar el texto.");
  }
}

// ---------------------------------------------------------------------------
// cxl:<id> — Cancel the draft
// ---------------------------------------------------------------------------

async function handleCancel(ctx: Context, draftId: string): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Borrador no encontrado." });
    return;
  }
  if (draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: "Este borrador ya no está pendiente." });
    return;
  }

  updateDraftStatus(draftId, "cancelled");

  // Delete the media file
  if (draft.imagePath) {
    deleteMedia(draft.imagePath);
  }

  // Edit the preview message
  await editPreviewText(
    ctx,
    draft.chatId,
    draft.previewMsg,
    "❌ <b>Cancelado / Cancelled</b>",
  );

  await ctx.answerCallbackQuery({ text: "Borrador cancelado." });

  log("info", "draft_cancelled", {
    draft_id: draftId,
    chat_id: draft.chatId,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildKeyboard(draftId: string, kind: string) {
  if (kind === "dream") {
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
  return {
    inline_keyboard: [
      [
        { text: "✅ Publicar", callback_data: `pub:${draftId}` },
        { text: "🔄 Texto", callback_data: `rgc:${draftId}` },
      ],
      [
        { text: "✏️ Ajustar", callback_data: `twk:${draftId}` },
        { text: "❌ Cancelar", callback_data: `cxl:${draftId}` },
      ],
    ],
  };
}

/**
 * Try to edit the preview message caption. If that fails (e.g. message is
 * text-only), try editMessageText instead.
 */
async function editPreviewText(
  ctx: Context,
  chatId: number,
  messageId: number | null,
  html: string,
): Promise<void> {
  if (messageId === null) return;
  try {
    await ctx.api.editMessageCaption(chatId, messageId, {
      caption: html.slice(0, 1024),
      parse_mode: "HTML",
    });
  } catch {
    try {
      await ctx.api.editMessageText(chatId, messageId, html, {
        parse_mode: "HTML",
      });
    } catch (err2) {
      log("warn", "edit_preview_text_failed", errorFields(err2));
    }
  }
}

async function editPreviewKeyboard(
  ctx: Context,
  chatId: number,
  messageId: number | null,
  keyboard: Array<Array<{ text: string; callback_data: string }>>,
): Promise<void> {
  if (messageId === null) return;
  try {
    await ctx.api.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    log("warn", "edit_preview_keyboard_failed", errorFields(err));
  }
}
