import 'dotenv/config';
import path from 'node:path';

import type { RewardsExecutionMode, RewardsRuntimeConfig } from '../../../packages/shared/src';

export type RewardsAppConfig = {
  port: number;
  dashboardInternalApiKey?: string;
  executionMode: RewardsExecutionMode;
  clobApiUrl: string;
  clobWsUrl: string;
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
    executionMode: executionModeEnv(process.env.EXECUTION_MODE),
    clobApiUrl: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
    clobWsUrl: process.env.POLYMARKET_CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
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
    minDailyReward: numberEnv('REWARDS_MIN_DAILY_REWARD', 1),
    minSecondsToClose: parsePositiveInteger(process.env.REWARDS_MIN_SECONDS_TO_CLOSE, 24 * 60 * 60),
    maxGlobalNotional: numberEnv('REWARDS_GLOBAL_MAX_NOTIONAL', 100),
    maxMarketNotional: numberEnv('REWARDS_MARKET_MAX_NOTIONAL', 10),
    maxOpenMarkets: parsePositiveInteger(process.env.REWARDS_MAX_OPEN_MARKETS, 10),
    maxMidpointDrift: numberEnv('REWARDS_MAX_MIDPOINT_DRIFT', 0.015),
    driftOffsetRatio: numberEnv('REWARDS_DRIFT_OFFSET_RATIO', 0.5),
    maxOrderAgeSeconds: parsePositiveInteger(process.env.REWARDS_MAX_ORDER_AGE_SECONDS, 600),
    maxOrderHardAgeSeconds: parsePositiveInteger(process.env.REWARDS_MAX_ORDER_HARD_AGE_SECONDS, 1_800),
    maxOrderbookAgeSeconds: numberEnv('REWARDS_MAX_ORDERBOOK_AGE_SECONDS', 5),
    maxInventorySharesPerOutcome: numberEnv('REWARDS_MAX_INVENTORY_SHARES_PER_OUTCOME', 20),
    maxQueueShare: numberEnv('REWARDS_MAX_QUEUE_SHARE', 0.25),
    minSideDepthMultiplier: numberEnv('REWARDS_MIN_SIDE_DEPTH_MULTIPLIER', 4),
    minAskDepthMultiplier: numberEnv('REWARDS_MIN_ASK_DEPTH_MULTIPLIER', 1),
    inventoryExitEnabled: booleanEnv('REWARDS_INVENTORY_EXIT_ENABLED', true),
    maxUnhedgedInventoryAgeSeconds: parsePositiveInteger(process.env.REWARDS_MAX_UNHEDGED_INVENTORY_AGE_SECONDS, 600),
    maxInventoryLossPerShare: numberEnv('REWARDS_MAX_INVENTORY_LOSS_PER_SHARE', 0.05),
    minInventoryExitShares: numberEnv('REWARDS_MIN_INVENTORY_EXIT_SHARES', 1),
    minCollateralBalance: numberEnv('REWARDS_MIN_COLLATERAL_BALANCE', 5),
    maxActiveOrdersPerMarket: parsePositiveInteger(process.env.REWARDS_MAX_ACTIVE_ORDERS_PER_MARKET, 2),
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

function executionModeEnv(value: string | undefined): RewardsExecutionMode {
  return value?.trim().toLowerCase() === 'live' ? 'live' : 'monitor';
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
