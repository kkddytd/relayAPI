#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js 20.19+ or 22 LTS is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "npm is required." >&2
  exit 1
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); const supported = (major === 20 && minor >= 19) || major >= 22; if (!supported) process.exit(1)'

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
fi

npm install --no-audit --no-fund
npm run build

printf '\n%s\n' "relayAPI is starting."
printf '%s\n' "Web/API: http://127.0.0.1:${PORT:-6722}"
printf '%s\n' "API docs: http://127.0.0.1:${PORT:-6722}/api-docs"
printf '%s\n' "Press Ctrl+C to stop."
exec npm run start
