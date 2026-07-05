import { z } from 'zod';

export const rewardsRuntimeConfigSchema = z.object({
  enabled: z.boolean(),
  scannerLimit: z.number().int().positive(),
  candidateLimit: z.number().int().positive(),
  quoteSize: z.number().positive(),
  quoteOffset: z.number().nonnegative(),
  minDailyReward: z.number().nonnegative(),
  minSecondsToClose: z.number().int().nonnegative(),
  maxGlobalNotional: z.number().positive(),
  maxMarketNotional: z.number().positive(),
  maxOpenMarkets: z.number().int().positive(),
  maxMidpointDrift: z.number().nonnegative(),
  maxOrderAgeSeconds: z.number().int().positive(),
  maxOrderbookAgeSeconds: z.number().positive(),
  liveWhitelistOnly: z.boolean(),
  whitelistedMarketIds: z.array(z.string()),
  blockedCategories: z.array(z.string()),
  blockedKeywords: z.array(z.string()),
});
