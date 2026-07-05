# poly-rewards

Polymarket rewards market-making scanner and operator dashboard.

The main runtime targets reward-enabled Polymarket markets. The first
implementation is deliberately monitor-only: it scans reward markets, ranks
candidates, and produces dry-run BUY YES / BUY NO quote plans without posting
live orders.

## Runtime Model

The worker runs every `BOT_TICK_MS` and produces a rewards dashboard snapshot:

- Fetch reward-enabled markets from the Polymarket CLOB rewards endpoints.
- Fetch YES/NO orderbook summaries when token IDs are available.
- Rank markets by reward-per-capital adjusted for competition and risk tags.
- Reject toxic or operationally unsafe markets before quote planning.
- Produce dry-run two-sided BUY quote plans for eligible markets.
- Keep live posting disabled until whitelist accounting and reconciliation are
  implemented and tested.

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

## Safety Boundary

Live CLOB posting is not part of the current main loop. The existing
Polymarket adapter still supports order placement and cancellation, but the
rewards runtime only plans quotes. The next live phase should add explicit
market whitelisting, open-order reconciliation, fill accounting, fail-safe
cancellation, inventory limits, and reward/PnL attribution before enabling
real orders.

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
