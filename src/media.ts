import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { nanoid } from "nanoid";
import { config } from "./config";
import { log } from "./log";

const MEDIA_DIR = "data/media";
mkdirSync(MEDIA_DIR, { recursive: true });

/** Valid media filename pattern — nanoid chars + known image extension. */
const MEDIA_NAME = /^[a-zA-Z0-9_-]+\.(jpg|png|webp)$/;

/** Generate a unique filename for a new media file. */
export function newMediaFilename(ext: "jpg" | "png" | "webp" = "jpg"): string {
  return `${nanoid(10)}.${ext}`;
}

/** Absolute local path for a media filename. */
export function mediaLocalPath(filename: string): string {
  return join(MEDIA_DIR, filename);
}

/** Public URL for a media file, suitable for passing to external APIs. */
export function mediaPublicUrl(filename: string): string {
  return `${config.PUBLIC_BASE_URL}/media/${filename}`;
}

/**
 * Download a file from a URL and save it to the media directory.
 * Returns the filename on success.
 */
export async function downloadToMedia(
  url: string,
  filename: string,
  timeoutMs = 30_000,
): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await Bun.write(mediaLocalPath(filename), buf);
  return filename;
}

/**
 * Save raw bytes to the media directory.
 * Returns the filename on success.
 */
export async function saveToMedia(
  data: Uint8Array | Buffer,
  filename: string,
): Promise<string> {
  await Bun.write(mediaLocalPath(filename), data);
  return filename;
}

/**
 * Delete a media file by filename. Silent on missing files.
 */
export function deleteMedia(filename: string): void {
  if (!MEDIA_NAME.test(filename)) return;
  try {
    unlinkSync(mediaLocalPath(filename));
  } catch {
    // already gone — fine
  }
}

/**
 * Delete media files older than the configured retention period
 * whose draft is not 'pending'. Called on a timer from index.ts.
 *
 * `isStillPending` receives a filename and returns true if the associated
 * draft is still in 'pending' status (should be kept).
 */
export function cleanupOldMedia(
  isStillPending: (filename: string) => boolean,
): { deleted: number; kept: number } {
  const maxAgeMs = config.MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0;
  let kept = 0;

  let entries: string[];
  try {
    entries = readdirSync(MEDIA_DIR);
  } catch {
    return { deleted: 0, kept: 0 };
  }

  for (const entry of entries) {
    if (!MEDIA_NAME.test(entry)) continue;
    try {
      const st = statSync(mediaLocalPath(entry));
      if (st.mtimeMs < cutoff && !isStillPending(entry)) {
        unlinkSync(mediaLocalPath(entry));
        deleted++;
      } else {
        kept++;
      }
    } catch {
      // stat or unlink failed — skip
    }
  }

  log("info", "media_cleanup", { deleted, kept });
  return { deleted, kept };
}
