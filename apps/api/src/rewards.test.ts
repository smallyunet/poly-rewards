import assert from 'node:assert/strict';
import test from 'node:test';

import { runRewardsTick } from './rewards';
import { loadRewardsAppConfig } from './rewardsConfig';

test('rewards scanner ranks an eligible market and plans two-sided buy quotes', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.REWARDS_BLOCKED_CATEGORIES = '';
  process.env.REWARDS_BLOCKED_KEYWORDS = '';
  process.env.REWARDS_MIN_SECONDS_TO_CLOSE = '3600';
  process.env.REWARDS_QUOTE_SIZE = '5';
  process.env.REWARDS_MARKET_MAX_NOTIONAL = '20';
  process.env.REWARDS_GLOBAL_MAX_NOTIONAL = '50';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/rewards/markets/current')) {
      return jsonResponse([
        {
          id: 'weather-market-1',
          condition_id: '0xcondition',
          question: 'Will it rain in New York this week?',
          category: 'weather',
          active: true,
          closed: false,
          accepting_orders: true,
          daily_reward: 12,
          min_incentive_size: 5,
          max_incentive_spread: 5,
          market_competitiveness: 1,
          end_date_iso: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
          tokens: [
            { outcome: 'Yes', token_id: 'yes-token' },
            { outcome: 'No', token_id: 'no-token' },
          ],
        },
      ]);
    }
    if (url.includes('/book?token_id=yes-token')) {
      return jsonResponse({ bids: [{ price: '0.49', size: '100' }], asks: [{ price: '0.51', size: '100' }] });
    }
    if (url.includes('/book?token_id=no-token')) {
      return jsonResponse({ bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.52', size: '100' }] });
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const state = await runRewardsTick(loadRewardsAppConfig());
    assert.equal(state.status, 'enabled');
    assert.equal(state.candidates.length, 1);
    assert.equal(state.candidates[0].rejectReasons.length, 0);
    assert.equal(state.quotePlans.length, 2);
    assert.deepEqual(state.quotePlans.map((plan) => plan.label).sort(), ['NO', 'YES']);
    assert.equal(state.totals.plannedOrders, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('quote planner uses configured quote size even when reward min size is higher', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.REWARDS_BLOCKED_CATEGORIES = '';
  process.env.REWARDS_BLOCKED_KEYWORDS = '';
  process.env.REWARDS_MIN_SECONDS_TO_CLOSE = '3600';
  process.env.REWARDS_QUOTE_SIZE = '5';
  process.env.REWARDS_MARKET_MAX_NOTIONAL = '20';
  process.env.REWARDS_GLOBAL_MAX_NOTIONAL = '50';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/rewards/markets/current')) {
      return jsonResponse([
        {
          id: 'high-min-size-market',
          condition_id: '0xhighmin',
          question: 'Will a small quote be allowed?',
          category: 'weather',
          active: true,
          closed: false,
          accepting_orders: true,
          daily_reward: 12,
          min_incentive_size: 50,
          max_incentive_spread: 5,
          market_competitiveness: 1,
          end_date_iso: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
          tokens: [
            { outcome: 'Yes', token_id: 'yes-token' },
            { outcome: 'No', token_id: 'no-token' },
          ],
        },
      ]);
    }
    if (url.includes('/book?token_id=yes-token')) {
      return jsonResponse({ bids: [{ price: '0.49', size: '100' }], asks: [{ price: '0.51', size: '100' }] });
    }
    if (url.includes('/book?token_id=no-token')) {
      return jsonResponse({ bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.52', size: '100' }] });
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const state = await runRewardsTick(loadRewardsAppConfig());
    assert.equal(state.candidates[0].rejectReasons.includes('minimum incentive size exceeds per-market notional cap'), false);
    assert.equal(state.quotePlans.length, 2);
    assert.deepEqual([...new Set(state.quotePlans.map((plan) => plan.size))], [5]);
    assert.match(state.quotePlans[0].reason, /below the reward min size/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
