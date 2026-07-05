#!/usr/bin/env bash
set -euo pipefail

SERVER="${SERVER:-a}"
APP_DIR="${APP_DIR:-~/apps/poly-rewards}"
COMPOSE_FILE="docker-compose.prod.yml"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
GIT_SHA="$(git -C "${ROOT_DIR}" rev-parse --short HEAD)"
if ! git -C "${ROOT_DIR}" diff --quiet || ! git -C "${ROOT_DIR}" diff --cached --quiet; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export APP_VERSION GIT_SHA BUILD_TIME

remote_compose() {
  local compose_args="$1"
  ssh "${SERVER}" "cd ${APP_DIR} && APP_VERSION='${APP_VERSION}' GIT_SHA='${GIT_SHA}' BUILD_TIME='${BUILD_TIME}' COMPOSE_PROJECT_NAME='poly-rewards' && export APP_VERSION GIT_SHA BUILD_TIME COMPOSE_PROJECT_NAME && if docker compose version >/dev/null 2>&1; then docker compose ${compose_args}; elif command -v docker-compose >/dev/null 2>&1; then docker-compose ${compose_args}; else echo 'Docker Compose is not installed' >&2; exit 1; fi"
}

echo "[deploy] server=${SERVER} app_dir=${APP_DIR}"
echo "[deploy] version=${APP_VERSION} git_sha=${GIT_SHA} build_time=${BUILD_TIME}"

ssh "${SERVER}" "mkdir -p ${APP_DIR}/data"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  "${ROOT_DIR}/" "${SERVER}:${APP_DIR}/"

ssh "${SERVER}" "cd ${APP_DIR} && if [ ! -f .env ]; then cp .env.example .env; echo '[deploy] created .env from .env.example; review rewards scanner settings before enabling any live order path'; fi"
ssh "${SERVER}" "cd ${APP_DIR} && chmod 600 .env"
ssh "${SERVER}" "cd ${APP_DIR} && if grep -Eq 'poly-btc5m|btc5m|b\\.dark20|8788|4174|8088|8444|8454' .env; then echo '[deploy] refusing to continue: remote .env contains old btc5m names or ports. Review ~/apps/poly-rewards/.env first.' >&2; exit 1; fi"
ssh "${SERVER}" "cd ${APP_DIR} && COMPOSE_PROJECT_NAME='poly-rewards' && export COMPOSE_PROJECT_NAME && api_container=\$(if docker compose version >/dev/null 2>&1; then docker compose -f ${COMPOSE_FILE} ps -q api; elif command -v docker-compose >/dev/null 2>&1; then docker-compose -f ${COMPOSE_FILE} ps -q api; else true; fi) && if [ -n \"\$api_container\" ] && [ ! -s data/runtime-state.json ]; then docker cp \"\$api_container:/app/data/runtime-state.json\" data/runtime-state.json >/dev/null 2>&1 && echo '[deploy] preserved runtime state from existing API container' || true; fi"
remote_compose "-f ${COMPOSE_FILE} up -d --build --remove-orphans"
remote_compose "-f ${COMPOSE_FILE} ps"

echo "[deploy] done. In the default non-conflicting setup, point the public reverse proxy to http://127.0.0.1:${HTTP_PORT:-8098}/."
