import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { PLATFORMS, type Platform } from "./services/publisher/types";
import { log } from "./log";
import { config } from "./config";

const MIGRATIONS: readonly string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS tenants (
    chat_id      INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    account_ids  TEXT NOT NULL,
    platforms    TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drafts (
    id           TEXT PRIMARY KEY,
    chat_id      INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    image_path   TEXT,
    copy_json    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    preview_msg  INTEGER,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS usage (
    chat_id      INTEGER NOT NULL,
    day          TEXT NOT NULL,
    dreams       INTEGER NOT NULL DEFAULT 0,
    posts        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, day)
  );
  `,
  // v2 - settings schema
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v3 - model split: retire fluxModel; drop the old tag-soup enhancer prompt
  // (identified by its 'Masterpiece' quality tags) so the new default applies.
  `
  DELETE FROM settings WHERE key = 'fluxModel';
  DELETE FROM settings WHERE key = 'copySystemPrompt' AND value LIKE '%Masterpiece%';
  `,
];

mkdirSync("data/media", { recursive: true });

export const db = new Database("data/app.db", { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
migrate(db);

function migrate(database: Database): void {
  const row = database
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (sql === undefined) continue;
    database.transaction(() => {
      database.exec(sql);
      database.exec(`PRAGMA user_version = ${v + 1}`);
    })();
    log("info", "db_migrated", { to_version: v + 1 });
  }
}

export interface Tenant {
  chatId: number;
  name: string;
  accountIds: string[];
  platforms: Platform[];
  createdAt: number;
}

const jsonStringArray = z
  .string()
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string()));

const tenantRowSchema = z.object({
  chat_id: z.number().int(),
  name: z.string(),
  account_ids: jsonStringArray,
  platforms: jsonStringArray.pipe(z.array(z.enum(PLATFORMS))),
  created_at: z.number().int(),
});

export function getTenant(chatId: number): Tenant | null {
  const row = db
    .query("SELECT * FROM tenants WHERE chat_id = ?1")
    .get(chatId);
  if (row === null) return null;
  const t = tenantRowSchema.parse(row);
  return {
    chatId: t.chat_id,
    name: t.name,
    accountIds: t.account_ids,
    platforms: t.platforms,
    createdAt: t.created_at,
  };
}

export interface DailyUsage {
  dreams: number;
  posts: number;
}

export function getUsage(chatId: number, day: string): DailyUsage {
  const row = db
    .query<{ dreams: number; posts: number }, [number, string]>(
      "SELECT dreams, posts FROM usage WHERE chat_id = ?1 AND day = ?2",
    )
    .get(chatId, day);
  return row ?? { dreams: 0, posts: 0 };
}

/** YYYY-MM-DD in UTC — the key used by the usage table. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dbHealthy(): boolean {
  try {
    db.query("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Draft CRUD
// ---------------------------------------------------------------------------

export type DraftKind = "post" | "dream";
export type DraftStatus = "pending" | "published" | "failed" | "cancelled";

export interface Draft {
  id: string;
  chatId: number;
  kind: DraftKind;
  prompt: string;
  imagePath: string | null;
  copyJson: string; // JSON string of Record<Platform, string>
  status: DraftStatus;
  previewMsg: number | null;
  error: string | null;
  createdAt: number;
  publishedAt: number | null;
}

export function insertDraft(draft: {
  id: string;
  chatId: number;
  kind: DraftKind;
  prompt: string;
  imagePath: string | null;
  copyJson: string;
}): void {
  db.run(
    `INSERT INTO drafts (id, chat_id, kind, prompt, image_path, copy_json, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`,
    [
      draft.id,
      draft.chatId,
      draft.kind,
      draft.prompt,
      draft.imagePath,
      draft.copyJson,
      Date.now(),
    ],
  );
}

export function getDraft(id: string): Draft | null {
  const row = db
    .query<
      {
        id: string;
        chat_id: number;
        kind: string;
        prompt: string;
        image_path: string | null;
        copy_json: string;
        status: string;
        preview_msg: number | null;
        error: string | null;
        created_at: number;
        published_at: number | null;
      },
      [string]
    >("SELECT * FROM drafts WHERE id = ?1")
    .get(id);
  if (row === null) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    kind: row.kind as DraftKind,
    prompt: row.prompt,
    imagePath: row.image_path,
    copyJson: row.copy_json,
    status: row.status as DraftStatus,
    previewMsg: row.preview_msg,
    error: row.error,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

export function updateDraftStatus(
  id: string,
  status: DraftStatus,
  extra?: { error?: string; publishedAt?: number },
): void {
  if (extra?.error !== undefined) {
    db.run(
      "UPDATE drafts SET status = ?1, error = ?2 WHERE id = ?3",
      [status, extra.error, id],
    );
  } else if (extra?.publishedAt !== undefined) {
    db.run(
      "UPDATE drafts SET status = ?1, published_at = ?2 WHERE id = ?3",
      [status, extra.publishedAt, id],
    );
  } else {
    db.run("UPDATE drafts SET status = ?1 WHERE id = ?2", [status, id]);
  }
}

export function updateDraftCopyJson(id: string, copyJson: string): void {
  db.run("UPDATE drafts SET copy_json = ?1 WHERE id = ?2", [copyJson, id]);
}

export function updateDraftPrompt(id: string, prompt: string): void {
  db.run("UPDATE drafts SET prompt = ?1 WHERE id = ?2", [prompt, id]);
}

export function updateDraftImagePath(id: string, imagePath: string): void {
  db.run("UPDATE drafts SET image_path = ?1 WHERE id = ?2", [imagePath, id]);
}

export function updateDraftPreviewMsg(id: string, messageId: number): void {
  db.run("UPDATE drafts SET preview_msg = ?1 WHERE id = ?2", [messageId, id]);
}

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

export function incrementUsage(
  chatId: number,
  day: string,
  field: "dreams" | "posts",
): void {
  db.run(
    `INSERT INTO usage (chat_id, day, ${field})
     VALUES (?1, ?2, 1)
     ON CONFLICT(chat_id, day) DO UPDATE SET ${field} = ${field} + 1`,
    [chatId, day],
  );
}

// ---------------------------------------------------------------------------
// Media cleanup support
// ---------------------------------------------------------------------------

/**
 * Returns true if `filename` belongs to a draft still in 'pending' status.
 * Used by the media cleanup routine to avoid deleting files the user hasn't
 * acted on yet.
 */
export function isMediaPending(filename: string): boolean {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM drafts WHERE image_path = ?1 AND status = 'pending'",
    )
    .get(filename);
  return row !== null;
}

// ---------------------------------------------------------------------------
// Settings CRUD
// ---------------------------------------------------------------------------

export interface AppSettings {
  allowedChatIds: string;
  fluxInferenceSteps: number;
  fluxGuidanceScale: number;
  copySystemPrompt: string;
  openRouterApiKey: string;
  anthropicApiKey: string;
  deepseekApiKey: string;
  falKey: string;
  zernioApiKey: string;
  copyModel: string;
  imageModel: string;
  textImageModel: string;
  imageEditModel: string;
  imageAspect: string;
  brandStyle: string;
}

const defaultSettings = {
  fluxInferenceSteps: 35,
  fluxGuidanceScale: 3.5,
  imageModel: "fal-ai/flux-2/turbo",
  textImageModel: "fal-ai/nano-banana-2",
  imageEditModel: "fal-ai/nano-banana-2/edit",
  imageAspect: "1:1",
  brandStyle: "",
  copySystemPrompt: `You are an art director writing prompts for a modern AI image generator (FLUX.2 / Nano Banana).
Rewrite the user's idea as ONE vivid, natural-language paragraph, covering in order:
subject & action, setting, composition & framing, lighting, color palette & mood, and photographic or illustration style.
Write like you are briefing a photographer — plain descriptive sentences. NO keyword lists, NO quality tags like "8k", "masterpiece" or "ultra-detailed".
If a brand style is provided, weave it in naturally.
If the request includes exact text that must appear on the image, include that text in double quotes with a specific typographic treatment and placement (e.g. a bold condensed sans-serif banner across the lower third reading "30% OFF") and state that no other text, fine print or lettering appears anywhere.
If no text is requested, state that the image contains no text or lettering.

Output ONLY a JSON object with a single key "prompt".`
};

export function getSettings(): AppSettings {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
  const map = new Map(rows.map(r => [r.key, r.value]));
  
  return {
    allowedChatIds: map.get("allowedChatIds") ?? config.ALLOWED_CHAT_IDS.join(","),
    fluxInferenceSteps: map.has("fluxInferenceSteps") ? Number(map.get("fluxInferenceSteps")) : defaultSettings.fluxInferenceSteps,
    fluxGuidanceScale: map.has("fluxGuidanceScale") ? Number(map.get("fluxGuidanceScale")) : defaultSettings.fluxGuidanceScale,
    copySystemPrompt: map.get("copySystemPrompt") ?? defaultSettings.copySystemPrompt,
    openRouterApiKey: map.get("openRouterApiKey") ?? config.OPENROUTER_API_KEY,
    anthropicApiKey: map.get("anthropicApiKey") ?? config.ANTHROPIC_API_KEY,
    deepseekApiKey: map.get("deepseekApiKey") ?? config.DEEPSEEK_API_KEY,
    falKey: map.get("falKey") ?? config.FAL_KEY,
    zernioApiKey: map.get("zernioApiKey") ?? config.ZERNIO_API_KEY,
    copyModel: map.get("copyModel") ?? config.COPY_MODEL,
    imageModel: map.get("imageModel") ?? defaultSettings.imageModel,
    textImageModel: map.get("textImageModel") ?? defaultSettings.textImageModel,
    imageEditModel: map.get("imageEditModel") ?? defaultSettings.imageEditModel,
    imageAspect: map.get("imageAspect") ?? defaultSettings.imageAspect,
    brandStyle: map.get("brandStyle") ?? defaultSettings.brandStyle,
  };
}

export function updateSettings(settings: Partial<AppSettings>): void {
  const update = db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2");
  db.transaction(() => {
    if (settings.allowedChatIds !== undefined) update.run("allowedChatIds", settings.allowedChatIds);
    if (settings.fluxInferenceSteps !== undefined) update.run("fluxInferenceSteps", String(settings.fluxInferenceSteps));
    if (settings.fluxGuidanceScale !== undefined) update.run("fluxGuidanceScale", String(settings.fluxGuidanceScale));
    if (settings.copySystemPrompt !== undefined) update.run("copySystemPrompt", settings.copySystemPrompt);
    if (settings.openRouterApiKey !== undefined) update.run("openRouterApiKey", settings.openRouterApiKey);
    if (settings.anthropicApiKey !== undefined) update.run("anthropicApiKey", settings.anthropicApiKey);
    if (settings.deepseekApiKey !== undefined) update.run("deepseekApiKey", settings.deepseekApiKey);
    if (settings.falKey !== undefined) update.run("falKey", settings.falKey);
    if (settings.zernioApiKey !== undefined) update.run("zernioApiKey", settings.zernioApiKey);
    if (settings.copyModel !== undefined) update.run("copyModel", settings.copyModel);
    if (settings.imageModel !== undefined) update.run("imageModel", settings.imageModel);
    if (settings.textImageModel !== undefined) update.run("textImageModel", settings.textImageModel);
    if (settings.imageEditModel !== undefined) update.run("imageEditModel", settings.imageEditModel);
    if (settings.imageAspect !== undefined) update.run("imageAspect", settings.imageAspect);
    if (settings.brandStyle !== undefined) update.run("brandStyle", settings.brandStyle);
  })();
}

