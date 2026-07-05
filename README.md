# poly-rewards

Polymarket rewards market-making scanner and operator dashboard.

The main runtime targets reward-enabled Polymarket markets. It defaults to
monitor mode: it scans reward markets, ranks candidates, and produces dry-run
BUY YES / BUY NO quote plans without posting live orders. Live execution is
available only behind explicit `EXECUTION_MODE=live`, wallet credentials,
market whitelisting, reconciliation, collateral, and inventory controls.

## Runtime Model

The worker runs every `BOT_TICK_MS` and produces a rewards dashboard snapshot:

- Fetch reward-enabled markets from the Polymarket CLOB rewards endpoints.
- Fetch YES/NO orderbook summaries when token IDs are available.
- Rank markets by reward-per-capital adjusted for competition and risk tags.
- Reject toxic or operationally unsafe markets before quote planning.
- Produce two-sided BUY quote plans for eligible markets.
- In monitor mode, report the plans without posting.
- In live mode, reconcile open orders, cancel stale managed orders, and post
  only whitelisted quotes that pass collateral and inventory limits.
- Persist managed orders, execution events, and inferred fill records under
  `RUNTIME_STATE_PATH` so live mode can recover managed order state after a
  process restart.

## Strategy Direction

The intended first strategy is conservative rewards market making:

```text
BUY YES at adjusted_midpoint - offset
BUY NO  at 1 - adjusted_midpoint - offset
```

The scanner favors markets with visible daily rewards, lower competition, lower
minimum incentive size, wider incentive spread, clear rules, and enough time
before resolution. It rejects close-to-resolution markets, missing books,
blocked categories, and keyword-risk markets such as short-duration crypto,
live sports, and breaking-news style markets.

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
BOT_TICK_MS=10000
RUNTIME_STATE_PATH=data/runtime-state.json
```

Rewards scanner and quote planner:

```dotenv
REWARDS_ENABLED=true
REWARDS_SCANNER_LIMIT=80
REWARDS_CANDIDATE_LIMIT=12
REWARDS_QUOTE_SIZE=5
REWARDS_QUOTE_OFFSET=0.015
REWARDS_MIN_DAILY_REWARD=1
REWARDS_MIN_SECONDS_TO_CLOSE=86400
REWARDS_GLOBAL_MAX_NOTIONAL=100
REWARDS_MARKET_MAX_NOTIONAL=10
REWARDS_MAX_OPEN_MARKETS=10
REWARDS_MAX_MIDPOINT_DRIFT=0.015
REWARDS_MAX_ORDER_AGE_SECONDS=60
REWARDS_MAX_ORDERBOOK_AGE_SECONDS=5
REWARDS_MAX_INVENTORY_SHARES_PER_OUTCOME=20
REWARDS_MIN_COLLATERAL_BALANCE=5
REWARDS_MAX_ACTIVE_ORDERS_PER_MARKET=2
REWARDS_LIVE_WHITELIST_ONLY=true
REWARDS_WHITELIST_MARKET_IDS=
REWARDS_BLOCKED_CATEGORIES=crypto,geopolitics
REWARDS_BLOCKED_KEYWORDS=5m,15m,live,in-play,missile,strike,war,attack,breaking
```

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
- A non-empty `REWARDS_WHITELIST_MARKET_IDS` list when
  `REWARDS_LIVE_WHITELIST_ONLY=true`.
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
