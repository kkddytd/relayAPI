#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
history_env_file="${RELAYAPI_LOCAL_ENV_FILE:-$ROOT_DIR/.env.local}"
history_encryption_key="VaHJ60Zvd+szpeL+fHCDHKcuml3ha7NtBJ750ukG4T8="

mkdir -p "$(dirname "$history_env_file")"
if [[ -f "$history_env_file" ]]; then
  temporary_env="$(mktemp "${history_env_file}.XXXXXX")"
  awk -v value="$history_encryption_key" '
    BEGIN { updated = 0 }
    /^[[:space:]]*(export[[:space:]]+)?HISTORY_ENCRYPTION_KEY[[:space:]]*=/ {
      if (!updated) print "HISTORY_ENCRYPTION_KEY=" value
      updated = 1
      next
    }
    { print }
    END { if (!updated) print "HISTORY_ENCRYPTION_KEY=" value }
  ' "$history_env_file" > "$temporary_env"
  mv "$temporary_env" "$history_env_file"
else
  printf '%s\n' "HISTORY_ENCRYPTION_KEY=$history_encryption_key" > "$history_env_file"
fi

chmod 600 "$history_env_file" 2>/dev/null || true
export HISTORY_ENCRYPTION_KEY="$history_encryption_key"
