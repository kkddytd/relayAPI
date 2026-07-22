#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "需要 Node.js 20.19+、22.12+ 或更高版本，推荐使用 Node.js 22 LTS。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "未检测到 npm，请先安装 Node.js 和 npm。" >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23; if (!supported) process.exit(1)'; then
  printf '%s\n' "当前 Node.js 版本不受支持，需要 Node.js 20.19+、22.12+ 或更高版本，推荐使用 Node.js 22 LTS。" >&2
  exit 1
fi

pdf_runtime_ready() {
  command -v pdfinfo >/dev/null 2>&1 \
    && command -v gs >/dev/null 2>&1 \
    && { command -v gm >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; }
}

run_privileged() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    printf '%s\n' "安装 PDF 运行依赖需要 root 权限或 sudo。" >&2
    return 1
  fi
}

if ! pdf_runtime_ready; then
  printf '%s\n' "正在安装 PDF 转图运行依赖..."
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y graphicsmagick ghostscript poppler-utils
  elif command -v brew >/dev/null 2>&1; then
    brew install graphicsmagick ghostscript poppler
  else
    printf '%s\n' "未找到 apt-get 或 Homebrew，无法安装 GraphicsMagick、Ghostscript 和 Poppler。" >&2
    exit 1
  fi
fi

if ! pdf_runtime_ready; then
  printf '%s\n' "PDF 转图运行依赖安装不完整，请确认 gm、gs 和 pdfinfo 命令可用。" >&2
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

detector_api_key="$(sed -n 's/^DETECTOR_API_KEYS=//p' .env 2>/dev/null | head -n 1)"
effective_port="${PORT:-$(sed -n 's/^PORT=//p' .env 2>/dev/null | head -n 1)}"
effective_port="${effective_port:-6722}"
printf '\n%s\n' "正在启动 relayAPI..."
printf '%s\n' "访问地址：http://127.0.0.1:${effective_port}"
printf '%s\n' "API 文档：http://127.0.0.1:${effective_port}/api-docs"
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
pid_belongs_to_relayapi() {
  local candidate_pid="$1"
  local command_line
  command_line="$(ps -p "$candidate_pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *"$ROOT_DIR/server/start.mjs"* || "$command_line" == *"$ROOT_DIR/server/index.mjs"* ]]
}
if [[ -f "$pid_file" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null && pid_belongs_to_relayapi "$existing_pid"; then
    printf '%s\n' "正在重启已有 relayAPI 进程（PID：${existing_pid}）..."
    kill "$existing_pid" 2>/dev/null || true
    for _ in {1..48}; do
      if ! kill -0 "$existing_pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$existing_pid" 2>/dev/null; then
      kill -KILL "$existing_pid" 2>/dev/null || true
    fi
  elif [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    printf '%s\n' "PID 文件指向的进程不是当前 relayAPI，已忽略该进程。"
  fi
  rm -f "$pid_file"
fi

server_pid="$(node scripts/start-local-daemon.mjs "$log_file")"
printf '%s\n' "$server_pid" > "$pid_file"
healthy=false
for _ in {1..20}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  if node -e "fetch('http://127.0.0.1:${effective_port}/api/v1/health', { signal: AbortSignal.timeout(500) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    healthy=true
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
printf '%s\n' "relayAPI 已在后台启动（PID：${server_pid}）。"
printf '%s\n' "日志文件：$log_file"
printf '%s\n' "停止命令：kill ${server_pid}（或执行 kill \"\$(cat '$pid_file')\"）"
