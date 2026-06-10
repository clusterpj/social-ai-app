import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { PLATFORMS, type Platform } from "./services/publisher/types";
import { log } from "./log";

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
