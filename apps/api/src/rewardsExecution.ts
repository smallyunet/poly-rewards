import fs from 'node:fs';
import path from 'node:path';

import type {
  RewardExecutionEvent,
  RewardExecutionState,
  RewardFillRecord,
  RewardInventorySummary,
  RewardManagedOrder,
  RewardQuotePlan,
  RewardsDashboardState,
} from '../../../packages/shared/src';
import { PolymarketAdapter, type LimitOrderResult, type OpenOrderSummary, type RewardLimitIntent } from '../../../packages/polymarket/src';
import type { RewardsAppConfig } from './rewardsConfig';

type RewardsExecutionClient = Pick<PolymarketAdapter, 'executeRewardLimitIntent' | 'getOpenOrders' | 'cancelOrders' | 'getAvailableShares' | 'getCollateralBalanceAllowance'>;

type TickCounters = {
  postedThisTick: number;
  cancelledThisTick: number;
  skippedThisTick: number;
  fillsThisTick: number;
};

const ACTIVE_ORDER_STATUSES = new Set(['', 'open', 'live', 'matched', 'partially_filled', 'posted']);
const MAX_PERSISTED_RECORDS = 500;

type PersistedExecutionData = {
  version: 1;
  managedOrders: RewardManagedOrder[];
  events: RewardExecutionEvent[];
  fills: RewardFillRecord[];
  updatedAt: string;
};

export class RewardsExecutionService {
  private readonly managedOrders = new Map<string, RewardManagedOrder>();
  private readonly events: RewardExecutionEvent[] = [];
  private readonly fills: RewardFillRecord[] = [];
  private readonly persistencePath: string;

  constructor(
    private readonly appConfig: RewardsAppConfig,
    private readonly client: RewardsExecutionClient = new PolymarketAdapter(appConfig),
    persistencePath = appConfig.runtimeStatePath,
  ) {
    this.persistencePath = persistencePath;
    this.loadPersistedState();
  }

  async reconcile(snapshot: RewardsDashboardState): Promise<RewardExecutionState> {
    const counters: TickCounters = { postedThisTick: 0, cancelledThisTick: 0, skippedThisTick: 0, fillsThisTick: 0 };
    const now = new Date().toISOString();

    if (this.appConfig.executionMode !== 'live') {
      const state = this.state(now, counters, undefined, undefined);
      this.persistState(now);
      return state;
    }

    if (!this.hasExecutionCredentials()) {
      this.event('error', 'skip', 'Live execution is disabled because OWNER_PRIVATE_KEY or POLYMARKET_DEPOSIT_WALLET is missing.');
      counters.skippedThisTick += snapshot.quotePlans.filter((plan) => plan.eligible).length;
      const state = this.state(now, counters, undefined, undefined);
      this.persistState(now);
      return state;
    }

    try {
      const [openOrders, collateral] = await Promise.all([
        this.client.getOpenOrders(),
        this.client.getCollateralBalanceAllowance(),
      ]);
      this.reconcileManagedOrderStatuses(openOrders, counters, now);
      await this.cancelUnsafeManagedOrders(snapshot, openOrders, counters, now);
      await this.postMissingQuotes(snapshot, openOrders, collateral.balance, counters, now);
      const state = this.state(now, counters, collateral.balance, collateral.allowance);
      this.persistState(now);
      return state;
    } catch (error) {
      this.event('error', 'error', `Live execution reconciliation failed: ${errorMessage(error)}.`);
      const state = this.state(now, counters, undefined, undefined);
      this.persistState(now);
      return state;
    }
  }

  private async cancelUnsafeManagedOrders(snapshot: RewardsDashboardState, openOrders: OpenOrderSummary[], counters: TickCounters, now: string): Promise<void> {
    const plansByToken = new Map(snapshot.quotePlans.filter((plan) => plan.eligible).map((plan) => [plan.tokenId, plan]));
    const staleTokenIds = staleOrderbookTokenIds(snapshot, this.appConfig.rewards.maxOrderbookAgeSeconds);
    const openById = new Map(openOrders.map((order) => [order.id, order]));
    const cancelIds: string[] = [];

    for (const order of this.managedOrders.values()) {
      if (!isActiveManagedOrder(order)) continue;
      if (!openById.has(order.orderId)) continue;

      const currentPlan = plansByToken.get(order.tokenId);
      const ageSeconds = (Date.now() - new Date(order.createdAt).getTime()) / 1000;
      const priceDrift = currentPlan ? Math.abs(currentPlan.price - order.price) : Number.POSITIVE_INFINITY;
      const shouldCancel =
        !currentPlan ||
        ageSeconds > this.appConfig.rewards.maxOrderAgeSeconds ||
        priceDrift > this.appConfig.rewards.maxMidpointDrift ||
        staleTokenIds.has(order.tokenId);

      if (shouldCancel) cancelIds.push(order.orderId);
    }

    if (!cancelIds.length) return;
    await this.client.cancelOrders(cancelIds);
    counters.cancelledThisTick += cancelIds.length;
    for (const orderId of cancelIds) {
      const order = this.managedOrders.get(orderId);
      if (!order) continue;
      this.managedOrders.set(orderId, { ...order, status: 'cancelled', remainingSize: 0, updatedAt: now });
      this.event('info', 'cancel', `Cancelled managed order ${shortId(orderId)} for refresh or risk control.`, {
        orderId,
        marketId: order.marketId,
        tokenId: order.tokenId,
      });
    }
  }

  private async postMissingQuotes(snapshot: RewardsDashboardState, openOrders: OpenOrderSummary[], collateralBalance: number, counters: TickCounters, now: string): Promise<void> {
    let availableCollateral = collateralBalance;
    const activeManaged = () => Array.from(this.managedOrders.values()).filter(isActiveManagedOrder);

    for (const plan of snapshot.quotePlans.filter((item) => item.eligible)) {
      if (availableCollateral - plan.notional < this.appConfig.rewards.minCollateralBalance) {
        counters.skippedThisTick += 1;
        this.event('warn', 'skip', `Skipped ${plan.label} quote because collateral would fall below the configured reserve.`, {
          ...planEventDetails(plan),
          collateralBalance: availableCollateral,
          minCollateralBalance: this.appConfig.rewards.minCollateralBalance,
        });
        continue;
      }

      if (activeManaged().filter((order) => order.marketId === plan.marketId).length >= this.appConfig.rewards.maxActiveOrdersPerMarket) {
        counters.skippedThisTick += 1;
        this.event('warn', 'skip', `Skipped ${plan.label} quote because the market already has the maximum active managed orders.`, planEventDetails(plan));
        continue;
      }

      if (hasComparableOpenOrder(plan, openOrders) || activeManaged().some((order) => order.tokenId === plan.tokenId && order.side === plan.side)) {
        counters.skippedThisTick += 1;
        this.event('info', 'skip', `Skipped ${plan.label} quote because an open order already exists on this token.`, planEventDetails(plan));
        continue;
      }

      const inventory = await this.client.getAvailableShares(plan.tokenId);
      if (inventory + plan.size > this.appConfig.rewards.maxInventorySharesPerOutcome) {
        counters.skippedThisTick += 1;
        this.event('warn', 'skip', `Skipped ${plan.label} quote because outcome inventory would exceed the configured cap.`, {
          ...planEventDetails(plan),
          inventory,
          maxInventorySharesPerOutcome: this.appConfig.rewards.maxInventorySharesPerOutcome,
        });
        continue;
      }

      const result = await this.client.executeRewardLimitIntent(toIntent(plan), { execute: true, orderType: 'GTC' });
      if (!result.ok || !result.orderId) {
        counters.skippedThisTick += 1;
        this.event('error', 'error', `Failed to post ${plan.label} quote: ${result.error || 'missing order id'}.`, {
          ...planEventDetails(plan),
          result,
        });
        continue;
      }

      this.recordPostedOrder(plan, result, now);
      openOrders.push(toOpenOrderSummary(plan, result));
      availableCollateral -= plan.notional;
      counters.postedThisTick += 1;
      this.event('info', 'post', `Posted ${plan.label} BUY quote at ${plan.price.toFixed(3)}.`, {
        ...planEventDetails(plan),
        orderId: result.orderId,
      });
    }
  }

  private reconcileManagedOrderStatuses(openOrders: OpenOrderSummary[], counters: TickCounters, now: string): void {
    const openById = new Map(openOrders.map((order) => [order.id, order]));
    for (const [orderId, managed] of this.managedOrders.entries()) {
      const open = openById.get(orderId);
      if (!open) {
        if (isActiveManagedOrder(managed)) {
          const terminalFillSize = Math.max(managed.size - managed.filledSize, 0);
          if (terminalFillSize > 0) {
            this.recordFill(managed, terminalFillSize, 'terminal_reconcile', now);
            counters.fillsThisTick += 1;
          }
          this.managedOrders.set(orderId, {
            ...managed,
            status: terminalFillSize > 0 ? 'filled' : 'terminal',
            filledSize: roundShares(managed.filledSize + terminalFillSize),
            remainingSize: 0,
            updatedAt: now,
            lastCheckedAt: now,
          });
          this.event('info', 'reconcile', `Managed order ${shortId(orderId)} is no longer open; recorded terminal reconciliation.`, {
            orderId,
            marketId: managed.marketId,
            tokenId: managed.tokenId,
            terminalFillSize,
          });
        }
        continue;
      }

      const remainingSize = remainingOrderSize(open);
      const matchedSize = open.sizeMatched == null ? managed.filledSize : Math.max(open.sizeMatched, managed.filledSize);
      const fillDelta = Math.max(matchedSize - managed.filledSize, 0);
      if (fillDelta > 0) {
        this.recordFill(managed, fillDelta, 'open_order_match', now);
        counters.fillsThisTick += 1;
      }
      this.managedOrders.set(orderId, {
        ...managed,
        status: normalizeOrderStatus(open.status),
        filledSize: roundShares(matchedSize),
        remainingSize,
        updatedAt: now,
        lastCheckedAt: now,
        raw: open.raw,
      });
    }
  }

  private recordPostedOrder(plan: RewardQuotePlan, result: LimitOrderResult, now: string): void {
    if (!result.orderId) return;
    this.managedOrders.set(result.orderId, {
      orderId: result.orderId,
      planId: plan.id,
      marketId: plan.marketId,
      conditionId: plan.conditionId,
      tokenId: plan.tokenId,
      label: plan.label,
      side: plan.side,
      price: plan.price,
      size: result.size,
      filledSize: 0,
      remainingSize: result.size,
      notional: plan.notional,
      status: 'posted',
      createdAt: now,
      updatedAt: now,
      raw: result.raw,
    });
  }

  private hasExecutionCredentials(): boolean {
    return Boolean(this.appConfig.ownerPrivateKey?.trim() && this.appConfig.depositWallet?.trim());
  }

  private state(updatedAt: string, counters: TickCounters, collateralBalance: number | undefined, collateralAllowance: number | null | undefined): RewardExecutionState {
    const activeOrders = Array.from(this.managedOrders.values()).filter(isActiveManagedOrder);
    const allOrders = Array.from(this.managedOrders.values());
    const filledCostBasis = roundMoney(this.fills.reduce((total, fill) => total + fill.notional, 0));
    return {
      mode: this.appConfig.executionMode,
      enabled: this.appConfig.executionMode === 'live',
      updatedAt,
      dryRun: this.appConfig.executionMode !== 'live',
      collateralBalance,
      collateralAllowance,
      persistencePath: this.persistencePath,
      activeOrders,
      recentFills: this.fills.slice(0, 50),
      inventory: inventorySummary(allOrders, this.fills),
      recentEvents: this.events.slice(0, 50),
      totals: {
        activeOrders: activeOrders.length,
        activeNotional: roundMoney(activeOrders.reduce((total, order) => total + order.price * (order.remainingSize ?? order.size), 0)),
        filledSize: roundShares(this.fills.reduce((total, fill) => total + fill.size, 0)),
        filledCostBasis,
        postedThisTick: counters.postedThisTick,
        cancelledThisTick: counters.cancelledThisTick,
        skippedThisTick: counters.skippedThisTick,
        fillsThisTick: counters.fillsThisTick,
      },
    };
  }

  private recordFill(order: RewardManagedOrder, size: number, source: RewardFillRecord['source'], now: string): void {
    const fillSize = roundShares(size);
    if (fillSize <= 0) return;
    this.fills.unshift({
      id: `fill-${order.orderId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      orderId: order.orderId,
      marketId: order.marketId,
      conditionId: order.conditionId,
      tokenId: order.tokenId,
      label: order.label,
      side: order.side,
      price: order.price,
      size: fillSize,
      notional: roundMoney(fillSize * order.price),
      source,
      createdAt: now,
    });
    this.fills.splice(MAX_PERSISTED_RECORDS);
  }

  private event(level: RewardExecutionEvent['level'], action: RewardExecutionEvent['action'], message: string, details?: unknown): void {
    this.events.unshift({
      id: `exec-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      level,
      action,
      marketId: isPlanDetails(details) ? details.marketId : undefined,
      tokenId: isPlanDetails(details) ? details.tokenId : undefined,
      orderId: isPlanDetails(details) ? details.orderId : undefined,
      message,
      details,
    });
    this.events.splice(50);
  }

  private loadPersistedState(): void {
    try {
      if (!fs.existsSync(this.persistencePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.persistencePath, 'utf8')) as Partial<PersistedExecutionData>;
      for (const order of Array.isArray(parsed.managedOrders) ? parsed.managedOrders : []) {
        if (!order?.orderId) continue;
        this.managedOrders.set(order.orderId, {
          ...order,
          filledSize: typeof order.filledSize === 'number' ? order.filledSize : inferredFilledSize(order),
        });
      }
      this.events.push(...(Array.isArray(parsed.events) ? parsed.events : []).slice(0, MAX_PERSISTED_RECORDS));
      this.fills.push(...(Array.isArray(parsed.fills) ? parsed.fills : []).slice(0, MAX_PERSISTED_RECORDS));
      if (this.managedOrders.size || this.fills.length) {
        this.event('info', 'reconcile', `Restored ${this.managedOrders.size} managed orders and ${this.fills.length} fill records from persisted execution state.`);
      }
    } catch (error) {
      this.event('error', 'error', `Failed to load persisted execution state: ${errorMessage(error)}.`);
    }
  }

  private persistState(updatedAt: string): void {
    try {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      const payload: PersistedExecutionData = {
        version: 1,
        managedOrders: Array.from(this.managedOrders.values()).slice(-MAX_PERSISTED_RECORDS),
        events: this.events.slice(0, MAX_PERSISTED_RECORDS),
        fills: this.fills.slice(0, MAX_PERSISTED_RECORDS),
        updatedAt,
      };
      const tmpPath = `${this.persistencePath}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
      fs.renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      this.event('error', 'error', `Failed to persist execution state: ${errorMessage(error)}.`);
    }
  }
}

function staleOrderbookTokenIds(snapshot: RewardsDashboardState, maxAgeSeconds: number): Set<string> {
  const stale = new Set<string>();
  const now = Date.now();
  for (const market of snapshot.candidates) {
    for (const book of [market.yesOrderbook, market.noOrderbook]) {
      if (!book) continue;
      const ageSeconds = (now - new Date(book.updatedAt).getTime()) / 1000;
      if (!Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds) stale.add(book.tokenId);
    }
  }
  return stale;
}

function hasComparableOpenOrder(plan: RewardQuotePlan, openOrders: OpenOrderSummary[]): boolean {
  return openOrders.some((order) => (
    order.tokenId === plan.tokenId &&
    order.side === plan.side &&
    ACTIVE_ORDER_STATUSES.has(order.status.toLowerCase()) &&
    (order.price == null || Math.abs(order.price - plan.price) <= 0.001)
  ));
}

function toIntent(plan: RewardQuotePlan): RewardLimitIntent {
  return {
    id: plan.id,
    marketId: plan.marketId,
    conditionId: plan.conditionId,
    tokenId: plan.tokenId,
    label: plan.label,
    side: plan.side,
    limitPrice: plan.price,
    shares: plan.size,
    reason: plan.reason,
    createdAt: plan.createdAt,
  };
}

function toOpenOrderSummary(plan: RewardQuotePlan, result: LimitOrderResult): OpenOrderSummary {
  return {
    id: result.orderId || '',
    tokenId: plan.tokenId,
    side: plan.side,
    price: result.price,
    size: result.size,
    sizeMatched: 0,
    status: 'posted',
    raw: result.raw,
  };
}

function remainingOrderSize(order: OpenOrderSummary): number | null {
  if (order.size == null) return null;
  return Math.max(order.size - (order.sizeMatched ?? 0), 0);
}

function normalizeOrderStatus(status: string): RewardManagedOrder['status'] {
  const normalized = status.toLowerCase();
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'filled' || normalized === 'matched') return 'filled';
  if (normalized === 'expired') return 'expired';
  if (normalized === 'terminal') return 'terminal';
  if (ACTIVE_ORDER_STATUSES.has(normalized)) return 'open';
  return 'unknown';
}

function isActiveManagedOrder(order: RewardManagedOrder): boolean {
  return order.status === 'posted' || order.status === 'open' || order.status === 'unknown';
}

function planEventDetails(plan: RewardQuotePlan): { marketId: string; conditionId?: string; tokenId: string; orderId?: string; label: string; price: number; size: number; notional: number } {
  return {
    marketId: plan.marketId,
    conditionId: plan.conditionId,
    tokenId: plan.tokenId,
    label: plan.label,
    price: plan.price,
    size: plan.size,
    notional: plan.notional,
  };
}

function isPlanDetails(value: unknown): value is { marketId?: string; tokenId?: string; orderId?: string } {
  return Boolean(value && typeof value === 'object');
}

function inventorySummary(orders: RewardManagedOrder[], fills: RewardFillRecord[]): RewardInventorySummary[] {
  const orderById = new Map(orders.map((order) => [order.orderId, order]));
  const rows = new Map<string, RewardInventorySummary>();
  for (const fill of fills) {
    const order = orderById.get(fill.orderId);
    const key = fill.tokenId;
    const existing = rows.get(key) || {
      tokenId: fill.tokenId,
      label: fill.label,
      marketId: fill.marketId,
      conditionId: fill.conditionId,
      filledSize: 0,
      openBuySize: 0,
      avgEntryPrice: null,
      costBasis: 0,
    };
    existing.filledSize = roundShares(existing.filledSize + fill.size);
    existing.costBasis = roundMoney(existing.costBasis + fill.notional);
    existing.avgEntryPrice = existing.filledSize > 0 ? roundPrice(existing.costBasis / existing.filledSize) : null;
    if (order?.conditionId && !existing.conditionId) existing.conditionId = order.conditionId;
    rows.set(key, existing);
  }

  for (const order of orders.filter(isActiveManagedOrder)) {
    const existing = rows.get(order.tokenId) || {
      tokenId: order.tokenId,
      label: order.label,
      marketId: order.marketId,
      conditionId: order.conditionId,
      filledSize: 0,
      openBuySize: 0,
      avgEntryPrice: null,
      costBasis: 0,
    };
    existing.openBuySize = roundShares(existing.openBuySize + (order.remainingSize ?? Math.max(order.size - order.filledSize, 0)));
    rows.set(order.tokenId, existing);
  }

  return Array.from(rows.values()).sort((a, b) => b.costBasis - a.costBasis);
}

function inferredFilledSize(order: Partial<RewardManagedOrder>): number {
  if (typeof order.filledSize === 'number') return order.filledSize;
  if (typeof order.remainingSize === 'number' && typeof order.size === 'number') return Math.max(order.size - order.remainingSize, 0);
  return 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundShares(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
