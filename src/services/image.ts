import { fal } from "@fal-ai/client";
import { config } from "../config";
import { log } from "../log";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { downloadToMedia, newMediaFilename } from "../media";
import { enhanceImagePrompt } from "./copy";
import { getSettings } from "../db";
import sharp from "sharp";



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

  const enhancedPrompt = await enhanceImagePrompt(prompt, Math.min(timeoutMs, 15_000));

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
    
    return filename;
  }

  // Currently we use fal.subscribe to poll for the result.
  // The SDK internally handles timeouts, but we can't easily pass AbortSignal.
  // We'll wrap it in a timeout locally just in case.
  // We'll wrap it in a timeout locally just in case.

  const fetchTask = fal.subscribe(settings.fluxModel, {
    input: {
      prompt: enhancedPrompt,
      image_size: "landscape_4_3",
      num_inference_steps: settings.fluxInferenceSteps,
      guidance_scale: settings.fluxGuidanceScale,
      num_images: 1,
      enable_safety_checker: true,
      sync_mode: false,
    },
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

    log("info", "image_generated", { url: imageUrl });

    // Download the image locally
    await downloadToMedia(imageUrl, filename, timeoutMs);

    return filename;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "image_generation_failed", { error: message });
    throw err;
  }
}

/**
 * Add a true graphic overlay to an existing image.
 * Uses AI stylization if a style is requested.
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

  try {
    let overlayBuffer: Buffer;
    const settings = getSettings();
    fal.config({ credentials: settings.falKey });

    if (style && settings.falKey && settings.falKey !== "stub") {
      log("info", "generating_ai_styled_text", { text, style });
      
      // 1. Generate text image
      const textPrompt = `3D typography, the exact word '${text}' constructed entirely out of ${style}, hyper-realistic, isolated on a pure white background.`;
      const genRes: any = await fal.subscribe(settings.fluxModel, {
        input: { prompt: textPrompt, image_size: "landscape_4_3" },
      });
      const generatedImageUrl = genRes.data?.images?.[0]?.url || genRes.images?.[0]?.url;

      if (!generatedImageUrl) {
        throw new Error("Failed to generate styled text");
      }

      log("info", "removing_background", { url: generatedImageUrl });

      // 2. Remove background
      const rmbgRes: any = await fal.subscribe("fal-ai/bria/background/remove", {
        input: { image_url: generatedImageUrl },
      });
      const transparentUrl = rmbgRes.image?.url || rmbgRes.data?.image?.url;

      if (!transparentUrl) {
        throw new Error("Failed to remove background");
      }

      // 3. Download the transparent PNG overlay
      const overlayReq = await fetch(transparentUrl);
      overlayBuffer = Buffer.from(await overlayReq.arrayBuffer());
    } else {
      // Deterministic SVG fallback
      log("info", "generating_svg_text_overlay", { text });
      
      // We need the dimensions of the original image
      const metadata = await sharp(localPath).metadata();
      const width = metadata.width || 800;
      const height = metadata.height || 600;
      
      const bannerHeight = Math.floor(height * 0.2);
      const fontSize = Math.floor(bannerHeight * 0.6);
      
      const svgText = `
        <svg width="${width}" height="${height}">
          <style>
            .title { fill: white; font-size: ${fontSize}px; font-weight: bold; font-family: sans-serif; }
            .bg { fill: rgba(0,0,0,0.6); }
          </style>
          <rect x="0" y="${height - bannerHeight}" width="${width}" height="${bannerHeight}" class="bg" />
          <text x="50%" y="${height - (bannerHeight / 2) + (fontSize * 0.35)}" text-anchor="middle" class="title">${text}</text>
        </svg>
      `;
      overlayBuffer = Buffer.from(svgText);
    }

    // 4. Composite the overlay onto the original image
    log("info", "compositing_overlay", { filename });
    
    const originalImage = sharp(localPath);
    const metadata = await originalImage.metadata();
    const originalWidth = metadata.width || 800;
    
    if (style && settings.falKey && settings.falKey !== "stub") {
      // For AI overlays, we want to trim the empty space and resize it
      // to fit nicely at the bottom (e.g. 80% of the original width)
      const targetWidth = Math.floor(originalWidth * 0.8);
      
      overlayBuffer = await sharp(overlayBuffer)
        .trim() // Removes the transparent background padding
        .resize({ width: targetWidth })
        .toBuffer();
    }
    
    // We output to a temporary buffer first
    const outputBuffer = await originalImage
      .composite([{ input: overlayBuffer, gravity: 'south' }])
      .toBuffer();

    // 5. Overwrite the original file
    await Bun.write(localPath, outputBuffer);
    
    log("info", "text_overlay_completed", { filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "add_text_to_image_failed", { error: message });
    throw err;
  }
}
