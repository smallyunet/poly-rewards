# Rewards Troubleshooting

Use this guide when the rewards scanner or dashboard is not behaving as
expected.

## Scanner Returns No Markets

Check:

```bash
curl -s http://localhost:8798/api/state
```

Look at `rewards.diagnostics`. Common causes:

- CLOB rewards endpoint unavailable.
- Network failure from the runtime host.
- `REWARDS_ENABLED=false`.

## Candidates Have No Quote Plans

Check each candidate's `rejectReasons`. Common reasons:

- `minimum incentive size exceeds per-market notional cap`
- `missing orderbook`
- `daily reward is below threshold`
- `keyword risk block`

For dry-run exploration, raise:

```dotenv
REWARDS_MARKET_MAX_NOTIONAL=50
REWARDS_GLOBAL_MAX_NOTIONAL=200
```

## Dashboard Is Empty

Check:

```bash
curl -s http://localhost:8798/api/status
curl -s http://localhost:8798/api/state
```

If `/api/state` has data but the page is empty, rebuild the web bundle:

```bash
npm run build
```
