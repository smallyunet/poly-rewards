import 'dotenv/config';
import path from 'node:path';

import type { RewardsRuntimeConfig } from '../../../packages/shared/src';

export type RewardsAppConfig = {
  port: number;
  dashboardInternalApiKey?: string;
  clobApiUrl: string;
  gammaApiUrl: string;
  dataApiUrl: string;
  chainId: number;
  ownerPrivateKey?: string;
  depositWallet?: string;
  tickIntervalMs: number;
  runtimeStatePath: string;
  runtimeMaxRecords: number;
  rewards: RewardsRuntimeConfig;
};

export function loadRewardsAppConfig(): RewardsAppConfig {
  return {
    port: Number(process.env.PORT || 8798),
    dashboardInternalApiKey: process.env.DASHBOARD_INTERNAL_API_KEY,
    clobApiUrl: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
    gammaApiUrl: process.env.POLYMARKET_GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    dataApiUrl: process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com',
    chainId: Number(process.env.POLYMARKET_CHAIN_ID || 137),
    ownerPrivateKey: process.env.OWNER_PRIVATE_KEY,
    depositWallet: process.env.POLYMARKET_DEPOSIT_WALLET,
    tickIntervalMs: parsePositiveInteger(process.env.BOT_TICK_MS, 10_000),
    runtimeStatePath: process.env.RUNTIME_STATE_PATH || path.resolve(process.cwd(), 'data/runtime-state.json'),
    runtimeMaxRecords: parsePositiveInteger(process.env.RUNTIME_MAX_RECORDS, 1_000),
    rewards: loadRewardsRuntimeConfig(),
  };
}

function loadRewardsRuntimeConfig(): RewardsRuntimeConfig {
  return {
    enabled: booleanEnv('REWARDS_ENABLED', true),
    scannerLimit: parsePositiveInteger(process.env.REWARDS_SCANNER_LIMIT, 80),
    candidateLimit: parsePositiveInteger(process.env.REWARDS_CANDIDATE_LIMIT, 12),
    quoteSize: numberEnv('REWARDS_QUOTE_SIZE', 5),
    quoteOffset: numberEnv('REWARDS_QUOTE_OFFSET', 0.015),
    minDailyReward: numberEnv('REWARDS_MIN_DAILY_REWARD', 1),
    minSecondsToClose: parsePositiveInteger(process.env.REWARDS_MIN_SECONDS_TO_CLOSE, 24 * 60 * 60),
    maxGlobalNotional: numberEnv('REWARDS_GLOBAL_MAX_NOTIONAL', 100),
    maxMarketNotional: numberEnv('REWARDS_MARKET_MAX_NOTIONAL', 10),
    maxOpenMarkets: parsePositiveInteger(process.env.REWARDS_MAX_OPEN_MARKETS, 10),
    maxMidpointDrift: numberEnv('REWARDS_MAX_MIDPOINT_DRIFT', 0.015),
    maxOrderAgeSeconds: parsePositiveInteger(process.env.REWARDS_MAX_ORDER_AGE_SECONDS, 60),
    maxOrderbookAgeSeconds: numberEnv('REWARDS_MAX_ORDERBOOK_AGE_SECONDS', 5),
    liveWhitelistOnly: booleanEnv('REWARDS_LIVE_WHITELIST_ONLY', true),
    whitelistedMarketIds: csvEnv('REWARDS_WHITELIST_MARKET_IDS'),
    blockedCategories: csvEnv('REWARDS_BLOCKED_CATEGORIES', ['crypto', 'geopolitics']),
    blockedKeywords: csvEnv('REWARDS_BLOCKED_KEYWORDS', [
      '5m',
      '15m',
      'live',
      'in-play',
      'missile',
      'strike',
      'war',
      'attack',
      'breaking',
    ]),
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function csvEnv(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}
