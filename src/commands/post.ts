import type { Context } from "grammy";
import { InputFile } from "grammy";
import { nanoid } from "nanoid";
import {
  getTenant,
  getDraft,
  insertDraft,
  updateDraftPrompt,
  updateDraftCopyJson,
  updateDraftPreviewMsg,
  incrementUsage,
  todayUtc,
  type Tenant,
} from "../db";
import { generateCopy, extractTextOverlay } from "../services/copy";
import { addTextToImage } from "../services/image";
import { downloadToMedia, newMediaFilename, mediaLocalPath } from "../media";
import { errorFields, log } from "../log";

const LOADING_LINES = [
  "✍️ Escribiendo tu post… / Writing your post…",
  "🧠 Pensando el copy perfecto… / Cooking up the perfect copy…",
  "🪄 Un momento, la magia toma su tiempo… / One sec, magic takes time…",
  "🚀 Preparando tu post para despegar… / Prepping your post for takeoff…",
];

function pickLoadingLine(): string {
  return LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)] ?? LOADING_LINES[0]!;
}

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
 * Track A: [✅ Publicar] [🔄 Texto] [✏️ Ajustar] [❌ Cancelar]
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
 * Any photo starts the flow: the caption is the idea (a leading `/post` is
 * accepted but optional). A photo with no caption gets a force-reply asking
 * for the idea; the reply is routed back via `continuePostIdea`.
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

  const photo = ctx.message?.photo;
  const caption = ctx.message?.caption ?? ctx.message?.text ?? "";
  // `/post` prefix is optional — any caption text is the idea.
  const prompt = caption.replace(/^\/post(@\w+)?\s*/i, "").trim();

  if (!photo) {
    await ctx.reply(
      "📸 Envíame una <b>foto</b> y escribo el copy — el caption es tu idea (opcional).\n" +
        "/ Send me a <b>photo</b> and I'll write the copy — the caption is your idea (optional).",
      { parse_mode: "HTML" },
    );
    return;
  }

  const largestPhoto = photo[photo.length - 1];
  if (!largestPhoto) {
    await ctx.reply("No se pudo obtener la foto. / Could not get the photo.");
    return;
  }

  // Let them know we saw it 👀
  await ctx.react("👀").catch(() => {});

  const draftId = nanoid(10);
  const filename = newMediaFilename("jpg");

  try {
    // 1. Download the largest photo from Telegram
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

    // 2. Persist the draft now — copy is filled in by finishPost.
    insertDraft({
      id: draftId,
      chatId,
      kind: "post",
      prompt,
      imagePath: filename,
      copyJson: "{}",
    });

    // 3. No caption? Ask for the idea and finish when they reply.
    if (!prompt) {
      await ctx.reply(
        `📸 ¡Buena foto! ¿Qué quieres contar? Responde a este mensaje con tu idea.\n` +
          `/ Nice shot! What's the story? Reply to this message with your idea. [Borrador: ${draftId}]`,
        { reply_markup: { force_reply: true } },
      );
      return;
    }

    await finishPost(ctx, tenant, draftId, filename, prompt);
  } catch (err) {
    log("error", "post_command_error", {
      chat_id: chatId,
      draft_id: draftId,
      ...errorFields(err),
    });
    await ctx.reply("Algo falló al procesar tu post ⚠️ — inténtalo de nuevo.");
  }
}

/**
 * Continue a photo-first post: the user replied with the idea for a draft
 * that was created without a caption.
 */
export async function continuePostIdea(
  ctx: Context,
  draftId: string,
  prompt: string,
): Promise<void> {
  const draft = getDraft(draftId);
  if (!draft || draft.status !== "pending" || !draft.imagePath) {
    await ctx.reply("Este borrador ya no está disponible. / This draft is no longer available.");
    return;
  }

  const tenant = getTenant(draft.chatId);
  if (!tenant) return;

  updateDraftPrompt(draftId, prompt);

  try {
    await finishPost(ctx, tenant, draftId, draft.imagePath, prompt);
  } catch (err) {
    log("error", "post_idea_reply_error", {
      chat_id: draft.chatId,
      draft_id: draftId,
      ...errorFields(err),
    });
    await ctx.reply("Algo falló al procesar tu post ⚠️ — inténtalo de nuevo.");
  }
}

/**
 * Shared tail of the /post flow: optional text overlay, copy generation,
 * and the preview message with the action keyboard.
 */
async function finishPost(
  ctx: Context,
  tenant: Tenant,
  draftId: string,
  filename: string,
  prompt: string,
): Promise<void> {
  const chatId = tenant.chatId;
  const loadingMsg = await ctx.reply(pickLoadingLine());
  await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

  try {
    // Overlay text on the photo if the idea asks for it
    const textOverlay = await extractTextOverlay(prompt);
    if (textOverlay) {
      await ctx.api.sendChatAction(chatId, "upload_photo").catch(() => {});
      await addTextToImage(filename, textOverlay.text, textOverlay.style);
    }

    // Generate per-platform copy
    const copyResult = await generateCopy(prompt, tenant.platforms);
    const copyJson = copyResult as Record<string, string>;
    updateDraftCopyJson(draftId, JSON.stringify(copyJson));

    incrementUsage(chatId, todayUtc(), "posts");

    await ctx.api.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    // Send preview: photo + copy + inline keyboard
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

    updateDraftPreviewMsg(draftId, sent.message_id);

    log("info", "post_preview_sent", {
      chat_id: chatId,
      draft_id: draftId,
      platforms: tenant.platforms.join(","),
    });
  } catch (err) {
    await ctx.api.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    throw err;
  }
}
