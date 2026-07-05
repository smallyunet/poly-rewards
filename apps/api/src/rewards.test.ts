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
      return jsonResponse({ bids: [{ price: '0.49', size: '250' }], asks: [{ price: '0.51', size: '100' }] });
    }
    if (url.includes('/book?token_id=no-token')) {
      return jsonResponse({ bids: [{ price: '0.48', size: '250' }], asks: [{ price: '0.52', size: '100' }] });
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const state = await runRewardsTick(loadRewardsAppConfig());
    assert.equal(state.status, 'enabled');
    assert.equal(state.candidates.length, 1);
    assert.deepEqual(state.candidates[0].rejectReasons, []);
    assert.equal(state.quotePlans.length, 2);
    assert.deepEqual(state.quotePlans.map((plan) => plan.label).sort(), ['NO', 'YES']);
    assert.equal(state.totals.plannedOrders, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('quote planner sizes orders from market reward min size', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.REWARDS_BLOCKED_CATEGORIES = '';
  process.env.REWARDS_BLOCKED_KEYWORDS = '';
  process.env.REWARDS_MIN_SECONDS_TO_CLOSE = '3600';
  process.env.REWARDS_MARKET_MAX_NOTIONAL = '100';
  process.env.REWARDS_GLOBAL_MAX_NOTIONAL = '150';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/rewards/markets/current')) {
      return jsonResponse([
        {
          id: 'high-min-size-market',
          condition_id: '0xhighmin',
          question: 'Will an incentive-sized quote be planned?',
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
    assert.deepEqual(state.candidates[0].rejectReasons, []);
    assert.equal(state.quotePlans.length, 2);
    assert.deepEqual([...new Set(state.quotePlans.map((plan) => plan.size))], [50]);
    assert.equal(state.totals.plannedOrders, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('scanner ranks actionable capital-fit markets before high-reward blocked markets', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.REWARDS_BLOCKED_CATEGORIES = '';
  process.env.REWARDS_BLOCKED_KEYWORDS = '';
  process.env.REWARDS_MIN_SECONDS_TO_CLOSE = '3600';
  process.env.REWARDS_MARKET_MAX_NOTIONAL = '20';
  process.env.REWARDS_GLOBAL_MAX_NOTIONAL = '50';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/rewards/markets/current')) {
      return jsonResponse([
        marketFixture('expensive-reward', 'Expensive crowded weather outcome', 100, 100),
        marketFixture('small-fit', 'Smaller fundable weather outcome', 8, 5),
      ]);
    }
    if (url.includes('/book?token_id=yes-expensive-reward')) {
      return jsonResponse({ bids: [{ price: '0.49', size: '500' }], asks: [{ price: '0.51', size: '200' }] });
    }
    if (url.includes('/book?token_id=no-expensive-reward')) {
      return jsonResponse({ bids: [{ price: '0.48', size: '500' }], asks: [{ price: '0.52', size: '200' }] });
    }
    if (url.includes('/book?token_id=yes-small-fit')) {
      return jsonResponse({ bids: [{ price: '0.49', size: '100' }], asks: [{ price: '0.51', size: '100' }] });
    }
    if (url.includes('/book?token_id=no-small-fit')) {
      return jsonResponse({ bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.52', size: '100' }] });
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const state = await runRewardsTick(loadRewardsAppConfig());
    assert.equal(state.candidates[0].id, 'small-fit');
    assert.equal(state.candidates[0].rejectReasons.length, 0);
    assert.equal(state.candidates[1].id, 'expensive-reward');
    assert.equal(state.quotePlans.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('low-probability reward markets surface quote price and capital blockers', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.REWARDS_BLOCKED_CATEGORIES = '';
  process.env.REWARDS_BLOCKED_KEYWORDS = '';
  process.env.REWARDS_MIN_SECONDS_TO_CLOSE = '3600';
  process.env.REWARDS_MARKET_MAX_NOTIONAL = '10';
  process.env.REWARDS_GLOBAL_MAX_NOTIONAL = '100';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/rewards/markets/current')) {
      return jsonResponse([
        {
          id: 'long-shot-market',
          condition_id: '0xlongshot',
          question: 'Will a long shot happen?',
          category: 'sports',
          active: true,
          closed: false,
          accepting_orders: true,
          daily_reward: 13,
          min_incentive_size: 20,
          max_incentive_spread: 4.5,
          market_competitiveness: 1,
          end_date_iso: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
          tokens: [
            { outcome: 'Yes', token_id: 'yes-long-shot' },
            { outcome: 'No', token_id: 'no-long-shot' },
          ],
        },
      ]);
    }
    if (url.includes('/book?token_id=yes-long-shot')) {
      return jsonResponse({ bids: [{ price: '0.01', size: '100' }], asks: [{ price: '0.05', size: '100' }] });
    }
    if (url.includes('/book?token_id=no-long-shot')) {
      return jsonResponse({ bids: [{ price: '0.95', size: '100' }], asks: [{ price: '0.99', size: '100' }] });
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const state = await runRewardsTick(loadRewardsAppConfig());
    assert.equal(state.quotePlans.length, 0);
    assert.deepEqual(state.candidates[0].rejectReasons, [
      'reward-sized quote is outside price or incentive-spread limits',
      'minimum reward-sized quote exceeds per-market notional cap',
    ]);
    assert.equal(state.candidates[0].estimatedRequiredCapital, 19.2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('reward markets require enough bid and ask depth for reward-sized quotes', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.REWARDS_BLOCKED_CATEGORIES = '';
  process.env.REWARDS_BLOCKED_KEYWORDS = '';
  process.env.REWARDS_MIN_SECONDS_TO_CLOSE = '3600';
  process.env.REWARDS_MARKET_MAX_NOTIONAL = '100';
  process.env.REWARDS_GLOBAL_MAX_NOTIONAL = '100';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/rewards/markets/current')) {
      return jsonResponse([marketFixture('thin-depth', 'Thin depth reward market', 10, 50)]);
    }
    if (url.includes('/book?token_id=yes-thin-depth')) {
      return jsonResponse({ bids: [{ price: '0.49', size: '80' }], asks: [{ price: '0.51', size: '100' }] });
    }
    if (url.includes('/book?token_id=no-thin-depth')) {
      return jsonResponse({ bids: [{ price: '0.48', size: '250' }], asks: [{ price: '0.52', size: '20' }] });
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const state = await runRewardsTick(loadRewardsAppConfig());
    assert.equal(state.quotePlans.length, 0);
    assert.match(state.candidates[0].rejectReasons.join('\n'), /YES bid depth 80\.00 is below required 200\.00/);
    assert.match(state.candidates[0].rejectReasons.join('\n'), /NO ask depth 20\.00 is below required 50\.00/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

function marketFixture(id: string, question: string, dailyReward: number, minSize: number) {
  return {
    id,
    condition_id: id,
    question,
    category: 'weather',
    active: true,
    closed: false,
    accepting_orders: true,
    daily_reward: dailyReward,
    min_incentive_size: minSize,
    max_incentive_spread: 5,
    market_competitiveness: 1,
    end_date_iso: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    tokens: [
      { outcome: 'Yes', token_id: `yes-${id}` },
      { outcome: 'No', token_id: `no-${id}` },
    ],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
