import { z } from "zod";

export const VERSION = "0.1.0";

const cleanString = z.string().transform((s) => {
  const hashIdx = s.indexOf("#");
  return (hashIdx === -1 ? s : s.slice(0, hashIdx)).trim();
});

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: cleanString.pipe(z.string().min(1, "required")),
  TELEGRAM_WEBHOOK_SECRET: cleanString.pipe(
    z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, "expected 16-256 chars of [A-Za-z0-9_-]"),
  ),
  ALLOWED_CHAT_IDS: cleanString
    .pipe(z.string().min(1, "required"))
    .transform((raw) => raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))
    .pipe(
      z
        .array(z.string().regex(/^-?\d+$/, "chat_id must be an integer").transform(Number))
        .min(1),
    ),
  PUBLIC_BASE_URL: cleanString.pipe(z.string().url()).transform((u) => u.replace(/\/+$/, "")),
  PORT: z.coerce.number().int().positive().default(3000),
  ANTHROPIC_API_KEY: cleanString.default(""),
  DEEPSEEK_API_KEY: cleanString.default(""),
  OPENROUTER_API_KEY: cleanString.default(""),
  COPY_MODEL: cleanString.default("deepseek/deepseek-chat"),
  FAL_KEY: cleanString.default(""),
  FLUX_MODEL: cleanString.default("fal-ai/flux/dev"),
  COMFYUI_URL: cleanString.pipe(z.string().url()).default("http://127.0.0.1:8188"),
  ZERNIO_API_KEY: cleanString.pipe(z.string().min(1, "required")),
  DAILY_DREAM_LIMIT: z.coerce.number().int().positive().default(20),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  ADMIN_PASSWORD: cleanString.default("admin"),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report only field names and messages — never values.
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    process.stderr.write(`Invalid environment:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
