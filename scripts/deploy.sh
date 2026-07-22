#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "未检测到 Docker，请先安装 Docker Engine 和 Docker Compose 插件。" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' "未检测到 Docker Compose 插件，请确认 docker compose 命令可用。" >&2
  exit 1
fi

mkdir -p data

# Docker-only hosts do not need Node.js installed just to bootstrap the
# detector credential. Keep the key in the ignored project .env file so
# Compose can inject it into the container on the first run.
if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
fi
. "$ROOT_DIR/scripts/ensure-history-key.sh"
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
  printf '%s\n' "已生成检测 API Key，并保存到 $ROOT_DIR/.env："
  printf '%s\n' "$generated_key"
fi
export ALLOW_PUBLIC_PROBE_WITHOUT_TURNSTILE="${ALLOW_PUBLIC_PROBE_WITHOUT_TURNSTILE:-true}"
printf '%s\n' "正在构建并启动 relayAPI，请稍候..."
if ! docker compose up -d --build --wait --wait-timeout "${RELAYAPI_START_TIMEOUT_SECONDS:-180}"; then
  printf '%s\n' "relayAPI 启动失败，最近日志如下：" >&2
  docker compose logs --tail=80 relayapi >&2 || true
  exit 1
fi

install_marker="${INSTALL_REPORT_MARKER:-${RELAYAPI_DATA_DIR:-$ROOT_DIR/data}/.installation-reported}"
bash scripts/report-installation.sh "$install_marker" || true

detector_api_key="$(sed -n 's/^DETECTOR_API_KEYS=//p' .env 2>/dev/null | head -n 1)"
printf '\n%s\n' "relayAPI 已启动。"
printf '%s\n' "访问地址：http://127.0.0.1:${RELAYAPI_PORT:-6722}"
printf '%s\n' "检测 API Key：${detector_api_key:-未配置}"
printf '%s\n' "API Key 配置文件：$ROOT_DIR/.env（DETECTOR_API_KEYS）"
printf '%s\n' "历史密钥配置文件：$ROOT_DIR/.env.local（HISTORY_ENCRYPTION_KEY）"
printf '%s\n' "查看日志：docker compose logs -f relayapi"
