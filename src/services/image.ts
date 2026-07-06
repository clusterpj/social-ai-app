import { fal } from "@fal-ai/client";
import { config } from "../config";
import { log } from "../log";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { downloadToMedia, newMediaFilename } from "../media";
import { enhanceImagePrompt, extractTextOverlay } from "./copy";
import { getSettings, type AppSettings } from "../db";
import sharp from "sharp";

/** fal.subscribe can't take an AbortSignal — race it against a timer instead. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ]);
}

const FLUX_SIZE_BY_ASPECT: Record<string, string> = {
  "1:1": "square_hd",
  "4:3": "landscape_4_3",
  "3:4": "portrait_4_3",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
};

/** Build the model-family-specific input payload (verified against fal.ai API docs). */
function buildImageInput(
  model: string,
  prompt: string,
  settings: AppSettings,
): Record<string, unknown> {
  if (model.includes("nano-banana")) {
    return {
      prompt,
      aspect_ratio: settings.imageAspect,
      resolution: "1K",
      output_format: "jpeg",
      num_images: 1,
    };
  }
  // FLUX family (and other flux-style endpoints)
  const input: Record<string, unknown> = {
    prompt,
    image_size: FLUX_SIZE_BY_ASPECT[settings.imageAspect] ?? "square_hd",
    guidance_scale: settings.fluxGuidanceScale,
    num_images: 1,
    enable_safety_checker: true,
    output_format: "jpeg",
    sync_mode: false,
  };
  // FLUX.1 endpoints accept step count; FLUX.2 ones reject unknown params
  if (model.startsWith("fal-ai/flux/")) {
    input.num_inference_steps = settings.fluxInferenceSteps;
  }
  return input;
}

/**
 * Call fal.ai to generate an image using Flux, then download it locally.
 *
 * @param prompt    The user's dream prompt
 * @param timeoutMs Request timeout in ms (default 60 000)
 * @returns         The local filename of the downloaded image
 */
export async function generateImage(
  prompt: string,
  timeoutMs = 60_000,
): Promise<string> {
  const filename = newMediaFilename("jpg");
  
  log("info", "image_generation_started", { prompt_len: prompt.length });

  // If the user asked for text ON the image, route to the typography-capable
  // model and have the enhancer spec the exact text + treatment in the prompt.
  const overlay = await extractTextOverlay(prompt, Math.min(timeoutMs, 10_000));
  const enhancedPrompt = await enhanceImagePrompt(prompt, Math.min(timeoutMs, 15_000), overlay?.text ?? null);

  // Composite fallback — only used by the stub/dev path below; the real
  // models render the text themselves.
  const applyOverlay = async (): Promise<string> => {
    if (overlay) {
      try {
        await addTextToImage(filename, overlay.text, overlay.style, timeoutMs);
      } catch (err) {
        // A missing overlay is visible in the preview; better than failing the dream.
        log("warn", "overlay_composite_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return filename;
  };

  const settings = getSettings();
  fal.config({ credentials: settings.falKey });

  // Fallback for local development if FAL_KEY is not set
  if (!settings.falKey || settings.falKey === "stub") {
    let usedComfyUI = false;

    // Try to use local ComfyUI if workflow exists
    const workflowPath = join(process.cwd(), "data", "comfyui_flux_api.json");
    if (existsSync(workflowPath)) {
      try {
        // Ping ComfyUI
        const ping = await fetch(`${config.COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(2000) });
        if (ping.ok) {
          log("info", "using_comfyui", { url: config.COMFYUI_URL });
          const workflow = JSON.parse(readFileSync(workflowPath, "utf-8"));
          
          // Inject prompt into node "6" (CLIPTextEncode)
          if (workflow["6"] && workflow["6"].inputs) {
            workflow["6"].inputs.text = enhancedPrompt;
          }

          // Randomize seed
          if (workflow["13"] && workflow["13"].inputs) {
            workflow["13"].inputs.seed = Math.floor(Math.random() * 1000000000);
          }

          const res = await fetch(`${config.COMFYUI_URL}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: workflow }),
            signal: AbortSignal.timeout(5000),
          });
          const { prompt_id } = await res.json() as any;

          // Poll history for completion (max 60 seconds)
          let comfyFilename: string | null = null;
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            const histRes = await fetch(`${config.COMFYUI_URL}/history/${prompt_id}`);
            const histJson = await histRes.json() as any;
            if (histJson[prompt_id]) {
              const outputs = histJson[prompt_id].outputs;
              if (outputs && outputs["9"] && outputs["9"].images && outputs["9"].images.length > 0) {
                comfyFilename = outputs["9"].images[0].filename;
                break;
              }
            }
          }

          if (!comfyFilename) {
            throw new Error("ComfyUI generation timed out or failed to produce output");
          }

          const viewUrl = `${config.COMFYUI_URL}/view?filename=${encodeURIComponent(comfyFilename)}&type=output`;
          await downloadToMedia(viewUrl, filename, timeoutMs);
          usedComfyUI = true;
          log("info", "comfyui_generation_success", { prompt_id, filename });
        }
      } catch (err) {
        log("warn", "comfyui_generation_failed", { error: String(err) });
      }
    }

    if (!usedComfyUI) {
      log("info", "using_placeholder_fallback", { prompt });
      // Use a random placeholder image
      const url = `https://picsum.photos/seed/${encodeURIComponent(prompt.slice(0, 20))}/800/600.jpg`;
      await downloadToMedia(url, filename, timeoutMs);
    }

    return applyOverlay();
  }

  const model = overlay ? settings.textImageModel : settings.imageModel;

  const fetchTask = fal.subscribe(model, {
    input: buildImageInput(model, enhancedPrompt, settings),
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS" && update.logs) {
        update.logs.forEach((logEntry) => {
          log("info", "fal_log", { msg: logEntry.message });
        });
      }
    },
  });

  const timeoutTask = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Image generation timed out")), timeoutMs);
  });

  try {
    const result = await Promise.race([fetchTask, timeoutTask]);
    
    // The response has a data property if using new client.
    // Let's coerce to any to handle the shape.
    const res = result as any;
    
    const imageUrl = res.data?.images?.[0]?.url || res.images?.[0]?.url;
    if (!imageUrl) {
      throw new Error(`No image URL returned from fal.ai. Response: ${JSON.stringify(res)}`);
    }

    log("info", "image_generated", { url: imageUrl, model });

    // Download the image locally
    await downloadToMedia(imageUrl, filename, timeoutMs);

    // The typography model rendered any requested text — no composite needed.
    return filename;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "image_generation_failed", { error: message });
    throw err;
  }
}

/**
 * Add text to an existing image, styled to match the photo.
 * Preferred path: one instruction-following edit call (imageEditModel).
 * Fallback: deterministic SVG banner composite — always spells correctly.
 * Overwrites the local file.
 */
export async function addTextToImage(
  filename: string,
  text: string,
  style: string | null = null,
  timeoutMs = 60_000,
): Promise<void> {
  log("info", "add_text_to_image_started", { filename, text, style });

  const localPath = join(process.cwd(), "data", "media", filename);
  if (!existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`);
  }

  const settings = getSettings();

  if (settings.falKey && settings.falKey !== "stub") {
    try {
      fal.config({ credentials: settings.falKey });

      const bytes = await Bun.file(localPath).arrayBuffer();
      const uploadUrl = await withTimeout(
        fal.storage.upload(new File([bytes], filename, { type: "image/jpeg" })),
        timeoutMs,
        "Image upload",
      );

      const treatment = style
        ? `styled as ${style}`
        : "as bold, clean promotional typography that matches the photo's lighting and style";
      const editPrompt =
        `Add the text "${text}" to this photo, ${treatment}. ` +
        `Place it prominently without covering the main subject and keep everything else in the photo unchanged. ` +
        `The text must read exactly "${text}" — no other text anywhere.`;

      const res: any = await withTimeout(
        fal.subscribe(settings.imageEditModel, {
          input: { prompt: editPrompt, image_urls: [uploadUrl], output_format: "jpeg" },
        }),
        timeoutMs,
        "Image text edit",
      );

      const editedUrl = res.data?.images?.[0]?.url || res.images?.[0]?.url;
      if (!editedUrl) {
        throw new Error("No image returned from edit model");
      }

      const dl = await fetch(editedUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!dl.ok) throw new Error(`Edited image download failed: ${dl.status}`);
      await Bun.write(localPath, Buffer.from(await dl.arrayBuffer()));

      log("info", "text_edit_completed", { filename, model: settings.imageEditModel });
      return;
    } catch (err) {
      log("warn", "ai_text_edit_failed_fallback_svg", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Deterministic SVG banner fallback
  try {
    log("info", "generating_svg_text_overlay", { text });

    const metadata = await sharp(localPath).metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 600;

    const escaped = text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

    const bannerHeight = Math.floor(height * 0.2);
    // ponytail: ~0.55em avg bold-sans glyph width; swap for real text measuring if it ever misfits
    const fontSize = Math.min(
      Math.floor(bannerHeight * 0.6),
      Math.floor((width * 0.9) / (Math.max(1, text.length) * 0.55)),
    );

    const svgText = `
      <svg width="${width}" height="${height}">
        <style>
          .title { fill: white; font-size: ${fontSize}px; font-weight: bold; font-family: sans-serif; }
          .bg { fill: rgba(0,0,0,0.6); }
        </style>
        <rect x="0" y="${height - bannerHeight}" width="${width}" height="${bannerHeight}" class="bg" />
        <text x="50%" y="${height - (bannerHeight / 2) + (fontSize * 0.35)}" text-anchor="middle" class="title">${escaped}</text>
      </svg>
    `;

    const outputBuffer = await sharp(localPath)
      .composite([{ input: Buffer.from(svgText), gravity: "south" }])
      .toBuffer();

    await Bun.write(localPath, outputBuffer);

    log("info", "text_overlay_completed", { filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "add_text_to_image_failed", { error: message });
    throw err;
  }
}
