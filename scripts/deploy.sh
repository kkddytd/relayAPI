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

# Docker-only hosts do not need Node.js installed just to bootstrap the
# detector credential. Keep the key in the ignored project .env file so
# Compose can inject it into the container on the first run.
if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
fi
configured_key="$(sed -n 's/^DETECTOR_API_KEYS=//p' .env 2>/dev/null | head -n 1)"
if [[ -z "${configured_key//[[:space:]]/}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    generated_key="det_$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
  else
    generated_key="det_$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  temporary_env="$(mktemp .env.XXXXXX)"
  awk -v value="$generated_key" '
    BEGIN { updated = 0 }
    /^DETECTOR_API_KEYS=/ { print "DETECTOR_API_KEYS=" value; updated = 1; next }
    { print }
    END { if (!updated) print "DETECTOR_API_KEYS=" value }
  ' .env > "$temporary_env"
  mv "$temporary_env" .env
  chmod 600 .env 2>/dev/null || true
  printf '%s\n' "Generated detector API key and stored it in $ROOT_DIR/.env:"
  printf '%s\n' "$generated_key"
fi
docker compose up -d --build

printf '\n%s\n' "relayAPI is running."
printf '%s\n' "Web/API: http://127.0.0.1:${RELAYAPI_PORT:-6722}"
printf '%s\n' "Logs:     docker compose logs -f relayapi"
