import { config } from "./config";
import { getUsage, todayUtc } from "./db";

export interface LimitCheck {
  allowed: boolean;
  count: number;
  limit: number;
}

export function checkDreamLimit(chatId: number): LimitCheck {
  const usage = getUsage(chatId, todayUtc());
  return {
    allowed: usage.dreams < config.DAILY_DREAM_LIMIT,
    count: usage.dreams,
    limit: config.DAILY_DREAM_LIMIT,
  };
}
