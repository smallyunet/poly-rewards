# poly-rewards Skills

Scenario guides for the Polymarket rewards scanner, guarded execution service,
and market-making dashboard.

- `rewards-monitor/` - local monitor-mode scanner validation.
- `rewards-docker/` - local Docker run path.
- `rewards-deploy/` - server deployment with Docker Compose and Caddy.
- `rewards-troubleshooting/` - scanner, reward API, orderbook, and dashboard diagnosis.

The default runtime is monitor mode. It ranks reward-enabled markets and plans
dry-run quotes. Live CLOB posting requires `EXECUTION_MODE=live`, wallet
credentials, whitelist IDs, and execution risk caps.
