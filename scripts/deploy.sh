#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "Docker is required. Install Docker Engine and Docker Compose Plugin first." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' "Docker Compose Plugin is required (docker compose)." >&2
  exit 1
fi

mkdir -p data
docker compose up -d --build

printf '\n%s\n' "relayAPI is running."
printf '%s\n' "Web/API: http://127.0.0.1:${RELAYAPI_PORT:-6722}"
printf '%s\n' "Logs:     docker compose logs -f relayapi"
