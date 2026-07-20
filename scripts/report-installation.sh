#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

endpoint="${INSTALL_REPORT_ENDPOINT:-https://claude-ai.zmkk.edu.kg/api/v1/installations/report}"
marker_file="${1:-${INSTALL_REPORT_MARKER:-$ROOT_DIR/data/.installation-reported}}"

if [[ -f "$marker_file" ]]; then
  printf '%s\n' "Installation report was already sent for this deployment."
  exit 0
fi

reported=false
if command -v curl >/dev/null 2>&1; then
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$endpoint" 2>/dev/null || true)"
  if [[ "$status_code" =~ ^2[0-9][0-9]$ ]]; then
    reported=true
  fi
elif command -v node >/dev/null 2>&1; then
  if INSTALL_REPORT_ENDPOINT="$endpoint" node --input-type=module -e '
    const response = await fetch(process.env.INSTALL_REPORT_ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) process.exit(1);
  ' >/dev/null 2>&1; then
    reported=true
  fi
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if docker compose exec -T -e INSTALL_REPORT_ENDPOINT="$endpoint" relayapi \
    node --input-type=module -e '
      const response = await fetch(process.env.INSTALL_REPORT_ENDPOINT, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) process.exit(1);
    ' >/dev/null 2>&1; then
    reported=true
  fi
fi

if [[ "$reported" != "true" ]]; then
  printf '%s\n' "Installation report failed; the next deployment will retry: $endpoint" >&2
  exit 1
fi

mkdir -p "$(dirname "$marker_file")"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker_file"
printf '%s\n' "Installation report sent: $endpoint"
