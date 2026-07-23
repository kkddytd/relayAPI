#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

endpoint="${INSTALL_REPORT_ENDPOINT:-https://claude-ai.zmkk.edu.kg/api/v1/installations/report}"
marker_file="${1:-${INSTALL_REPORT_MARKER:-$ROOT_DIR/data/.installation-reported}}"
marker_directory="$(dirname "$marker_file")"
queue_directory="${INSTALL_REPORT_QUEUE_DIR:-$marker_directory/.installation-report-queue}"
retry_attempts="${INSTALL_REPORT_ATTEMPTS:-3}"
retry_delay_seconds="${INSTALL_REPORT_RETRY_DELAY_SECONDS:-2}"

if [[ ! "$retry_attempts" =~ ^[1-9][0-9]*$ ]] || (( retry_attempts > 10 )); then
  retry_attempts=3
fi
if [[ ! "$retry_delay_seconds" =~ ^[0-9]+$ ]] || (( retry_delay_seconds > 60 )); then
  retry_delay_seconds=2
fi

umask 077
if ! mkdir -p "$marker_directory" "$queue_directory"; then
  printf '%s\n' "无法创建安装统计待上报目录。" >&2
  exit 1
fi

create_event_id() {
  local token=""
  if command -v openssl >/dev/null 2>&1; then
    token="$(openssl rand -hex 16 2>/dev/null || true)"
  fi
  if [[ -z "$token" ]] && command -v node >/dev/null 2>&1; then
    token="$(node -e 'process.stdout.write(require("node:crypto").randomUUID().replaceAll("-", ""))' 2>/dev/null || true)"
  fi
  if [[ -z "$token" ]] && [[ -r /dev/urandom ]] && command -v od >/dev/null 2>&1; then
    token="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  fi
  if [[ -z "$token" ]]; then
    token="$(date -u +%Y%m%d%H%M%S)-$$-${RANDOM:-0}"
  fi
  printf 'relayapi-%s\n' "$token"
}

send_with_curl() {
  local event_id="$1"
  local status_code
  command -v curl >/dev/null 2>&1 || return 1
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 12 \
    -X POST -H "Idempotency-Key: $event_id" "$endpoint" 2>/dev/null || true)"
  [[ "$status_code" == "204" ]]
}

send_with_node() {
  local event_id="$1"
  command -v node >/dev/null 2>&1 || return 1
  INSTALL_REPORT_ENDPOINT="$endpoint" INSTALL_REPORT_EVENT_ID="$event_id" node --input-type=module -e '
    const response = await fetch(process.env.INSTALL_REPORT_ENDPOINT, {
      method: "POST",
      headers: { "Idempotency-Key": process.env.INSTALL_REPORT_EVENT_ID },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status !== 204) process.exit(1);
  ' >/dev/null 2>&1
}

send_with_docker() {
  local event_id="$1"
  command -v docker >/dev/null 2>&1 || return 1
  docker compose version >/dev/null 2>&1 || return 1
  docker compose exec -T \
    -e INSTALL_REPORT_ENDPOINT="$endpoint" \
    -e INSTALL_REPORT_EVENT_ID="$event_id" \
    relayapi node --input-type=module -e '
      const response = await fetch(process.env.INSTALL_REPORT_ENDPOINT, {
        method: "POST",
        headers: { "Idempotency-Key": process.env.INSTALL_REPORT_EVENT_ID },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status !== 204) process.exit(1);
    ' >/dev/null 2>&1
}

send_once() {
  local event_id="$1"
  send_with_curl "$event_id" && return 0
  send_with_node "$event_id" && return 0
  send_with_docker "$event_id" && return 0
  return 1
}

send_with_retry() {
  local event_id="$1"
  local attempt=1
  while (( attempt <= retry_attempts )); do
    if send_once "$event_id"; then
      return 0
    fi
    if (( attempt < retry_attempts && retry_delay_seconds > 0 )); then
      sleep "$((retry_delay_seconds * attempt))"
    fi
    attempt="$((attempt + 1))"
  done
  return 1
}

current_event_id="$(create_event_id)"
current_event_file="$queue_directory/$current_event_id.event"
if ! printf '%s\n' "$current_event_id" > "$current_event_file"; then
  printf '%s\n' "无法保存安装统计待上报记录。" >&2
  exit 1
fi

failed_count=0
current_reported=false
for pending_file in "$queue_directory"/*.event; do
  [[ -e "$pending_file" ]] || continue
  pending_event_id=""
  IFS= read -r pending_event_id < "$pending_file" || true
  if [[ ! "$pending_event_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
    failed_count="$((failed_count + 1))"
    continue
  fi
  if send_with_retry "$pending_event_id"; then
    if [[ "$pending_file" == "$current_event_file" ]]; then
      current_reported=true
    fi
    rm -f "$pending_file"
  else
    failed_count="$((failed_count + 1))"
  fi
done

if [[ "$current_reported" == "true" ]]; then
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker_file" 2>/dev/null || true
fi

if (( failed_count > 0 )); then
  exit 1
fi
