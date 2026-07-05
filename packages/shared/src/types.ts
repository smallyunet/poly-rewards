export type TradeSide = 'BUY' | 'SELL';

export type RuntimeLogRecord = {
  id: string;
  level: 'info' | 'warn' | 'error';
  source: 'worker' | 'api' | 'execution' | 'market-data' | 'operator';
  message: string;
  createdAt: string;
  details?: unknown;
};

export type RewardsExecutionMode = 'monitor' | 'live';

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
  side: TradeSide;
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
  minDailyReward: number;
  minSecondsToClose: number;
  maxGlobalNotional: number;
  maxMarketNotional: number;
  maxOpenMarkets: number;
  maxMidpointDrift: number;
  driftOffsetRatio: number;
  maxOrderAgeSeconds: number;
  maxOrderHardAgeSeconds: number;
  maxOrderbookAgeSeconds: number;
  maxInventorySharesPerOutcome: number;
  maxQueueShare: number;
  minSideDepthMultiplier: number;
  minAskDepthMultiplier: number;
  inventoryExitEnabled: boolean;
  maxUnhedgedInventoryAgeSeconds: number;
  maxInventoryLossPerShare: number;
  minInventoryExitShares: number;
  minCollateralBalance: number;
  maxActiveOrdersPerMarket: number;
  blockedCategories: string[];
  blockedKeywords: string[];
};

export type RewardManagedOrder = {
  orderId: string;
  planId: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  label: 'YES' | 'NO';
  side: TradeSide;
  price: number;
  size: number;
  filledSize: number;
  remainingSize: number | null;
  notional: number;
  status: 'posted' | 'open' | 'cancelled' | 'filled' | 'expired' | 'terminal' | 'unknown';
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  raw?: unknown;
};

export type RewardExecutionEvent = {
  id: string;
  createdAt: string;
  level: 'info' | 'warn' | 'error';
  action: 'skip' | 'post' | 'cancel' | 'reconcile' | 'error';
  marketId?: string;
  tokenId?: string;
  orderId?: string;
  message: string;
  details?: unknown;
};

export type RewardFillRecord = {
  id: string;
  orderId: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  label: 'YES' | 'NO';
  side: TradeSide;
  price: number;
  size: number;
  notional: number;
  source: 'open_order_match' | 'terminal_reconcile';
  createdAt: string;
};

export type RewardInventorySummary = {
  tokenId: string;
  label: 'YES' | 'NO';
  marketId: string;
  conditionId?: string;
  filledSize: number;
  openBuySize: number;
  avgEntryPrice: number | null;
  costBasis: number;
};

export type RewardExecutionState = {
  mode: RewardsExecutionMode;
  enabled: boolean;
  updatedAt?: string;
  dryRun: boolean;
  collateralBalance?: number;
  collateralAllowance?: number | null;
  persistencePath?: string;
  activeOrders: RewardManagedOrder[];
  recentFills: RewardFillRecord[];
  inventory: RewardInventorySummary[];
  recentEvents: RewardExecutionEvent[];
  totals: {
    activeOrders: number;
    activeNotional: number;
    filledSize: number;
    filledCostBasis: number;
    postedThisTick: number;
    cancelledThisTick: number;
    skippedThisTick: number;
    fillsThisTick: number;
  };
};

export type RewardsRuntimeStatus = {
  status: 'running' | 'degraded';
  executionMode: RewardsExecutionMode;
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
  execution?: RewardExecutionState;
  runtimeLogs: RuntimeLogRecord[];
};
