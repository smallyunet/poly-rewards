# Polymarket Rewards Strategy Assessment

Date: 2026-07-05

## Summary

This repository is now a dedicated Polymarket rewards market-making scanner.
The primary runtime does not run directional prediction logic. It scans
reward-enabled markets, enriches them with CLOB market and orderbook data,
ranks candidates, and produces monitor-only quote plans.

The current live-order boundary is intentionally closed. The system plans
quotes, explains eligibility, and surfaces risk controls, but it does not post
orders from the main worker.

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

Before any live order path is added:

- Scanner lists reward markets and shows real market titles/categories.
- Candidate ranking explains selected and rejected markets.
- Quote plans are dry-run only.
- Notional caps block oversize markets by default.
- The dashboard shows risk controls and diagnostics.

Before increasing scope:

- Add persisted reward accounting.
- Add open-order reconciliation for whitelisted markets.
- Add fail-safe cancellation.
- Add inventory and mark-to-market PnL.
- Attribute liquidity rewards, maker rebates, spread capture, and final resolution PnL separately.
