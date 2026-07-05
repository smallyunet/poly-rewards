# Rewards Docker

Use this guide for a local Docker run of the rewards dashboard.

## Run

```bash
cp .env.example .env
docker compose up --build api web
```

Endpoints:

```text
API + dashboard: http://localhost:8798
Static web container: http://localhost:4184
```

## Notes

- The API container serves the built dashboard when `WEB_DIST_DIR=/app/dist/apps/web`.
- Runtime state is written to the configured `RUNTIME_STATE_PATH`.
- The default runtime only scans and plans dry-run quotes.
