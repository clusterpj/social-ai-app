import { z } from "zod";
import { config } from "../config";
import { log } from "../log";
import { getSettings } from "../db";
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
    `The keys in the returned JSON object MUST be exactly from this list (in lowercase): ${platforms.map(p => `"${p}"`).join(", ")}.`,
    "For example, if generating copy for X/Twitter and LinkedIn, the JSON keys must be exactly \"x\" and \"linkedin\". Do not use \"X (Twitter)\" or \"LinkedIn\" as keys.",
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

async function callAnthropic(systemPrompt: string, userPrompt: string, timeoutMs: number): Promise<string> {
  const settings = getSettings();
  if (!settings.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
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

async function callDeepseek(systemPrompt: string, userPrompt: string, timeoutMs: number): Promise<string> {
  const settings = getSettings();
  if (!settings.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
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

async function callOpenRouter(systemPrompt: string, userPrompt: string, timeoutMs: number): Promise<string> {
  const settings = getSettings();
  if (!settings.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.openRouterApiKey}`,
    },
    body: JSON.stringify({
      model: settings.copyModel || "deepseek/deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as any;
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No text content in OpenRouter response");
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
      const settings = getSettings();
      if (settings.openRouterApiKey) {
        rawText = await callOpenRouter(systemPrompt, finalPrompt, timeoutMs);
      } else {
        try {
          rawText = await callAnthropic(systemPrompt, finalPrompt, timeoutMs);
        } catch (anthropicErr) {
          log("warn", "anthropic_failed_fallback_deepseek", {
            error: anthropicErr instanceof Error ? anthropicErr.message : String(anthropicErr),
          });
          rawText = await callDeepseek(systemPrompt, finalPrompt, timeoutMs);
        }
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

/**
 * Enhance the user's raw prompt for the image generator.
 */
export async function enhanceImagePrompt(prompt: string, timeoutMs = 15_000, stripText = false): Promise<string> {
  const settings = getSettings();
  const systemPrompt = settings.copySystemPrompt;

  // When the text will be composited as an overlay afterwards, the diffusion
  // prompt must describe a text-free scene — diffused text spells unreliably.
  const userPrompt = stripText
    ? `${prompt}\n\nIMPORTANT: any promotional text will be composited onto the image afterwards. Your prompt must describe the scene with NO text, words, signs, lettering or typography of any kind, and leave clean space in the lower part of the composition.`
    : prompt;

  try {
    let rawText: string;
    if (settings.openRouterApiKey) {
      rawText = await callOpenRouter(systemPrompt, userPrompt, timeoutMs);
    } else {
      try {
        rawText = await callAnthropic(systemPrompt, userPrompt, timeoutMs);
      } catch (anthropicErr) {
        log("warn", "anthropic_enhance_failed_fallback", {
          error: anthropicErr instanceof Error ? anthropicErr.message : String(anthropicErr),
        });
        rawText = await callDeepseek(systemPrompt, userPrompt, timeoutMs);
      }
    }

    const raw = rawText
      .replace(/^```json?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(raw);
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      throw new Error("LLM did not return a valid prompt string");
    }

    log("info", "prompt_enhanced", { original: prompt, enhanced: parsed.prompt });
    return parsed.prompt;
  } catch (err) {
    log("error", "enhance_prompt_failed", { error: err instanceof Error ? err.message : String(err) });
    // Fallback to original prompt with hardcoded constraints
    return stripText
      ? `${prompt}, clean composition, empty space in the lower third, no text, no lettering`
      : `${prompt}, bold typography if any text, clean composition, NO fine print, NO small text, NO disclaimers`;
  }
}

/**
 * Result of intent detection for text overlays.
 */
export interface TextOverlayIntent {
  text: string;
  style: string | null;
}

/**
 * Check if the user's post idea requests text to be overlaid on the image.
 * Returns the text and requested style, or null if no text is requested.
 */
export async function extractTextOverlay(prompt: string, timeoutMs = 10_000): Promise<TextOverlayIntent | null> {
  const systemPrompt = `You are an intent analyzer. The user is posting a photo to social media with an idea/caption.
Your job is to determine if the user explicitly wants specific promotional text overlaid ON the photo itself.
If they do, extract ONLY the exact short text they want on the image (e.g. "30% OFF", "OPEN NOW").
Also, if they describe a specific visual style for that text (e.g., "made of candy canes", "neon signs"), extract that as the style. If no style is specified, style should be null.
If they do not explicitly ask for text ON the image, return null.

Output ONLY a JSON object with keys "text" (string or null) and "style" (string or null).
Example input: "Post this with a 30% off banner"
Example output: {"text": "30% OFF", "style": null}
Example input: "Add yummy to it in candy canes"
Example output: {"text": "Yummy", "style": "made of candy canes"}
Example input: "Write a nice caption for this tire photo"
Example output: {"text": null, "style": null}`;

  try {
    let rawText: string;
    const settings = getSettings();
    if (settings.openRouterApiKey) {
      rawText = await callOpenRouter(systemPrompt, prompt, timeoutMs);
    } else {
      try {
        rawText = await callAnthropic(systemPrompt, prompt, timeoutMs);
      } catch (anthropicErr) {
        rawText = await callDeepseek(systemPrompt, prompt, timeoutMs);
      }
    }

    const raw = rawText
      .replace(/^```json?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(raw);
    if (parsed.text && typeof parsed.text === "string") {
      log("info", "text_overlay_detected", { original: prompt, intent: parsed });
      return {
        text: parsed.text,
        style: typeof parsed.style === "string" ? parsed.style : null,
      };
    }
    
    return null;
  } catch (err) {
    log("error", "extract_text_overlay_failed", { error: err instanceof Error ? err.message : String(err) });
    return null; // safe fallback
  }
}
