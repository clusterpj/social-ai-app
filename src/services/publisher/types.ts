export const PLATFORMS = ["instagram", "linkedin", "x", "facebook"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface PlatformResult {
  platform: Platform;
  ok: boolean;
  postId?: string;
  url?: string;
  error?: string;
}

export interface SocialAccount {
  id: string;
  platform: Platform;
  name: string;
}

export type PublishResult =
  | { ok: true; results: PlatformResult[] }
  | { ok: false; error: string };

export interface PublishAdapter {
  publish(input: {
    accountIds: string[];
    content: Record<string, string>; // platform → copy
    mediaUrls: string[];
  }): Promise<PublishResult>;
  listAccounts(): Promise<SocialAccount[]>; // powers /status
}
