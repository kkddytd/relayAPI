#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "需要 Node.js 20.19 或更高版本，推荐使用 Node.js 22 LTS。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "未检测到 npm，请先安装 Node.js 和 npm。" >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); const supported = (major === 20 && minor >= 19) || major >= 22; if (!supported) process.exit(1)'; then
  printf '%s\n' "当前 Node.js 版本过低，需要 20.19 或更高版本，推荐使用 Node.js 22 LTS。" >&2
  exit 1
fi

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
fi

. "$ROOT_DIR/scripts/ensure-history-key.sh"
node scripts/generate-api-key.mjs --ensure >/dev/null
printf '%s\n' "正在安装项目依赖..."
npm ci --no-audit --no-fund
printf '%s\n' "正在构建网页资源..."
npm run build
export ALLOW_PUBLIC_PROBE_WITHOUT_TURNSTILE="${ALLOW_PUBLIC_PROBE_WITHOUT_TURNSTILE:-true}"

detector_api_key="$(sed -n 's/^DETECTOR_API_KEYS=//p' .env 2>/dev/null | head -n 1)"
printf '\n%s\n' "正在启动 relayAPI..."
printf '%s\n' "访问地址：http://127.0.0.1:${PORT:-6722}"
printf '%s\n' "API 文档：http://127.0.0.1:${PORT:-6722}/api-docs"
printf '%s\n' "检测 API Key：${detector_api_key:-未配置}"
printf '%s\n' "API Key 配置文件：$ROOT_DIR/.env（DETECTOR_API_KEYS）"
printf '%s\n' "历史密钥配置文件：$ROOT_DIR/.env.local（HISTORY_ENCRYPTION_KEY）"

if [[ "${FOREGROUND:-false}" == "true" ]]; then
  printf '%s\n' "已启用前台运行模式，按 Ctrl+C 停止服务。"
  exec npm run start
fi

runtime_directory="${RELAYAPI_RUNTIME_DIR:-$ROOT_DIR/data}"
mkdir -p "$runtime_directory"
pid_file="${RELAYAPI_PID_FILE:-$runtime_directory/relayapi.pid}"
log_file="${RELAYAPI_LOG_FILE:-$runtime_directory/relayapi.log}"
if [[ -f "$pid_file" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    printf '%s\n' "relayAPI 已在运行（PID：$existing_pid）。"
    printf '%s\n' "日志文件：$log_file"
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
  printf '%s\n' "relayAPI 启动失败，请查看日志：$log_file" >&2
  tail -n 40 "$log_file" >&2 || true
  kill "$server_pid" 2>/dev/null || true
  rm -f "$pid_file"
  exit 1
fi
bash scripts/report-installation.sh "$runtime_directory/.installation-reported" || true
printf '%s\n' "relayAPI 已在后台启动（PID：$server_pid）。"
printf '%s\n' "日志文件：$log_file"
printf '%s\n' "停止命令：kill $server_pid（或执行 kill \"\$(cat '$pid_file')\"）"
