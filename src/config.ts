import { z } from "zod";

export const VERSION = "0.1.0";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "required"),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, "expected 16-256 chars of [A-Za-z0-9_-]"),
  ALLOWED_CHAT_IDS: z
    .string()
    .min(1, "required")
    .transform((raw) => raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))
    .pipe(
      z
        .array(z.string().regex(/^-?\d+$/, "chat_id must be an integer").transform(Number))
        .min(1),
    ),
  PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  PORT: z.coerce.number().int().positive().default(3000),
  ANTHROPIC_API_KEY: z.string().min(1, "required"),
  COPY_MODEL: z.string().default("claude-haiku-4-5"),
  FAL_KEY: z.string().min(1, "required"),
  FLUX_MODEL: z.string().default("fal-ai/flux/dev"),
  ZERNIO_API_KEY: z.string().min(1, "required"),
  DAILY_DREAM_LIMIT: z.coerce.number().int().positive().default(20),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
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
