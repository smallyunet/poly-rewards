# Rewards Deploy

Use this guide for server deployment.

## Defaults

```bash
SERVER=a
APP_DIR=~/apps/poly-rewards
```

## Deploy

```bash
./deploy/deploy-a.sh
```

The script syncs this repository to `APP_DIR`, preserves `data/`, creates a
remote `.env` when missing, and starts `docker-compose.prod.yml`.

## Remote State

```text
~/apps/poly-rewards/data/runtime-state.json
```

## Required Review

Before exposing the deployed dashboard, check the remote `.env`:

```dotenv
SITE_DOMAIN=:80
HTTP_PORT=8098
REWARDS_ENABLED=true
REWARDS_LIVE_WHITELIST_ONLY=true
```

In the non-conflicting server setup, the public-domain reverse proxy should
target `http://127.0.0.1:8098`.

The current runtime does not post live CLOB orders.
