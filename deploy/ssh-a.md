# Server deployment on `ssh a`

The default deploy target is:

```bash
SERVER=a
APP_DIR=~/apps/poly-rewards
```

Run:

```bash
./deploy/deploy-a.sh
```

The script syncs this repository to the server, creates `.env` from
`.env.example` if missing, builds the Docker image, and starts
`docker-compose.prod.yml`.

Runtime state is stored outside the API container at:

```bash
~/apps/poly-rewards/data/runtime-state.json
```

The deploy script preserves `data/` across `rsync --delete`, rebuilds, and
container recreates.

Before using the deployed scanner, edit the remote `.env`:

```bash
ssh a
cd ~/apps/poly-rewards
nano .env
```

Keep the rewards runtime in monitor mode until scanner output, candidate
ranking, quote plans, orderbook enrichment, credentials, and risk caps have
been reviewed:

```dotenv
EXECUTION_MODE=monitor
REWARDS_ENABLED=true
REWARDS_GLOBAL_MAX_NOTIONAL=100
REWARDS_MARKET_MAX_NOTIONAL=10
```

Only switch to live mode after setting wallet credentials and execution caps
such as `REWARDS_MAX_INVENTORY_SHARES_PER_OUTCOME`,
`REWARDS_MIN_COLLATERAL_BALANCE`, and
`REWARDS_MAX_ACTIVE_ORDERS_PER_MARKET`.

Caddy is configured as the project-local HTTP proxy by default. Keep this value
when another server-level proxy owns the public domain and forwards traffic to
host port `8098`:

```dotenv
SITE_DOMAIN=:80
HTTP_PORT=8098
```

The public-domain reverse proxy should target:

```text
http://127.0.0.1:8098
```

Only set `SITE_DOMAIN=your-domain.example` and bind `HTTP_PORT=80` if this
project owns the server's public web port. That mode can conflict with another
app already using 80.
