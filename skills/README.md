# poly-rewards Skills

Scenario guides for the Polymarket rewards scanner and dry-run market-making
dashboard.

- `rewards-monitor/` - local monitor-mode scanner validation.
- `rewards-docker/` - local Docker run path.
- `rewards-deploy/` - server deployment with Docker Compose and Caddy.
- `rewards-troubleshooting/` - scanner, reward API, orderbook, and dashboard diagnosis.

The current runtime is monitor-only. It ranks reward-enabled markets and plans
dry-run quotes; it does not post live CLOB orders.
