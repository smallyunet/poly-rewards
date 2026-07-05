export type TradeSide = 'BUY' | 'SELL';

export type RuntimeLogRecord = {
  id: string;
  level: 'info' | 'warn' | 'error';
  source: 'worker' | 'api' | 'execution' | 'market-data' | 'operator';
  message: string;
  createdAt: string;
  details?: unknown;
};

export type RewardRiskTag =
  | 'good-reward'
  | 'low-competition'
  | 'high-competition'
  | 'wide-incentive-spread'
  | 'tight-incentive-spread'
  | 'low-min-size'
  | 'high-min-size'
  | 'near-resolution'
  | 'live-sports'
  | 'crypto-short-duration'
  | 'breaking-news'
  | 'ambiguous-resolution'
  | 'missing-orderbook'
  | 'stale-orderbook'
  | 'thin-book'
  | 'eligible'
  | 'rejected';

export type RewardOutcomeToken = {
  label: 'YES' | 'NO';
  tokenId: string;
};

export type RewardOrderbookSummary = {
  tokenId: string;
  label: 'YES' | 'NO';
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  bidDepth: number;
  askDepth: number;
  updatedAt: string;
};

export type RewardMarketCandidate = {
  id: string;
  conditionId?: string;
  slug?: string;
  question: string;
  category?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  dailyReward: number;
  minSize: number;
  maxSpread: number;
  competitiveness: number | null;
  volume24h: number | null;
  liquidity: number | null;
  tokens: RewardOutcomeToken[];
  yesOrderbook?: RewardOrderbookSummary;
  noOrderbook?: RewardOrderbookSummary;
  adjustedMidpoint: number | null;
  marketSpread: number | null;
  estimatedRequiredCapital: number;
  rewardScore: number;
  riskScore: number;
  netScore: number;
  riskTags: RewardRiskTag[];
  rejectReasons: string[];
  raw?: unknown;
};

export type RewardQuotePlan = {
  id: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  label: 'YES' | 'NO';
  side: 'BUY';
  price: number;
  size: number;
  notional: number;
  offset: number;
  eligible: boolean;
  reason: string;
  cancelRepostTriggers: string[];
  createdAt: string;
};

export type RewardsRuntimeConfig = {
  enabled: boolean;
  scannerLimit: number;
  candidateLimit: number;
  quoteSize: number;
  quoteOffset: number;
  minDailyReward: number;
  minSecondsToClose: number;
  maxGlobalNotional: number;
  maxMarketNotional: number;
  maxOpenMarkets: number;
  maxMidpointDrift: number;
  maxOrderAgeSeconds: number;
  maxOrderbookAgeSeconds: number;
  liveWhitelistOnly: boolean;
  whitelistedMarketIds: string[];
  blockedCategories: string[];
  blockedKeywords: string[];
};

export type RewardsRuntimeStatus = {
  status: 'running' | 'degraded';
  executionMode: 'monitor';
  startedAt: string;
  lastTickAt?: string;
  nextTickAt?: string;
  tickIntervalMs: number;
  version: string;
  buildSha?: string;
  buildTime?: string;
  dockerReady: boolean;
  strategy: 'polymarket_rewards_market_making';
};

export type RewardsDashboardState = {
  status: 'enabled' | 'disabled' | 'unavailable';
  updatedAt: string;
  config: RewardsRuntimeConfig;
  marketsScanned: number;
  candidates: RewardMarketCandidate[];
  quotePlans: RewardQuotePlan[];
  diagnostics: string[];
  totals: {
    plannedMarkets: number;
    plannedOrders: number;
    plannedNotional: number;
    dailyRewardVisible: number;
    rejectedMarkets: number;
  };
};

export type RewardsAppState = {
  runtime: RewardsRuntimeStatus;
  rewards?: RewardsDashboardState;
  runtimeLogs: RuntimeLogRecord[];
};
