import { z } from "zod";
import { config } from "../config";
import { log } from "../log";
import type { Platform } from "./publisher/types";

/**
 * Per-platform copy — keys are only the platforms the tenant uses.
 */
export type CopyResult = Partial<Record<Platform, string>>;

const copyResponseSchema = z.record(z.string(), z.string());

/**
 * System prompt that instructs Haiku to produce per-platform copy.
 * Each platform has distinct style rules baked in.
 */
function buildSystemPrompt(platforms: readonly Platform[]): string {
  const rules: string[] = [
    "You are a professional social-media copywriter.",
    "Given a user's caption/idea, produce optimised copy for each requested platform.",
    "Output ONLY a JSON object — no markdown fences, no explanation.",
    "Keys: the platform names provided below. Values: the copy string.",
    "",
    "Per-platform rules:",
  ];

  const platformRules: Record<Platform, string> = {
    instagram:
      "Instagram: hook line first, then body with line breaks for readability, end with 8-15 relevant hashtags. Use emojis naturally.",
    linkedin:
      "LinkedIn: professional and insightful tone, no hashtag spam (3 max), 1300-character sweet spot, open with a strong hook, end with a call-to-action or question.",
    x: "X (Twitter): 280 characters max including any hashtags. Punchy, conversational. One or two hashtags max.",
    facebook:
      "Facebook: conversational and engaging, moderate length, use emojis sparingly, ask a question or include a call-to-action.",
  };

  for (const p of platforms) {
    rules.push(`- ${platformRules[p]}`);
  }

  rules.push(
    "",
    "Language: MIRROR the language of the user's input. If the input is in Spanish, write all copy in Spanish. If English, write in English.",
    "Do NOT translate — match the input language exactly.",
  );

  return rules.join("\n");
}

async function callAnthropic(systemPrompt: string, prompt: string, timeoutMs: number): Promise<string> {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.COPY_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = json.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("No text block in Anthropic response");
  }

  return textBlock.text;
}

async function callDeepseek(systemPrompt: string, prompt: string, timeoutMs: number): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${config.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as any;
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No text content in DeepSeek response");
  }

  return content;
}

/**
 * Call Claude Haiku (or DeepSeek as fallback) to generate per-platform copy from the user's prompt.
 *
 * @param prompt      The user's caption or idea text
 * @param platforms   Which platforms to generate copy for
 * @param retries     Number of retries on transient failure (default 1)
 * @param timeoutMs   Request timeout in ms (default 30 000)
 */
export async function generateCopy(
  prompt: string,
  platforms: readonly Platform[],
  tweakInstruction?: string,
  retries = 1,
  timeoutMs = 30_000,
): Promise<CopyResult> {
  const systemPrompt = buildSystemPrompt(platforms);
  
  const finalPrompt = tweakInstruction 
    ? `Original prompt/idea: ${prompt}\n\nUser tweak instruction: ${tweakInstruction}\n\nPlease regenerate the copy strictly following the new tweak instruction.`
    : prompt;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let rawText: string;
      try {
        rawText = await callAnthropic(systemPrompt, finalPrompt, timeoutMs);
      } catch (anthropicErr) {
        log("warn", "anthropic_failed_fallback_deepseek", {
          error: anthropicErr instanceof Error ? anthropicErr.message : String(anthropicErr),
        });
        rawText = await callDeepseek(systemPrompt, finalPrompt, timeoutMs);
      }

      // Parse the JSON output — strip possible markdown fences
      const raw = rawText
        .replace(/^```json?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();

      const parsed = copyResponseSchema.parse(JSON.parse(raw));

      // Normalize keys to lowercase to protect against LLM capitalization quirks
      const normalizedParsed: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        normalizedParsed[k.toLowerCase()] = v;
      }

      // Filter to only requested platforms
      const result: CopyResult = {};
      for (const p of platforms) {
        const value: string | undefined = normalizedParsed[p];
        if (value !== undefined && value !== null) {
          result[p] = value;
        }
      }

      log("info", "copy_generated", {
        platforms: platforms.join(","),
        prompt_len: prompt.length,
        attempt,
      });

      return result;
    } catch (err) {
      if (attempt < retries) {
        log("warn", "copy_retry", {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      throw err;
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("generateCopy: exhausted retries");
}
