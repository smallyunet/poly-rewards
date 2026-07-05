import type { RewardMarketCandidate, RewardOrderbookSummary, RewardQuotePlan, RewardsDashboardState, RewardRiskTag } from '../../../packages/shared/src';
import type { RewardsAppConfig } from './rewardsConfig';

type RawMarket = Record<string, unknown>;
export type RewardOrderbookProvider = {
  getOrderbook(tokenId: string, label: RewardOrderbookSummary['label']): RewardOrderbookSummary | undefined;
};

export async function runRewardsTick(appConfig: RewardsAppConfig, orderbooks?: RewardOrderbookProvider): Promise<RewardsDashboardState> {
  const updatedAt = new Date().toISOString();
  if (!appConfig.rewards.enabled) {
    return emptyRewardsState(appConfig, 'disabled', updatedAt, ['Rewards scanner is disabled by REWARDS_ENABLED=false.']);
  }

  const diagnostics: string[] = [];
  const rawMarkets = await fetchRewardMarkets(appConfig, diagnostics);
  const limitedMarkets = rawMarkets.slice(0, appConfig.rewards.scannerLimit);
  const candidates = await Promise.all(limitedMarkets.map((market) => buildCandidate(appConfig, market, diagnostics, orderbooks)));
  const ranked = candidates.sort(compareCandidateOpportunity);
  const quotePlans = planQuotes(appConfig, ranked, updatedAt);
  const plannedMarketIds = new Set(quotePlans.filter((plan) => plan.eligible).map((plan) => plan.marketId));

  return {
    status: 'enabled',
    updatedAt,
    config: appConfig.rewards,
    marketsScanned: rawMarkets.length,
    candidates: ranked.slice(0, appConfig.rewards.candidateLimit),
    quotePlans,
    diagnostics,
    totals: {
      plannedMarkets: plannedMarketIds.size,
      plannedOrders: quotePlans.filter((plan) => plan.eligible).length,
      plannedNotional: roundMoney(sum(quotePlans.filter((plan) => plan.eligible).map((plan) => plan.notional))),
      dailyRewardVisible: roundMoney(sum(ranked.map((market) => market.dailyReward))),
      rejectedMarkets: ranked.filter((market) => market.rejectReasons.length > 0).length,
    },
  };
}

async function fetchRewardMarkets(appConfig: RewardsAppConfig, diagnostics: string[]): Promise<RawMarket[]> {
  const endpoints = [
    `${trimSlash(appConfig.clobApiUrl)}/rewards/markets/current`,
    `${trimSlash(appConfig.clobApiUrl)}/rewards/markets/multi`,
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        diagnostics.push(`Reward market fetch failed at ${endpoint}: HTTP ${response.status}.`);
        continue;
      }
      const parsed = await response.json();
      const markets = unwrapMarkets(parsed);
      if (markets.length) return markets;
      diagnostics.push(`Reward market fetch returned no markets at ${endpoint}.`);
    } catch (error) {
      diagnostics.push(`Reward market fetch failed at ${endpoint}: ${errorMessage(error)}.`);
    }
  }
  return [];
}

async function buildCandidate(appConfig: RewardsAppConfig, raw: RawMarket, diagnostics: string[], orderbooks?: RewardOrderbookProvider): Promise<RewardMarketCandidate> {
  const rawConditionId = readString(raw, ['condition_id', 'conditionId']);
  const enriched = rawConditionId ? { ...(await fetchMarketInfo(appConfig, rawConditionId, diagnostics)), ...raw } : raw;
  const id = readString(enriched, ['market', 'market_id', 'marketId', 'id', 'condition_id', 'conditionId']) || `market-${stableHash(JSON.stringify(enriched).slice(0, 500))}`;
  const conditionId = readString(enriched, ['condition_id', 'conditionId']);
  const question = readString(enriched, ['question', 'title', 'market_slug', 'slug']) || id;
  const slug = readString(enriched, ['slug', 'market_slug', 'marketSlug']);
  const category = readString(enriched, ['category', 'categorySlug', 'category_slug', 'tags']);
  const endDate = readString(enriched, ['end_date_iso', 'endDateIso', 'end_date', 'endDate', 'end']) || undefined;
  const active = readBoolean(enriched, ['active'], true);
  const closed = readBoolean(enriched, ['closed', 'resolved'], false);
  const acceptingOrders = readBoolean(enriched, ['accepting_orders', 'acceptingOrders'], true);
  const dailyReward = readNumber(enriched, ['total_daily_rate', 'native_daily_rate', 'daily_reward', 'dailyReward', 'rewards_daily_rate', 'rewardsDailyRate', 'reward', 'rewards']) ?? 0;
  const minSize = readNumber(enriched, ['min_incentive_size', 'rewards_min_size', 'rewardsMinSize', 'minimum_order_size', 'minSize']) ?? 0;
  const maxSpread = readNumber(enriched, ['max_incentive_spread', 'rewards_max_spread', 'rewardsMaxSpread', 'maxSpread']) ?? 0;
  const competitiveness = readNumber(enriched, ['market_competitiveness', 'competitiveness', 'competition']);
  const volume24h = readNumber(enriched, ['volume24hr', 'volume24h', 'volume_24h']);
  const liquidity = readNumber(enriched, ['liquidity', 'liquidityNum']);
  const tokens = readTokens(enriched);
  const [yesOrderbook, noOrderbook] = await Promise.all([
    tokens.find((token) => token.label === 'YES')?.tokenId ? readOrderbook(appConfig, tokens.find((token) => token.label === 'YES')!.tokenId, 'YES', diagnostics, orderbooks) : undefined,
    tokens.find((token) => token.label === 'NO')?.tokenId ? readOrderbook(appConfig, tokens.find((token) => token.label === 'NO')!.tokenId, 'NO', diagnostics, orderbooks) : undefined,
  ]);
  const adjustedMidpoint = adjustedMidpointFromBooks(yesOrderbook, noOrderbook);
  const marketSpread = yesOrderbook?.spread ?? null;
  const quotePreview = previewRewardQuote(appConfig, adjustedMidpoint, marketSpread, normalizeSpread(maxSpread), minSize);
  const estimatedRequiredCapital = quotePreview?.notional ?? minSize;
  const riskTags = riskTagsFor(appConfig, { question, category, endDate, dailyReward, minSize, maxSpread, competitiveness, yesOrderbook, noOrderbook });
  const rejectReasons = rejectReasonsFor(appConfig, { active, closed, acceptingOrders, dailyReward, minSize, maxSpread, endDate, tokens, yesOrderbook, noOrderbook, question, category });
  if (quotePreview && !quotePreview.eligible) rejectReasons.push('reward-sized quote is outside price or incentive-spread limits');
  if (estimatedRequiredCapital > appConfig.rewards.maxMarketNotional) rejectReasons.push('minimum reward-sized quote exceeds per-market notional cap');
  if (estimatedRequiredCapital > appConfig.rewards.maxGlobalNotional) rejectReasons.push('minimum reward-sized quote exceeds global notional cap');
  const rewardScore = dailyReward > 0 ? dailyReward / Math.max(estimatedRequiredCapital, 1) / Math.max(competitiveness ?? 1, 1) : 0;
  const riskScore = riskScoreFor(riskTags, rejectReasons);
  const netScore = rewardScore - riskScore;

  return {
    id,
    conditionId,
    slug,
    question,
    category,
    endDate,
    active,
    closed,
    acceptingOrders,
    dailyReward: roundMoney(dailyReward),
    minSize: roundShares(minSize),
    maxSpread: normalizeSpread(maxSpread),
    competitiveness,
    volume24h,
    liquidity,
    tokens,
    yesOrderbook,
    noOrderbook,
    adjustedMidpoint,
    marketSpread,
    estimatedRequiredCapital: roundMoney(estimatedRequiredCapital),
    rewardScore: roundScore(rewardScore),
    riskScore: roundScore(riskScore),
    netScore: roundScore(netScore),
    riskTags,
    rejectReasons,
    raw: enriched,
  };
}

async function readOrderbook(appConfig: RewardsAppConfig, tokenId: string, label: 'YES' | 'NO', diagnostics: string[], orderbooks?: RewardOrderbookProvider): Promise<RewardOrderbookSummary | undefined> {
  return orderbooks?.getOrderbook(tokenId, label) || fetchOrderbook(appConfig, tokenId, label, diagnostics);
}

async function fetchMarketInfo(appConfig: RewardsAppConfig, conditionId: string, diagnostics: string[]): Promise<RawMarket> {
  try {
    const response = await fetch(`${trimSlash(appConfig.clobApiUrl)}/markets/${encodeURIComponent(conditionId)}`);
    if (!response.ok) {
      diagnostics.push(`Market info fetch failed for ${shortId(conditionId)}: HTTP ${response.status}.`);
      return {};
    }
    const parsed = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    diagnostics.push(`Market info fetch failed for ${shortId(conditionId)}: ${errorMessage(error)}.`);
    return {};
  }
}

async function fetchOrderbook(appConfig: RewardsAppConfig, tokenId: string, label: 'YES' | 'NO', diagnostics: string[]): Promise<RewardOrderbookSummary | undefined> {
  try {
    const response = await fetch(`${trimSlash(appConfig.clobApiUrl)}/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!response.ok) {
      diagnostics.push(`Orderbook fetch failed for ${shortId(tokenId)}: HTTP ${response.status}.`);
      return undefined;
    }
    const raw = await response.json() as RawMarket;
    const bids = readLevels(raw.bids);
    const asks = readLevels(raw.asks);
    const bestBid = bids.length ? Math.max(...bids.map((level) => level.price)) : null;
    const bestAsk = asks.length ? Math.min(...asks.map((level) => level.price)) : null;
    return {
      tokenId,
      label,
      bestBid,
      bestAsk,
      midpoint: bestBid != null && bestAsk != null ? roundPrice((bestBid + bestAsk) / 2) : null,
      spread: bestBid != null && bestAsk != null ? roundPrice(bestAsk - bestBid) : null,
      bidDepth: roundShares(sum(bids.map((level) => level.size))),
      askDepth: roundShares(sum(asks.map((level) => level.size))),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    diagnostics.push(`Orderbook fetch failed for ${shortId(tokenId)}: ${errorMessage(error)}.`);
    return undefined;
  }
}

function planQuotes(appConfig: RewardsAppConfig, candidates: RewardMarketCandidate[], createdAt: string): RewardQuotePlan[] {
  const plans: RewardQuotePlan[] = [];
  let globalNotional = 0;
  let plannedMarkets = 0;
  for (const market of candidates) {
    if (plannedMarkets >= appConfig.rewards.maxOpenMarkets) break;
    if (market.rejectReasons.length > 0 || market.adjustedMidpoint == null) continue;
    const yes = market.tokens.find((token) => token.label === 'YES');
    const no = market.tokens.find((token) => token.label === 'NO');
    if (!yes || !no) continue;
    const size = market.minSize;
    const offset = Math.max(appConfig.rewards.quoteOffset, (market.marketSpread ?? 0) / 2);
    const yesPrice = roundPrice(market.adjustedMidpoint - offset);
    const noPrice = roundPrice(1 - market.adjustedMidpoint - offset);
    const marketPlans = [
      quotePlan(appConfig, market, yes.tokenId, 'YES', yesPrice, size, offset, createdAt),
      quotePlan(appConfig, market, no.tokenId, 'NO', noPrice, size, offset, createdAt),
    ];
    const marketNotional = sum(marketPlans.map((plan) => plan.notional));
    if (marketNotional > appConfig.rewards.maxMarketNotional) continue;
    if (globalNotional + marketNotional > appConfig.rewards.maxGlobalNotional) continue;
    plans.push(...marketPlans);
    globalNotional += marketNotional;
    plannedMarkets += 1;
  }
  return plans;
}

function quotePlan(appConfig: RewardsAppConfig, market: RewardMarketCandidate, tokenId: string, label: 'YES' | 'NO', price: number, size: number, offset: number, createdAt: string): RewardQuotePlan {
  const notional = roundMoney(price * size);
  const eligible = price > 0.01 && price < 0.99 && offset <= Math.max(market.maxSpread, 0);
  return {
    id: `${market.id}:${label}:${createdAt}`,
    marketId: market.id,
    conditionId: market.conditionId,
    tokenId,
    label,
    side: 'BUY',
    price,
    size: roundShares(size),
    notional,
    offset: roundPrice(offset),
    eligible,
    reason: quoteReason(market, size, eligible),
    cancelRepostTriggers: [
      `price drift > max(${appConfig.rewards.maxMidpointDrift}, offset * ${appConfig.rewards.driftOffsetRatio})`,
      `hard order age > ${appConfig.rewards.maxOrderHardAgeSeconds}s`,
      `orderbook age > ${appConfig.rewards.maxOrderbookAgeSeconds}s`,
      'inventory exceeds per-outcome limit',
      'heartbeat or market data is unhealthy',
    ],
    createdAt,
  };
}

function quoteReason(market: RewardMarketCandidate, size: number, eligible: boolean): string {
  if (!eligible) return 'Quote is outside price or incentive-spread limits.';
  return `Quote meets reward min size ${roundShares(market.minSize)} and is inside configured spread, price, and risk limits.`;
}

function readTokens(raw: RawMarket): RewardMarketCandidate['tokens'] {
  const direct = raw.tokens;
  if (Array.isArray(direct)) {
    const tokens = direct.map((item, index) => {
      const obj = typeof item === 'object' && item ? item as RawMarket : {};
      const labelRaw = readString(obj, ['outcome', 'label', 'name']) || (index === 0 ? 'YES' : 'NO');
      const tokenId = readString(obj, ['token_id', 'tokenId', 'asset_id', 'assetId', 'id']);
      const label = /no|down/i.test(labelRaw) ? 'NO' : 'YES';
      return tokenId ? { label, tokenId } : null;
    }).filter((item): item is RewardMarketCandidate['tokens'][number] => Boolean(item));
    if (tokens.length >= 2) return normalizeTokenLabels(tokens);
  }

  const yesTokenId = readString(raw, ['yes_token_id', 'yesTokenId', 'yes_asset_id', 'yesAssetId']);
  const noTokenId = readString(raw, ['no_token_id', 'noTokenId', 'no_asset_id', 'noAssetId']);
  return [
    ...(yesTokenId ? [{ label: 'YES' as const, tokenId: yesTokenId }] : []),
    ...(noTokenId ? [{ label: 'NO' as const, tokenId: noTokenId }] : []),
  ];
}

function normalizeTokenLabels(tokens: RewardMarketCandidate['tokens']): RewardMarketCandidate['tokens'] {
  const yes = tokens.find((token) => token.label === 'YES') || tokens[0];
  const no = tokens.find((token) => token.label === 'NO') || tokens.find((token) => token.tokenId !== yes.tokenId) || tokens[1];
  return [
    { label: 'YES', tokenId: yes.tokenId },
    { label: 'NO', tokenId: no.tokenId },
  ];
}

function riskTagsFor(appConfig: RewardsAppConfig, params: { question: string; category?: string; endDate?: string; dailyReward: number; minSize: number; maxSpread: number; competitiveness: number | null; yesOrderbook?: RewardOrderbookSummary; noOrderbook?: RewardOrderbookSummary }): RewardRiskTag[] {
  const tags: RewardRiskTag[] = [];
  if (params.dailyReward >= appConfig.rewards.minDailyReward) tags.push('good-reward');
  if ((params.competitiveness ?? 1) <= 1.25) tags.push('low-competition');
  if ((params.competitiveness ?? 0) >= 3) tags.push('high-competition');
  if (normalizeSpread(params.maxSpread) >= 0.045) tags.push('wide-incentive-spread');
  if (normalizeSpread(params.maxSpread) > 0 && normalizeSpread(params.maxSpread) <= 0.02) tags.push('tight-incentive-spread');
  if (params.minSize > 0 && params.minSize <= 20) tags.push('low-min-size');
  if (params.minSize >= 50) tags.push('high-min-size');
  if (secondsTo(params.endDate) != null && secondsTo(params.endDate)! < appConfig.rewards.minSecondsToClose) tags.push('near-resolution');
  const text = `${params.question} ${params.category || ''}`.toLowerCase();
  if (/live|in-play/.test(text) && /sport|game|match|cup|nba|nfl|mlb|nhl|soccer|football/.test(text)) tags.push('live-sports');
  if (/crypto|bitcoin|btc|ethereum|eth|solana|sol/.test(text) && /5m|15m|hour|minute/.test(text)) tags.push('crypto-short-duration');
  if (/war|missile|strike|attack|breaking|explosion/.test(text)) tags.push('breaking-news');
  if (/ambiguous|committee|clarif|subject to|according to/.test(text)) tags.push('ambiguous-resolution');
  if (!params.yesOrderbook || !params.noOrderbook) tags.push('missing-orderbook');
  if ((params.yesOrderbook?.bidDepth ?? 0) + (params.yesOrderbook?.askDepth ?? 0) + (params.noOrderbook?.bidDepth ?? 0) + (params.noOrderbook?.askDepth ?? 0) < Math.max(params.minSize, 1) * 4) tags.push('thin-book');
  return tags.length ? tags : ['eligible'];
}

function rejectReasonsFor(appConfig: RewardsAppConfig, params: { active: boolean; closed: boolean; acceptingOrders: boolean; dailyReward: number; minSize: number; maxSpread: number; endDate?: string; tokens: RewardMarketCandidate['tokens']; yesOrderbook?: RewardOrderbookSummary; noOrderbook?: RewardOrderbookSummary; question: string; category?: string }): string[] {
  const reasons: string[] = [];
  if (!params.active) reasons.push('market is not active');
  if (params.closed) reasons.push('market is closed');
  if (!params.acceptingOrders) reasons.push('market is not accepting orders');
  if (params.dailyReward < appConfig.rewards.minDailyReward) reasons.push('daily reward is below threshold');
  if (params.minSize <= 0) reasons.push('missing reward min size');
  if (normalizeSpread(params.maxSpread) <= 0) reasons.push('missing max incentive spread');
  if (secondsTo(params.endDate) != null && secondsTo(params.endDate)! < appConfig.rewards.minSecondsToClose) reasons.push('market is too close to resolution');
  if (params.tokens.length < 2) reasons.push('missing YES/NO token ids');
  if (!params.yesOrderbook || !params.noOrderbook) reasons.push('missing orderbook');
  const text = `${params.question} ${params.category || ''}`.toLowerCase();
  if (appConfig.rewards.blockedCategories.some((category) => params.category?.toLowerCase().includes(category.toLowerCase()))) reasons.push('category is blocked');
  if (appConfig.rewards.blockedKeywords.some((keyword) => text.includes(keyword.toLowerCase()))) reasons.push('keyword risk block');
  return reasons;
}

function riskScoreFor(tags: RewardRiskTag[], rejectReasons: string[]): number {
  const weights: Partial<Record<RewardRiskTag, number>> = {
    'high-competition': 1.5,
    'tight-incentive-spread': 1,
    'high-min-size': 1,
    'near-resolution': 3,
    'live-sports': 3,
    'crypto-short-duration': 3,
    'breaking-news': 3,
    'ambiguous-resolution': 2,
    'missing-orderbook': 2,
    'stale-orderbook': 1,
    'thin-book': 1,
  };
  return sum(tags.map((tag) => weights[tag] ?? 0)) + rejectReasons.length * 2;
}

function compareCandidateOpportunity(a: RewardMarketCandidate, b: RewardMarketCandidate): number {
  const aActionable = isActionableCandidate(a);
  const bActionable = isActionableCandidate(b);
  if (aActionable !== bActionable) return aActionable ? -1 : 1;

  if (!aActionable && !bActionable) {
    const reasonDelta = a.rejectReasons.length - b.rejectReasons.length;
    if (reasonDelta !== 0) return reasonDelta;
    const capitalDelta = a.estimatedRequiredCapital - b.estimatedRequiredCapital;
    if (capitalDelta !== 0) return capitalDelta;
  }

  const scoreDelta = b.netScore - a.netScore;
  if (scoreDelta !== 0) return scoreDelta;
  const capitalDelta = a.estimatedRequiredCapital - b.estimatedRequiredCapital;
  if (capitalDelta !== 0) return capitalDelta;
  return b.dailyReward - a.dailyReward;
}

function isActionableCandidate(candidate: RewardMarketCandidate): boolean {
  return candidate.rejectReasons.length === 0 && candidate.adjustedMidpoint != null;
}

function previewRewardQuote(appConfig: RewardsAppConfig, midpoint: number | null, marketSpread: number | null, maxSpread: number, shares: number): { yesPrice: number; noPrice: number; notional: number; eligible: boolean } | null {
  if (midpoint == null) return null;
  const offset = Math.max(appConfig.rewards.quoteOffset, (marketSpread ?? 0) / 2);
  const yesPrice = roundPrice(midpoint - offset);
  const noPrice = roundPrice(1 - midpoint - offset);
  return {
    yesPrice,
    noPrice,
    notional: roundMoney(shares * (yesPrice + noPrice)),
    eligible: yesPrice > 0.01 && yesPrice < 0.99 && noPrice > 0.01 && noPrice < 0.99 && offset <= Math.max(maxSpread, 0),
  };
}

function adjustedMidpointFromBooks(yes?: RewardOrderbookSummary, no?: RewardOrderbookSummary): number | null {
  if (yes?.midpoint != null) return yes.midpoint;
  if (no?.midpoint != null) return roundPrice(1 - no.midpoint);
  if (yes?.bestBid != null && no?.bestBid != null) return roundPrice((yes.bestBid + (1 - no.bestBid)) / 2);
  return null;
}

function unwrapMarkets(parsed: unknown): RawMarket[] {
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return [];
  for (const key of ['markets', 'data', 'results']) {
    const value = parsed[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function readLevels(value: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) return null;
    const price = Number(item.price);
    const size = Number(item.size);
    return Number.isFinite(price) && Number.isFinite(size) ? { price, size } : null;
  }).filter((item): item is { price: number; size: number } => Boolean(item));
}

function readString(raw: RawMarket, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.join(', ');
  }
  return undefined;
}

function readNumber(raw: RawMarket, keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(raw: RawMarket, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
      if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
    }
  }
  return fallback;
}

function normalizeSpread(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? roundPrice(value / 100) : roundPrice(value);
}

function secondsTo(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function emptyRewardsState(appConfig: RewardsAppConfig, status: RewardsDashboardState['status'], updatedAt: string, diagnostics: string[]): RewardsDashboardState {
  return {
    status,
    updatedAt,
    config: appConfig.rewards,
    marketsScanned: 0,
    candidates: [],
    quotePlans: [],
    diagnostics,
    totals: {
      plannedMarkets: 0,
      plannedOrders: 0,
      plannedNotional: 0,
      dailyRewardVisible: 0,
      rejectedMarkets: 0,
    },
  };
}

function isRecord(value: unknown): value is RawMarket {
  return typeof value === 'object' && value !== null;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundShares(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function stableHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}
