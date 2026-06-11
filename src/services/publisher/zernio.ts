import { z } from "zod";
import { config } from "../../config";
import { log } from "../../log";
import type {
  PublishAdapter,
  PublishResult,
  PlatformResult,
  SocialAccount,
  Platform,
} from "./types";

const BASE_URL = "https://zernio.com/api/v1";

/**
 * Zernio API response schemas — validated with Zod.
 * Only shapes we actually use are modelled.
 */

const zernioPostPlatformResult = z.object({
  platform: z.string(),
  accountId: z.any().optional(),
  status: z.string().optional(),
  platformPostUrl: z.string().optional(),
  platformPostId: z.string().optional(),
  error: z.string().optional(),
});

const zernioCreatePostResponse = z.object({
  post: z
    .object({
      _id: z.string(),
      platforms: z.array(zernioPostPlatformResult).optional(),
    })
    .optional(),
  existingPost: z
    .object({
      _id: z.string(),
    })
    .optional(),
});

const zernioAccountSchema = z.object({
  _id: z.string(),
  platform: z.string(),
  name: z.string().optional(),
  username: z.string().optional(),
});

const zernioListAccountsResponse = z.object({
  accounts: z.array(zernioAccountSchema),
});

/** Shared fetch helper with timeout + one retry. */
async function zernioFetch(
  path: string,
  init: RequestInit,
  retries = 1,
  timeoutMs = 30_000,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.ZERNIO_API_KEY}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res;
    } catch (err) {
      if (attempt < retries) {
        log("warn", "zernio_retry", {
          path,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      throw err;
    }
  }
  throw new Error("zernioFetch: exhausted retries");
}

/**
 * The ONLY file that knows Zernio exists.
 * Implements the PublishAdapter interface against https://docs.zernio.com.
 */
export const zernioAdapter: PublishAdapter = {
  async publish(input): Promise<PublishResult> {
    const { accountIds, content, mediaUrls } = input;

    // Build per-platform entries for the Zernio platforms array.
    // Each accountId maps 1:1 to an entry; copy comes from `content` keyed by platform name.
    // We need to resolve accountId → platform, but in our data model the tenant record
    // stores both accountIds and platforms arrays in parallel, so the caller already has them.
    // We'll pass customContent for each platform entry.
    const platforms: Array<{
      platform: string;
      accountId: string;
      customContent?: string;
    }> = accountIds.map((id) => ({ platform: "", accountId: id }));

    // The content record keys are platform names → copy. We assign customContent per accountId.
    // Since the plan stores accountIds + platforms in parallel arrays, we resolve by matching.
    // For now, use a single `content` field (Zernio supports a top-level `content` that applies
    // to all platforms that lack customContent) and set customContent on each entry.
    const platformEntries: Array<{
      platform: string;
      accountId: string;
      customContent?: string;
    }> = [];

    // content is Record<platform, copy>. We need to match these to accountIds.
    // The tenant's accountIds and platforms arrays are parallel — but at this adapter level
    // we just receive accountIds. We'll set platform in the Zernio payload from the content keys.
    const platformNames = Object.keys(content) as Platform[];
    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i];
      // Match accountId positionally to platform name (parallel arrays from tenant record)
      const platformName = platformNames[i];
      if (accountId === undefined) continue;
      platformEntries.push({
        platform: platformName ?? "unknown",
        accountId,
        customContent: platformName ? content[platformName] : undefined,
      });
    }

    const body: Record<string, unknown> = {
      publishNow: true,
      platforms: platformEntries,
    };

    // If there are media URLs, attach them
    if (mediaUrls.length > 0) {
      body.mediaItems = mediaUrls.map((url) => ({ url }));
    }

    console.log("Publishing to Zernio with body:", JSON.stringify(body, null, 2));

    try {
      const res = await zernioFetch("/posts", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        log("error", "zernio_publish_failed", {
          status: res.status,
          body: text.slice(0, 300),
        });
        return { ok: false, error: `Zernio ${res.status}: ${text.slice(0, 200)}` };
      }

      const json = zernioCreatePostResponse.parse(await res.json());

      const results: PlatformResult[] = (
        json.post?.platforms ?? []
      ).map((p) => ({
        platform: p.platform as Platform,
        ok: p.status !== "failed",
        postId: p.platformPostId,
        url: p.platformPostUrl,
        error: p.error,
      }));

      log("info", "zernio_published", {
        post_id: json.post?._id,
        platforms: results.map((r) => r.platform).join(","),
      });

      return { ok: true, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "zernio_publish_error", { error: message });
      return { ok: false, error: message };
    }
  },

  async listAccounts(): Promise<SocialAccount[]> {
    try {
      const res = await zernioFetch("/accounts", { method: "GET" });

      if (!res.ok) {
        log("warn", "zernio_list_accounts_failed", { status: res.status });
        return [];
      }

      const json = zernioListAccountsResponse.parse(await res.json());

      return json.accounts.map((a) => ({
        id: a._id,
        platform: a.platform as Platform,
        name: a.name ?? a.username ?? a._id,
      }));
    } catch (err) {
      log("error", "zernio_list_accounts_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  },
};
