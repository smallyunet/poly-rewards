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

type CancelReason = {
  message: string;
  currentPrice?: number;
  originalPrice: number;
  priceDrift?: number;
  maxMidpointDrift: number;
  planOffset?: number;
  driftOffsetRatio: number;
  ageSeconds: number;
  orderbookAgeSeconds?: number;
  maxOrderbookAgeSeconds: number;
  maxOrderHardAgeSeconds: number;
  staleOrderbook: boolean;
};

type MarketPlanBundle = {
  marketId: string;
  conditionId?: string;
  plans: RewardQuotePlan[];
};

type ExistingOrderMatch = {
  plan: RewardQuotePlan;
  orderId?: string;
  price?: number;
  size?: number | null;
  source: 'open_order' | 'inventory';
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
      await this.manageInventoryExits(snapshot, openOrders, counters, now);
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
    const staleOrderbookAges = staleOrderbookAgesByToken(snapshot, this.appConfig.rewards.maxOrderbookAgeSeconds);
    const openById = new Map(openOrders.map((order) => [order.id, order]));
    const cancelIds: string[] = [];
    const cancelReasons = new Map<string, CancelReason>();

    for (const order of this.managedOrders.values()) {
      if (!isActiveManagedOrder(order)) continue;
      if (!openById.has(order.orderId)) continue;

      const currentPlan = plansByToken.get(order.tokenId);
      const ageSeconds = (Date.now() - new Date(order.createdAt).getTime()) / 1000;
      const priceDrift = order.side === 'BUY' && currentPlan ? Math.abs(currentPlan.price - order.price) : 0;
      const dynamicMaxDrift = currentPlan ? maxPriceDrift(this.appConfig.rewards.maxMidpointDrift, currentPlan.offset, this.appConfig.rewards.driftOffsetRatio) : this.appConfig.rewards.maxMidpointDrift;
      const orderbookAgeSeconds = staleOrderbookAges.get(order.tokenId);
      const staleOrderbook = orderbookAgeSeconds != null;
      const reason = cancelReasonForOrder({
        currentPrice: order.side === 'SELL' ? order.price : currentPlan?.price,
        originalPrice: order.price,
        priceDrift,
        maxMidpointDrift: dynamicMaxDrift,
        planOffset: currentPlan?.offset,
        driftOffsetRatio: this.appConfig.rewards.driftOffsetRatio,
        ageSeconds,
        orderbookAgeSeconds,
        maxOrderbookAgeSeconds: this.appConfig.rewards.maxOrderbookAgeSeconds,
        maxOrderHardAgeSeconds: this.appConfig.rewards.maxOrderHardAgeSeconds,
        staleOrderbook,
      });

      if (reason) {
        cancelIds.push(order.orderId);
        cancelReasons.set(order.orderId, reason);
      }
    }

    if (!cancelIds.length) return;
    await this.client.cancelOrders(cancelIds);
    counters.cancelledThisTick += cancelIds.length;
    for (const orderId of cancelIds) {
      const order = this.managedOrders.get(orderId);
      if (!order) continue;
      const reason = cancelReasons.get(orderId);
      this.managedOrders.set(orderId, { ...order, status: 'cancelled', remainingSize: 0, updatedAt: now });
      this.event('info', 'cancel', `Cancelled managed order ${shortId(orderId)} because ${reason?.message || 'refresh or risk control required it'}.`, {
        orderId,
        marketId: order.marketId,
        tokenId: order.tokenId,
        ...reason,
      });
    }
  }

  private async postMissingQuotes(snapshot: RewardsDashboardState, openOrders: OpenOrderSummary[], collateralBalance: number, counters: TickCounters, now: string): Promise<void> {
    let availableCollateral = collateralBalance;
    const activeManaged = () => Array.from(this.managedOrders.values()).filter(isActiveManagedOrder);
    const inventoryByToken = new Map(inventorySummary(Array.from(this.managedOrders.values()), this.fills).map((row) => [row.tokenId, row]));

    const bundles = groupEligiblePlansByMarket(snapshot.quotePlans);

    for (const bundle of bundles) {
      if (activeManaged().some((order) => order.marketId === bundle.marketId && order.side === 'SELL')) {
        counters.skippedThisTick += bundle.plans.filter((plan) => plan.eligible).length;
        this.event('warn', 'skip', `Skipped market ${shortId(bundle.marketId)} because an inventory exit SELL order is active.`, {
          marketId: bundle.marketId,
          conditionId: bundle.conditionId,
        });
        continue;
      }

      const yesPlan = bundle.plans.find((plan) => plan.label === 'YES');
      const noPlan = bundle.plans.find((plan) => plan.label === 'NO');
      if (!yesPlan || !noPlan) {
        counters.skippedThisTick += bundle.plans.length;
        this.event('warn', 'skip', `Skipped market ${shortId(bundle.marketId)} because reward market making requires both YES and NO eligible quote plans.`, {
          marketId: bundle.marketId,
          conditionId: bundle.conditionId,
          labels: bundle.plans.map((plan) => plan.label),
        });
        continue;
      }

      const miniShares = miniSharesForMarket(snapshot, bundle.marketId);
      if (miniShares == null || !plansUseMiniShares([yesPlan, noPlan], miniShares)) {
        counters.skippedThisTick += bundle.plans.length;
        this.event('warn', 'skip', `Skipped market ${shortId(bundle.marketId)} because YES+NO quote sizes must both equal reward mini shares.`, {
          marketId: bundle.marketId,
          conditionId: bundle.conditionId,
          miniShares,
          plans: [yesPlan, noPlan].map(planEventDetails),
        });
        continue;
      }

      const existingOrders: ExistingOrderMatch[] = [];
      const missingPlans: RewardQuotePlan[] = [];
      for (const plan of [yesPlan, noPlan]) {
        const comparableOpenOrder = findComparableOpenOrder(plan, openOrders);
        const existingManagedOrder = activeManaged().find((order) => order.tokenId === plan.tokenId && order.side === plan.side);
        if (comparableOpenOrder || existingManagedOrder) {
          existingOrders.push({
            plan,
            orderId: comparableOpenOrder?.id ?? existingManagedOrder?.orderId,
            price: comparableOpenOrder?.price ?? existingManagedOrder?.price,
            size: comparableOpenOrder?.size ?? existingManagedOrder?.remainingSize ?? existingManagedOrder?.size,
            source: 'open_order',
          });
        } else if ((inventoryByToken.get(plan.tokenId)?.filledSize ?? 0) > 0) {
          const inventory = inventoryByToken.get(plan.tokenId)!;
          existingOrders.push({
            plan,
            price: inventory.avgEntryPrice ?? undefined,
            size: inventory.filledSize,
            source: 'inventory',
          });
        } else {
          missingPlans.push(plan);
        }
      }

      if (!missingPlans.length) {
        counters.skippedThisTick += 2;
        this.event('info', 'skip', `Skipped market ${shortId(bundle.marketId)} because both YES and NO already have open BUY orders.`, {
          marketId: bundle.marketId,
          conditionId: bundle.conditionId,
          existingOrders: existingOrders.map((item) => existingOrderDetails(item)),
        });
        continue;
      }

      const requiredCollateral = roundMoney(sum(missingPlans.map((plan) => plan.notional)));
      if (availableCollateral - requiredCollateral < this.appConfig.rewards.minCollateralBalance) {
        const spendableCollateral = Math.max(availableCollateral - this.appConfig.rewards.minCollateralBalance, 0);
        counters.skippedThisTick += missingPlans.length;
        this.event('warn', 'skip', `Skipped market ${shortId(bundle.marketId)} because YES+NO needs ${formatUsd(requiredCollateral)} but only ${formatUsd(spendableCollateral)} is spendable (${formatUsd(availableCollateral)} balance, ${formatUsd(this.appConfig.rewards.minCollateralBalance)} reserve).`, {
          marketId: bundle.marketId,
          conditionId: bundle.conditionId,
          missingPlans: missingPlans.map(planEventDetails),
          existingOrders: existingOrders.map((item) => existingOrderDetails(item)),
          collateralBalance: availableCollateral,
          requiredCollateral,
          spendableCollateral,
          minCollateralBalance: this.appConfig.rewards.minCollateralBalance,
        });
        continue;
      }

      const activeOrdersForMarket = activeManaged().filter((order) => order.marketId === bundle.marketId).length;
      if (activeOrdersForMarket + missingPlans.length > this.appConfig.rewards.maxActiveOrdersPerMarket) {
        counters.skippedThisTick += missingPlans.length;
        this.event('warn', 'skip', `Skipped market ${shortId(bundle.marketId)} because posting YES+NO would require ${activeOrdersForMarket + missingPlans.length}/${this.appConfig.rewards.maxActiveOrdersPerMarket} active managed orders.`, {
          marketId: bundle.marketId,
          conditionId: bundle.conditionId,
          missingPlans: missingPlans.map(planEventDetails),
          activeOrdersForMarket,
          requiredNewOrders: missingPlans.length,
          maxActiveOrdersPerMarket: this.appConfig.rewards.maxActiveOrdersPerMarket,
        });
        continue;
      }

      let blockedByInventory = false;
      for (const plan of missingPlans) {
        const inventory = await this.client.getAvailableShares(plan.tokenId);
        if (inventory + plan.size > this.appConfig.rewards.maxInventorySharesPerOutcome) {
          blockedByInventory = true;
          counters.skippedThisTick += missingPlans.length;
          this.event('warn', 'skip', `Skipped market ${shortId(bundle.marketId)} because ${plan.label} inventory would become ${formatShares(inventory + plan.size)} shares, above the ${formatShares(this.appConfig.rewards.maxInventorySharesPerOutcome)} cap (${formatShares(inventory)} current + ${formatShares(plan.size)} planned).`, {
            marketId: bundle.marketId,
            conditionId: bundle.conditionId,
            blockedPlan: planEventDetails(plan),
            missingPlans: missingPlans.map(planEventDetails),
            inventory,
            plannedSize: plan.size,
            projectedInventory: roundShares(inventory + plan.size),
            maxInventorySharesPerOutcome: this.appConfig.rewards.maxInventorySharesPerOutcome,
          });
          break;
        }
      }
      if (blockedByInventory) continue;

      const postedOrderIds = await this.postMarketBundle(bundle, missingPlans, openOrders, counters, now);
      if (postedOrderIds.length === missingPlans.length) availableCollateral -= requiredCollateral;
    }
  }

  private async postMarketBundle(bundle: MarketPlanBundle, missingPlans: RewardQuotePlan[], openOrders: OpenOrderSummary[], counters: TickCounters, now: string): Promise<string[]> {
    const postedOrderIds: string[] = [];
    for (const plan of missingPlans) {
      const result = await this.client.executeRewardLimitIntent(toIntent(plan), { execute: true, orderType: 'GTC' });
      if (!result.ok || !result.orderId) {
        counters.skippedThisTick += missingPlans.length - postedOrderIds.length;
        this.event('error', 'error', `Failed to post ${plan.label} quote for market ${shortId(bundle.marketId)}: ${result.error || 'missing order id'}. Rolling back ${postedOrderIds.length} newly posted order(s).`, {
          ...planEventDetails(plan),
          result,
          postedOrderIds,
        });
        await this.rollbackPostedOrders(postedOrderIds, counters, now);
        return [];
      }

      this.recordPostedOrder(plan, result, now);
      openOrders.push(toOpenOrderSummary(plan, result));
      postedOrderIds.push(result.orderId);
      counters.postedThisTick += 1;
      this.event('info', 'post', `Posted ${plan.label} BUY quote at ${plan.price.toFixed(3)}.`, {
        ...planEventDetails(plan),
        orderId: result.orderId,
      });
    }
    return postedOrderIds;
  }

  private async manageInventoryExits(snapshot: RewardsDashboardState, openOrders: OpenOrderSummary[], counters: TickCounters, now: string): Promise<void> {
    if (!this.appConfig.rewards.inventoryExitEnabled) return;
    const activeManaged = Array.from(this.managedOrders.values()).filter(isActiveManagedOrder);
    const inventoryRows = inventorySummary(Array.from(this.managedOrders.values()), this.fills)
      .filter((row) => row.filledSize >= this.appConfig.rewards.minInventoryExitShares);
    const booksByToken = orderbooksByToken(snapshot);
    const rowsByMarket = new Map<string, RewardInventorySummary[]>();
    for (const row of inventoryRows) {
      const rows = rowsByMarket.get(row.marketId) || [];
      rows.push(row);
      rowsByMarket.set(row.marketId, rows);
    }

    for (const row of inventoryRows) {
      if (activeManaged.some((order) => order.tokenId === row.tokenId && order.side === 'SELL')) continue;
      const marketRows = rowsByMarket.get(row.marketId) || [];
      const opposite = marketRows.find((item) => item.label !== row.label);
      const oppositeOpenBuy = activeManaged
        .filter((order) => order.marketId === row.marketId && order.label !== row.label && order.side === 'BUY')
        .reduce((total, order) => total + (order.remainingSize ?? Math.max(order.size - order.filledSize, 0)), 0);
      const unhedgedSize = roundShares(row.filledSize - ((opposite?.filledSize ?? 0) + oppositeOpenBuy));
      if (unhedgedSize < this.appConfig.rewards.minInventoryExitShares) continue;

      const oldestFill = oldestBuyFill(this.fills, row.tokenId);
      const ageSeconds = oldestFill ? (Date.now() - new Date(oldestFill.createdAt).getTime()) / 1000 : 0;
      const book = booksByToken.get(row.tokenId);
      const exitPrice = book?.bestBid;
      if (exitPrice == null || exitPrice <= 0) {
        this.event('warn', 'skip', `Skipped ${row.label} inventory exit because no current bid is available for ${shortId(row.tokenId)}.`, {
          marketId: row.marketId,
          conditionId: row.conditionId,
          tokenId: row.tokenId,
          label: row.label,
          unhedgedSize,
        });
        continue;
      }

      const lossPerShare = row.avgEntryPrice == null ? 0 : Math.max(row.avgEntryPrice - exitPrice, 0);
      const timedOut = ageSeconds >= this.appConfig.rewards.maxUnhedgedInventoryAgeSeconds;
      const stopLoss = lossPerShare >= this.appConfig.rewards.maxInventoryLossPerShare;
      if (!timedOut && !stopLoss) continue;

      const availableShares = await this.client.getAvailableShares(row.tokenId);
      const exitSize = roundShares(Math.min(unhedgedSize, availableShares));
      if (exitSize < this.appConfig.rewards.minInventoryExitShares) {
        this.event('warn', 'skip', `Skipped ${row.label} inventory exit because only ${formatShares(availableShares)} shares are available to sell.`, {
          marketId: row.marketId,
          conditionId: row.conditionId,
          tokenId: row.tokenId,
          label: row.label,
          unhedgedSize,
          availableShares,
        });
        continue;
      }

      const intent = exitIntent(row, exitPrice, exitSize, now, timedOut ? 'unhedged inventory timeout' : 'inventory stop loss');
      const result = await this.client.executeRewardLimitIntent(intent, { execute: true, orderType: 'GTC' });
      if (!result.ok || !result.orderId) {
        counters.skippedThisTick += 1;
        this.event('error', 'error', `Failed to post ${row.label} SELL exit at ${exitPrice.toFixed(3)}: ${result.error || 'missing order id'}.`, {
          marketId: row.marketId,
          conditionId: row.conditionId,
          tokenId: row.tokenId,
          label: row.label,
          exitPrice,
          exitSize,
          result,
        });
        continue;
      }

      this.recordPostedOrderFromIntent(intent, result, now);
      openOrders.push(toOpenOrderSummaryFromIntent(intent, result));
      counters.postedThisTick += 1;
      this.event('warn', 'post', `Posted ${row.label} SELL exit at ${exitPrice.toFixed(3)} for ${formatShares(exitSize)} shares because ${timedOut ? `inventory was unhedged for ${Math.round(ageSeconds)}s` : `loss ${lossPerShare.toFixed(3)} exceeded max ${this.appConfig.rewards.maxInventoryLossPerShare.toFixed(3)}`}.`, {
        marketId: row.marketId,
        conditionId: row.conditionId,
        tokenId: row.tokenId,
        label: row.label,
        orderId: result.orderId,
        exitPrice,
        exitSize,
        avgEntryPrice: row.avgEntryPrice,
        lossPerShare,
        ageSeconds,
      });
    }
  }

  private async rollbackPostedOrders(orderIds: string[], counters: TickCounters, now: string): Promise<void> {
    if (!orderIds.length) return;
    await this.client.cancelOrders(orderIds);
    counters.cancelledThisTick += orderIds.length;
    for (const orderId of orderIds) {
      const order = this.managedOrders.get(orderId);
      if (!order) continue;
      this.managedOrders.set(orderId, { ...order, status: 'cancelled', remainingSize: 0, updatedAt: now });
      this.event('warn', 'cancel', `Cancelled newly posted managed order ${shortId(orderId)} because its YES+NO bundle did not complete.`, {
        orderId,
        marketId: order.marketId,
        tokenId: order.tokenId,
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
    this.recordPostedOrderFromIntent(toIntent(plan), result, now);
  }

  private recordPostedOrderFromIntent(intent: RewardLimitIntent, result: LimitOrderResult, now: string): void {
    if (!result.orderId) return;
    this.managedOrders.set(result.orderId, {
      orderId: result.orderId,
      planId: intent.id,
      marketId: intent.marketId,
      conditionId: intent.conditionId,
      tokenId: intent.tokenId,
      label: intent.label,
      side: intent.side,
      price: intent.limitPrice,
      size: result.size,
      filledSize: 0,
      remainingSize: result.size,
      notional: roundMoney(intent.limitPrice * result.size),
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
    const buyFills = this.fills.filter((fill) => fill.side === 'BUY');
    const filledCostBasis = roundMoney(buyFills.reduce((total, fill) => total + fill.notional, 0));
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
        filledSize: roundShares(buyFills.reduce((total, fill) => total + fill.size, 0)),
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

function staleOrderbookAgesByToken(snapshot: RewardsDashboardState, maxAgeSeconds: number): Map<string, number> {
  const stale = new Map<string, number>();
  const now = Date.now();
  for (const market of snapshot.candidates) {
    for (const book of [market.yesOrderbook, market.noOrderbook]) {
      if (!book) continue;
      const ageSeconds = (now - new Date(book.updatedAt).getTime()) / 1000;
      if (!Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds) stale.set(book.tokenId, ageSeconds);
    }
  }
  return stale;
}

function cancelReasonForOrder(params: Omit<CancelReason, 'message'>): CancelReason | null {
  if (params.currentPrice == null) {
    return {
      ...params,
      message: 'this token no longer has an eligible current quote plan',
    };
  }
  if (params.ageSeconds > params.maxOrderHardAgeSeconds) {
    return {
      ...params,
      message: `order age ${Math.round(params.ageSeconds)}s exceeded hard refresh ${params.maxOrderHardAgeSeconds}s`,
    };
  }
  if (params.priceDrift != null && params.priceDrift > params.maxMidpointDrift) {
    return {
      ...params,
      message: `price drift ${params.priceDrift.toFixed(3)} exceeded max ${params.maxMidpointDrift.toFixed(3)} (${params.originalPrice.toFixed(3)} -> ${params.currentPrice.toFixed(3)})`,
    };
  }
  if (params.staleOrderbook && params.ageSeconds > params.maxOrderbookAgeSeconds) {
    return {
      ...params,
      message: `orderbook age ${Math.round(params.orderbookAgeSeconds ?? 0)}s exceeded max ${params.maxOrderbookAgeSeconds}s for an order aged ${Math.round(params.ageSeconds)}s`,
    };
  }
  return null;
}

function maxPriceDrift(baseDrift: number, planOffset: number, ratio: number): number {
  return roundPrice(Math.max(baseDrift, planOffset * ratio));
}

function findComparableOpenOrder(plan: RewardQuotePlan, openOrders: OpenOrderSummary[]): OpenOrderSummary | undefined {
  return openOrders.find((order) => (
    order.tokenId === plan.tokenId &&
    order.side === plan.side &&
    ACTIVE_ORDER_STATUSES.has(order.status.toLowerCase()) &&
    (order.price == null || Math.abs(order.price - plan.price) <= 0.001)
  ));
}

function groupEligiblePlansByMarket(plans: RewardQuotePlan[]): MarketPlanBundle[] {
  const byMarket = new Map<string, MarketPlanBundle>();
  for (const plan of plans.filter((item) => item.eligible)) {
    const existing = byMarket.get(plan.marketId);
    if (existing) {
      existing.plans.push(plan);
    } else {
      byMarket.set(plan.marketId, { marketId: plan.marketId, conditionId: plan.conditionId, plans: [plan] });
    }
  }
  return Array.from(byMarket.values()).sort((a, b) => sum(a.plans.map((plan) => plan.notional)) - sum(b.plans.map((plan) => plan.notional)));
}

function miniSharesForMarket(snapshot: RewardsDashboardState, marketId: string): number | null {
  const market = snapshot.candidates.find((candidate) => candidate.id === marketId);
  return market && market.minSize > 0 ? roundShares(market.minSize) : null;
}

function plansUseMiniShares(plans: RewardQuotePlan[], miniShares: number): boolean {
  return plans.every((plan) => roundShares(plan.size) === miniShares);
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
  return toOpenOrderSummaryFromIntent(toIntent(plan), result);
}

function toOpenOrderSummaryFromIntent(intent: RewardLimitIntent, result: LimitOrderResult): OpenOrderSummary {
  return {
    id: result.orderId || '',
    tokenId: intent.tokenId,
    side: intent.side,
    price: result.price,
    size: result.size,
    sizeMatched: 0,
    status: 'posted',
    raw: result.raw,
  };
}

function exitIntent(row: RewardInventorySummary, price: number, shares: number, createdAt: string, reason: string): RewardLimitIntent {
  return {
    id: `${row.marketId}:${row.label}:SELL:${createdAt}`,
    marketId: row.marketId,
    conditionId: row.conditionId,
    tokenId: row.tokenId,
    label: row.label,
    side: 'SELL',
    limitPrice: roundPrice(price),
    shares: roundShares(shares),
    reason,
    createdAt,
  };
}

function orderbooksByToken(snapshot: RewardsDashboardState): Map<string, { bestBid: number | null; bestAsk: number | null }> {
  const books = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
  for (const market of snapshot.candidates) {
    for (const book of [market.yesOrderbook, market.noOrderbook]) {
      if (!book) continue;
      books.set(book.tokenId, { bestBid: book.bestBid, bestAsk: book.bestAsk });
    }
  }
  return books;
}

function oldestBuyFill(fills: RewardFillRecord[], tokenId: string): RewardFillRecord | undefined {
  return fills
    .filter((fill) => fill.tokenId === tokenId && fill.side === 'BUY')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
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

function existingOrderDetails(match: ExistingOrderMatch): { label: string; tokenId: string; orderId?: string; price?: number; size?: number | null } {
  return {
    label: match.plan.label,
    tokenId: match.plan.tokenId,
    orderId: match.orderId,
    price: match.price,
    size: match.size,
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
    const sign = fill.side === 'SELL' ? -1 : 1;
    existing.filledSize = roundShares(Math.max(existing.filledSize + sign * fill.size, 0));
    existing.costBasis = roundMoney(Math.max(existing.costBasis + sign * fill.notional, 0));
    existing.avgEntryPrice = existing.filledSize > 0 ? roundPrice(existing.costBasis / existing.filledSize) : null;
    if (order?.conditionId && !existing.conditionId) existing.conditionId = order.conditionId;
    rows.set(key, existing);
  }

  for (const order of orders.filter((order) => isActiveManagedOrder(order) && order.side === 'BUY')) {
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

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundShares(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatUsd(value: number): string {
  return `$${roundMoney(value).toFixed(2)}`;
}

function formatShares(value: number): string {
  return roundShares(value).toFixed(2);
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
