# poly-rewards

Polymarket rewards market-making scanner and operator dashboard.

The main runtime targets reward-enabled Polymarket markets. It defaults to
monitor mode: it scans reward markets, ranks candidates, and produces dry-run
BUY YES / BUY NO quote plans without posting live orders. Live execution is
available only behind explicit `EXECUTION_MODE=live`, wallet credentials,
reconciliation, collateral, inventory, and active-order controls.

## Runtime Model

The worker runs every `BOT_TICK_MS` and produces a rewards dashboard snapshot:

- Fetch reward-enabled markets from the Polymarket CLOB rewards endpoints.
- Fetch YES/NO orderbook summaries when token IDs are available.
- Rank markets by reward-per-capital adjusted for competition and risk tags.
- Reject toxic or operationally unsafe markets before quote planning.
- Produce two-sided BUY quote plans for eligible markets.
- In monitor mode, report the plans without posting.
- In live mode, reconcile open orders, cancel stale managed orders, and post
  only quotes that pass collateral and inventory limits.
- Size quotes from each market's Polymarket `min_incentive_size`; markets are
  rejected only when capital, notional, spread, or risk controls cannot support
  the reward-sized plan.
- Prefer affordable quote plans during live execution by trying lower-notional
  plans before higher-notional plans.
- Persist managed orders, execution events, and inferred fill records under
  `RUNTIME_STATE_PATH` so live mode can recover managed order state after a
  process restart.

## Strategy Direction

The intended first strategy is defensive rewards market making:

```text
offset  = max(current_market_spread / 2, max_incentive_spread * 0.85)
BUY YES = adjusted_midpoint - offset
BUY NO  = 1 - adjusted_midpoint - offset
```

For a market that allows `+-4c`, the default target is about `3.4c` away from
midpoint, staying reward-eligible while reducing the chance of being picked off
near the live market price.

The scanner favors markets with visible daily rewards, lower competition, wider
incentive spread, clear rules, enough time before resolution, and a reward
minimum size that fits the configured capital caps. It rejects
close-to-resolution markets, reward-sized plans that exceed notional caps,
missing books, blocked categories, and keyword-risk markets such as
short-duration crypto, live sports, and breaking-news style markets.

## Local Development

```bash
cp .env.example .env
npm install
npm run typecheck
npm run build
npm run dev:api
```

Open the dashboard at http://localhost:8798.

## Configuration

Core runtime:

```dotenv
EXECUTION_MODE=monitor
POLYMARKET_CLOB_API_URL=https://clob.polymarket.com
POLYMARKET_CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
BOT_TICK_MS=10000
RUNTIME_STATE_PATH=data/runtime-state.json
```

Rewards scanner and quote planner:

```dotenv
REWARDS_ENABLED=true
REWARDS_SCANNER_LIMIT=80
REWARDS_CANDIDATE_LIMIT=12
REWARDS_MIN_DAILY_REWARD=1
REWARDS_MIN_SECONDS_TO_CLOSE=86400
REWARDS_GLOBAL_MAX_NOTIONAL=100
REWARDS_MARKET_MAX_NOTIONAL=10
REWARDS_MAX_OPEN_MARKETS=10
REWARDS_MAX_MIDPOINT_DRIFT=0.015
REWARDS_DRIFT_OFFSET_RATIO=0.5
REWARDS_MAX_ORDER_AGE_SECONDS=600
REWARDS_MAX_ORDER_HARD_AGE_SECONDS=1800
REWARDS_MAX_ORDERBOOK_AGE_SECONDS=5
REWARDS_MAX_INVENTORY_SHARES_PER_OUTCOME=20
REWARDS_MAX_QUEUE_SHARE=0.25
REWARDS_MIN_SIDE_DEPTH_MULTIPLIER=4
REWARDS_MIN_ASK_DEPTH_MULTIPLIER=1
REWARDS_INVENTORY_EXIT_ENABLED=true
REWARDS_MAX_UNHEDGED_INVENTORY_AGE_SECONDS=600
REWARDS_MAX_INVENTORY_LOSS_PER_SHARE=0.05
REWARDS_MIN_INVENTORY_EXIT_SHARES=1
REWARDS_MIN_COLLATERAL_BALANCE=5
REWARDS_MAX_ACTIVE_ORDERS_PER_MARKET=2
REWARDS_BLOCKED_CATEGORIES=crypto,geopolitics
REWARDS_BLOCKED_KEYWORDS=5m,15m,live,in-play,missile,strike,war,attack,breaking
```

Order management is drift-first. Managed orders are not cancelled merely
because they are 60 seconds old. They are cancelled when the current quote plan
disappears, price drift exceeds `max(REWARDS_MAX_MIDPOINT_DRIFT,
plannedOffset * REWARDS_DRIFT_OFFSET_RATIO)`, orderbook data is stale, or the
long hard-refresh age is reached.

For markets with active quote plans or active managed orders, the worker
subscribes to Polymarket's public market WebSocket and uses live orderbook
updates before falling back to REST snapshots.

Reward-sized quotes also require enough visible depth on both outcomes. A market
is rejected unless each planned side has bid depth of at least
`REWARDS_MIN_SIDE_DEPTH_MULTIPLIER * planSize`, the plan size is no more than
`REWARDS_MAX_QUEUE_SHARE` of bid depth, and ask depth is at least
`REWARDS_MIN_ASK_DEPTH_MULTIPLIER * planSize`.

Execution is market-bundle first: YES and NO reward quotes must both be eligible
and affordable before new orders are posted. If one side is already filled or
open, it is treated as the covered side and the worker only posts the missing
side. If a newly posted bundle fails halfway through, the worker cancels the
newly posted side to avoid leaving a single-sided order.

Inventory exits are enabled by default. Unhedged filled inventory is sold at the
current best bid after `REWARDS_MAX_UNHEDGED_INVENTORY_AGE_SECONDS`, or sooner
when the per-share loss reaches `REWARDS_MAX_INVENTORY_LOSS_PER_SHARE`.

## API

- `GET /api/state` returns the dashboard state, including `rewards`.
- `POST /api/tick` runs one scanner tick.
- `GET /api/status` returns runtime status.
- `GET /api/config/current` returns the active rewards config.
- `GET /api/execution` returns the latest live/monitor execution state.

## Safety Boundary

Live CLOB posting is off by default. It requires:

- `EXECUTION_MODE=live`.
- `OWNER_PRIVATE_KEY` and `POLYMARKET_DEPOSIT_WALLET`.
- Passing collateral reserve, per-market active-order, inventory, age,
  midpoint-drift, and orderbook-freshness checks.

The execution service only cancels orders it posted and tracks in the current
process or restored from `RUNTIME_STATE_PATH`. External/manual open orders on
the same token cause the planner to skip posting a duplicate, but they are not
cancelled.

Managed order state, execution events, and fill records are persisted. Fill
records are inferred from CLOB open-order `sizeMatched` deltas and terminal
reconciliation when a previously managed order is no longer open. The dashboard
shows filled size, cost basis, open managed buy size, and recent fills. Final
resolution PnL and actual Polymarket reward attribution still require external
settlement/reward data and are not treated as realized profit in this runtime.

## Docker

```bash
cp .env.example .env
docker compose up --build api web
```

API + dashboard: http://localhost:8798

Standalone web container: http://localhost:4184

## Server Deployment

If `ssh a` logs into the target server:

```bash
./deploy/deploy-a.sh
```

The default remote path is:

```text
~/apps/poly-rewards
```

Runtime state is persisted under:

```text
~/apps/poly-rewards/data/runtime-state.json
```
