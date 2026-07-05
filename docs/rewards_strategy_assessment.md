# Polymarket Rewards Strategy Assessment

Date: 2026-07-05

## Summary

This repository is now a dedicated Polymarket rewards market-making scanner
with a guarded live execution path. The primary runtime does not run
directional prediction logic. It scans reward-enabled markets, enriches them
with CLOB market and orderbook data, ranks candidates, and produces quote
plans. By default those plans remain monitor-only.

The live-order boundary is explicit. The system posts only when
`EXECUTION_MODE=live`, credentials are configured, whitelist rules pass, and
the execution service clears reconciliation, collateral, active-order,
inventory, age, midpoint-drift, and orderbook-freshness checks.
Managed order state, execution events, and inferred fill records are persisted
under `RUNTIME_STATE_PATH` for restart recovery.

## Strategy

The first practical strategy is conservative two-sided rewards market making:

```text
BUY YES at adjusted_midpoint - offset
BUY NO  at 1 - adjusted_midpoint - offset
```

The planner favors markets with:

- Visible daily reward rate.
- Lower minimum incentive size.
- Wider maximum incentive spread.
- Lower competition.
- Clear rules and enough time before resolution.
- Usable YES/NO token IDs and orderbooks.

The planner rejects or penalizes:

- Missing orderbook or missing token IDs.
- Markets too close to resolution.
- Very high minimum incentive size relative to configured capital caps.
- Blocked categories and keyword-risk markets.
- Live sports, short-duration crypto, breaking-news, and ambiguous-resolution patterns.

## Runtime Model

The API worker uses a rewards-specific state model:

- `apps/api/src/rewardsConfig.ts` reads scanner and risk configuration.
- `apps/api/src/rewards.ts` fetches markets, enriches metadata, ranks candidates, and plans quotes.
- `apps/api/src/rewardsStore.ts` records rewards snapshots and runtime logs.
- `apps/api/src/server.ts` exposes rewards endpoints and the dashboard state.
- `apps/web/src/App.tsx` renders the rewards dashboard.

## Current Success Criteria

For scanner and planner operation:

- Scanner lists reward markets and shows real market titles/categories.
- Candidate ranking explains selected and rejected markets.
- Quote plans are dry-run in monitor mode.
- Notional caps block oversize markets by default.
- The dashboard shows risk controls and diagnostics.

For guarded live operation:

- Require an explicit live mode and CLOB credentials.
- Require market/condition whitelisting by default.
- Reconcile open orders and avoid duplicate posting on tokens that already have
  active external orders.
- Cancel only managed orders from the current process when age, price drift, or
  orderbook freshness triggers fire, including orders restored from persisted
  execution state.
- Enforce collateral reserve, per-market active-order caps, and per-outcome
  inventory caps before posting.
- Persist managed orders, execution events, and inferred fill records across
  process restarts.
- Surface filled size, cost basis, open managed buy size, recent fills, and
  execution events in the dashboard.

Before increasing size or relying on unattended operation:

- Replace terminal fill inference with durable trade/fill facts if a stronger
  CLOB trade-history source is wired in.
- Add mark-to-market PnL from current orderbooks.
- Distinguish externally cancelled/expired/filled orders beyond open-order
  absence when CLOB terminal status data is available.
- Attribute liquidity rewards, maker rebates, spread capture, and final
  resolution PnL separately.
