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

node scripts/generate-api-key.mjs --ensure
npm ci --no-audit --no-fund
npm run build
export ALLOW_PUBLIC_PROBE_WITHOUT_TURNSTILE="${ALLOW_PUBLIC_PROBE_WITHOUT_TURNSTILE:-true}"

detector_api_key="$(sed -n 's/^DETECTOR_API_KEYS=//p' .env 2>/dev/null | head -n 1)"
printf '\n%s\n' "relayAPI is starting."
printf '%s\n' "Web/API: http://127.0.0.1:${PORT:-6722}"
printf '%s\n' "API docs: http://127.0.0.1:${PORT:-6722}/api-docs"
printf '%s\n' "Detector API key: ${detector_api_key:-not-configured}"
printf '%s\n' "Key file:  $ROOT_DIR/.env (DETECTOR_API_KEYS)"

if [[ "${FOREGROUND:-false}" == "true" ]]; then
  printf '%s\n' "Foreground mode enabled; press Ctrl+C to stop."
  exec npm run start
fi

runtime_directory="${RELAYAPI_RUNTIME_DIR:-$ROOT_DIR/data}"
mkdir -p "$runtime_directory"
pid_file="${RELAYAPI_PID_FILE:-$runtime_directory/relayapi.pid}"
log_file="${RELAYAPI_LOG_FILE:-$runtime_directory/relayapi.log}"
if [[ -f "$pid_file" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    printf '%s\n' "relayAPI is already running (PID $existing_pid)."
    printf '%s\n' "Logs: $log_file"
    exit 0
  fi
  rm -f "$pid_file"
fi

effective_port="${PORT:-$(sed -n 's/^PORT=//p' .env 2>/dev/null | head -n 1)}"
effective_port="${effective_port:-6722}"
server_pid="$(node scripts/start-local-daemon.mjs "$log_file")"
printf '%s\n' "$server_pid" > "$pid_file"
healthy=false
for _ in {1..20}; do
  if node -e "fetch('http://127.0.0.1:${effective_port}/api/v1/health', { signal: AbortSignal.timeout(500) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    healthy=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$healthy" != "true" ]]; then
  printf '%s\n' "relayAPI failed to start. Check $log_file" >&2
  tail -n 40 "$log_file" >&2 || true
  kill "$server_pid" 2>/dev/null || true
  rm -f "$pid_file"
  exit 1
fi
bash scripts/report-installation.sh "$runtime_directory/.installation-reported" || true
printf '%s\n' "relayAPI started in background (PID $server_pid)."
printf '%s\n' "Logs: $log_file"
printf '%s\n' "Stop: kill $server_pid (or kill \"\$(cat '$pid_file')\")"
