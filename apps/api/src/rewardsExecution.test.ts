import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RewardsDashboardState } from '../../../packages/shared/src';
import { RewardsExecutionService } from './rewardsExecution';
import { loadRewardsAppConfig, type RewardsAppConfig } from './rewardsConfig';

test('monitor execution mode never calls live CLOB methods', async () => {
  const config = testConfig({ executionMode: 'monitor' });
  const client = fakeClient();
  const execution = new RewardsExecutionService(config, client);

  const state = await execution.reconcile(testSnapshot());

  assert.equal(state.mode, 'monitor');
  assert.equal(state.dryRun, true);
  assert.equal(state.totals.postedThisTick, 0);
  assert.equal(client.calls.post, 0);
  assert.equal(client.calls.openOrders, 0);
});

test('live execution posts eligible quotes after reconciliation guards pass', async () => {
  const config = testConfig({
    executionMode: 'live',
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
  });
  const client = fakeClient();
  const execution = new RewardsExecutionService(config, client);

  const state = await execution.reconcile(testSnapshot());

  assert.equal(state.mode, 'live');
  assert.equal(state.totals.postedThisTick, 2);
  assert.equal(state.totals.activeOrders, 2);
  assert.equal(client.calls.openOrders, 1);
  assert.equal(client.calls.post, 2);
  assert.deepEqual(client.posted.map((intent) => intent.label).sort(), ['NO', 'YES']);
});

test('live execution picks affordable plans instead of stopping on larger plans', async () => {
  const config = testConfig({
    executionMode: 'live',
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
    rewards: { minCollateralBalance: 0 },
  });
  const client = fakeClient({ collateralBalance: 5 });
  const snapshot = testSnapshot();
  snapshot.quotePlans = [
    { ...snapshot.quotePlans[1], id: 'large-plan', label: 'NO', tokenId: 'large-token', price: 0.9, size: 10, notional: 9 },
    { ...snapshot.quotePlans[0], id: 'small-plan', label: 'YES', tokenId: 'small-token', price: 0.4, size: 5, notional: 2 },
  ];
  const execution = new RewardsExecutionService(config, client);

  const state = await execution.reconcile(snapshot);

  assert.equal(state.totals.postedThisTick, 1);
  assert.equal(state.totals.skippedThisTick, 1);
  assert.deepEqual(client.posted.map((intent) => intent.id), ['small-plan']);
  assert.match(skipEventMessage(state, 'needs $9.00'), /needs \$9\.00 but only \$3\.00 is spendable/);
});

test('live execution skips when an external open order already exists on a token', async () => {
  const config = testConfig({
    executionMode: 'live',
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
  });
  const client = fakeClient({
    openOrders: [{
      id: 'external-yes',
      tokenId: 'yes-token',
      side: 'BUY',
      price: 0.485,
      size: 5,
      sizeMatched: 0,
      status: 'open',
      raw: {},
    }],
  });
  const execution = new RewardsExecutionService(config, client);

  const state = await execution.reconcile(testSnapshot());

  assert.equal(state.totals.postedThisTick, 1);
  assert.equal(state.totals.skippedThisTick, 1);
  assert.deepEqual(client.posted.map((intent) => intent.label), ['NO']);
  assert.match(skipEventMessage(state, 'already has an open BUY order'), /already has an open BUY order at 0\.485 for 5\.00 shares/);
});

test('live execution skip events include inventory cap numbers', async () => {
  const config = testConfig({
    executionMode: 'live',
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
    rewards: { maxInventorySharesPerOutcome: 7 },
  });
  const client = fakeClient({ inventory: 4 });
  const execution = new RewardsExecutionService(config, client);

  const state = await execution.reconcile(testSnapshot());

  assert.equal(state.totals.postedThisTick, 0);
  assert.equal(state.totals.skippedThisTick, 2);
  assert.match(skipEventMessage(state, 'inventory would become'), /inventory would become 9\.00 shares, above the 7\.00 cap \(4\.00 current \+ 5\.00 planned\)/);
});

test('execution state persists and restores managed orders across service instances', async () => {
  const runtimeStatePath = tempStatePath();
  const config = testConfig({
    executionMode: 'live',
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
    runtimeStatePath,
  });
  const firstClient = fakeClient();
  const first = new RewardsExecutionService(config, firstClient);

  const firstState = await first.reconcile(testSnapshot());
  assert.equal(firstState.totals.activeOrders, 2);
  assert.equal(fs.existsSync(runtimeStatePath), true);

  const secondClient = fakeClient({
    openOrders: [
      { id: 'order-YES', tokenId: 'yes-token', side: 'BUY', price: 0.485, size: 5, sizeMatched: 0, status: 'open', raw: {} },
      { id: 'order-NO', tokenId: 'no-token', side: 'BUY', price: 0.485, size: 5, sizeMatched: 0, status: 'open', raw: {} },
    ],
  });
  const second = new RewardsExecutionService(config, secondClient);
  const secondState = await second.reconcile(testSnapshot());

  assert.equal(secondState.totals.activeOrders, 2);
  assert.equal(secondState.totals.postedThisTick, 0);
  assert.equal(secondClient.calls.post, 0);
  assert.match(secondState.recentEvents.at(-1)?.message || secondState.recentEvents[0].message, /Restored|Posted/);
});

test('execution reconciliation records matched-size fill deltas', async () => {
  const runtimeStatePath = tempStatePath();
  const config = testConfig({
    executionMode: 'live',
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
    runtimeStatePath,
  });
  const first = new RewardsExecutionService(config, fakeClient());
  await first.reconcile(testSnapshot());

  const second = new RewardsExecutionService(config, fakeClient({
    openOrders: [
      { id: 'order-YES', tokenId: 'yes-token', side: 'BUY', price: 0.485, size: 5, sizeMatched: 2, status: 'open', raw: {} },
      { id: 'order-NO', tokenId: 'no-token', side: 'BUY', price: 0.485, size: 5, sizeMatched: 0, status: 'open', raw: {} },
    ],
  }));
  const state = await second.reconcile(testSnapshot());

  assert.equal(state.totals.fillsThisTick, 1);
  assert.equal(state.totals.filledSize, 2);
  assert.equal(state.totals.filledCostBasis, 0.97);
  assert.equal(state.inventory.find((row) => row.tokenId === 'yes-token')?.filledSize, 2);
  assert.equal(state.recentFills[0].source, 'open_order_match');
});

test('live execution does not cancel solely on soft order age before hard refresh age', async () => {
  const runtimeStatePath = tempStatePath();
  const config = testConfig({
    executionMode: 'live',
    ownerPrivateKey: '0xabc',
    depositWallet: '0xwallet',
    runtimeStatePath,
    rewards: {
      maxOrderAgeSeconds: 1,
      maxOrderHardAgeSeconds: 60 * 60,
    },
  });
  const first = new RewardsExecutionService(config, fakeClient());
  await first.reconcile(testSnapshot());

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const second = new RewardsExecutionService(config, fakeClient({
    openOrders: [
      { id: 'order-YES', tokenId: 'yes-token', side: 'BUY', price: 0.485, size: 5, sizeMatched: 0, status: 'open', raw: {} },
      { id: 'order-NO', tokenId: 'no-token', side: 'BUY', price: 0.485, size: 5, sizeMatched: 0, status: 'open', raw: {} },
    ],
  }));
  const state = await second.reconcile(testSnapshot());

  assert.equal(state.totals.cancelledThisTick, 0);
});

function testConfig(overrides: Partial<RewardsAppConfig> & { rewards?: Partial<RewardsAppConfig['rewards']> } = {}): RewardsAppConfig {
  const originalEnv = { ...process.env };
  process.env.REWARDS_BLOCKED_CATEGORIES = '';
  process.env.REWARDS_BLOCKED_KEYWORDS = '';
  try {
    const base = loadRewardsAppConfig();
    return {
      ...base,
      runtimeStatePath: tempStatePath(),
      ...overrides,
      rewards: {
        ...base.rewards,
        maxInventorySharesPerOutcome: 50,
        minCollateralBalance: 5,
        maxActiveOrdersPerMarket: 2,
        maxOrderAgeSeconds: 600,
        maxOrderHardAgeSeconds: 1800,
        ...overrides.rewards,
      },
    };
  } finally {
    process.env = originalEnv;
  }
}

function tempStatePath(): string {
  return path.join(os.tmpdir(), `poly-rewards-execution-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function skipEventMessage(state: Awaited<ReturnType<RewardsExecutionService['reconcile']>>, text: string): string {
  const event = state.recentEvents.find((item) => item.action === 'skip' && item.message.includes(text));
  assert.ok(event, `expected skip event containing "${text}"`);
  return event.message;
}

function testSnapshot(): RewardsDashboardState {
  const now = new Date().toISOString();
  return {
    status: 'enabled',
    updatedAt: now,
    config: testConfig().rewards,
    marketsScanned: 1,
    candidates: [{
      id: 'market-1',
      conditionId: 'condition-1',
      question: 'Will the test pass?',
      active: true,
      closed: false,
      acceptingOrders: true,
      dailyReward: 10,
      minSize: 5,
      maxSpread: 0.05,
      competitiveness: 1,
      volume24h: null,
      liquidity: null,
      tokens: [
        { label: 'YES', tokenId: 'yes-token' },
        { label: 'NO', tokenId: 'no-token' },
      ],
      yesOrderbook: { tokenId: 'yes-token', label: 'YES', bestBid: 0.49, bestAsk: 0.51, midpoint: 0.5, spread: 0.02, bidDepth: 100, askDepth: 100, updatedAt: now },
      noOrderbook: { tokenId: 'no-token', label: 'NO', bestBid: 0.48, bestAsk: 0.52, midpoint: 0.5, spread: 0.04, bidDepth: 100, askDepth: 100, updatedAt: now },
      adjustedMidpoint: 0.5,
      marketSpread: 0.02,
      estimatedRequiredCapital: 5,
      rewardScore: 1,
      riskScore: 0,
      netScore: 1,
      riskTags: ['eligible'],
      rejectReasons: [],
    }],
    quotePlans: [
      {
        id: 'market-1:YES:test',
        marketId: 'market-1',
        conditionId: 'condition-1',
        tokenId: 'yes-token',
        label: 'YES',
        side: 'BUY',
        price: 0.485,
        size: 5,
        notional: 2.43,
        offset: 0.015,
        eligible: true,
        reason: 'test',
        cancelRepostTriggers: [],
        createdAt: now,
      },
      {
        id: 'market-1:NO:test',
        marketId: 'market-1',
        conditionId: 'condition-1',
        tokenId: 'no-token',
        label: 'NO',
        side: 'BUY',
        price: 0.485,
        size: 5,
        notional: 2.43,
        offset: 0.015,
        eligible: true,
        reason: 'test',
        cancelRepostTriggers: [],
        createdAt: now,
      },
    ],
    diagnostics: [],
    totals: {
      plannedMarkets: 1,
      plannedOrders: 2,
      plannedNotional: 4.86,
      dailyRewardVisible: 10,
      rejectedMarkets: 0,
    },
  };
}

function fakeClient(options: { openOrders?: any[]; collateralBalance?: number; inventory?: number } = {}) {
  const calls = {
    openOrders: 0,
    collateral: 0,
    shares: 0,
    post: 0,
    cancel: 0,
  };
  const posted: any[] = [];
  return {
    calls,
    posted,
    async getOpenOrders() {
      calls.openOrders += 1;
      return options.openOrders || [];
    },
    async getCollateralBalanceAllowance() {
      calls.collateral += 1;
      return { balance: options.collateralBalance ?? 100, allowance: 100 };
    },
    async getAvailableShares() {
      calls.shares += 1;
      return options.inventory ?? 0;
    },
    async executeRewardLimitIntent(intent: any) {
      calls.post += 1;
      posted.push(intent);
      return { ok: true, orderId: `order-${intent.label}`, price: intent.limitPrice, size: intent.shares, raw: {} };
    },
    async cancelOrders() {
      calls.cancel += 1;
      return { cancelled: [] };
    },
  };
}
