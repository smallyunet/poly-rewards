# Rewards Monitor

Use this guide to validate the scanner locally without posting orders.

## Run

```bash
cp .env.example .env
npm install
npm run typecheck
npm run dev:api
```

Open:

```text
http://localhost:8798
```

## Expected State

- `/api/status` reports `executionMode=monitor`.
- `/api/state` includes a `rewards` object.
- `rewards.marketsScanned` is greater than zero when the CLOB rewards API is reachable.
- Candidate rows show market question, category, min size, max spread, tags, and reject reasons.
- Quote plans appear only when candidates pass notional caps, reward threshold, token enrichment, and orderbook checks.

## Useful Commands

```bash
curl -s http://localhost:8798/api/status
curl -s http://localhost:8798/api/state
curl -X POST http://localhost:8798/api/tick
```
