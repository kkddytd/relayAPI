const fs = require("node:fs");
const path = require("node:path");

const stableEnvironmentFile = process.env.KK_ENV_FILE || "/var/lib/kk-model-monitor/.env";

function readEnvValue(name) {
  for (const filePath of [stableEnvironmentFile, path.join(__dirname, ".env"), path.join(__dirname, ".env.local")]) {
    try {
      const line = fs.readFileSync(filePath, "utf8").split(/\r?\n/).find((item) => item.trim().startsWith(`${name}=`));
      if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
    } catch {
      // The environment file is optional for local development.
    }
  }
  return "";
}

const trackerDataDirectory = process.env.INSTALL_TRACKER_DATA_DIR
  || readEnvValue("INSTALL_TRACKER_DATA_DIR")
  || (process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, "install-tracker")
    : path.join(__dirname, "data/install-tracker"));
const trackerTimeZone = process.env.INSTALL_TRACKER_TIME_ZONE || readEnvValue("INSTALL_TRACKER_TIME_ZONE") || "Asia/Shanghai";
const trackerTrustProxy = process.env.INSTALL_TRACKER_TRUST_PROXY || readEnvValue("INSTALL_TRACKER_TRUST_PROXY") || "false";
const historyEncryptionKey = process.env.HISTORY_ENCRYPTION_KEY || readEnvValue("HISTORY_ENCRYPTION_KEY");

module.exports = {
  apps: [
    {
      name: "kangkang-install-tracker",
      cwd: __dirname,
      script: "services/install-tracker/index.mjs",
      interpreter: "node",
      autorestart: true,
      watch: false,
      min_uptime: "10s",
      max_restarts: 10,
      max_memory_restart: "256M",
      kill_timeout: 12000,
      env: {
        NODE_ENV: "production",
        KANGKANG_INSTALL_TRACKER_MAIN: "true",
        INSTALL_TRACKER_HOST: "127.0.0.1",
        INSTALL_TRACKER_PORT: "6723",
        INSTALL_TRACKER_DATA_DIR: trackerDataDirectory,
        INSTALL_TRACKER_TIME_ZONE: trackerTimeZone,
        INSTALL_TRACKER_TRUST_PROXY: trackerTrustProxy,
      },
    },
    {
      name: "kk-model-monitor",
      cwd: __dirname,
      script: "server/index.mjs",
      interpreter: "node",
      autorestart: true,
      watch: false,
      min_uptime: "10s",
      max_restarts: 10,
      max_memory_restart: "512M",
      kill_timeout: 12000,
      env: {
        NODE_ENV: "production",
        KANGKANG_WEB_MAIN: "true",
        HOST: "127.0.0.1",
        PORT: "6722",
        KK_ENV_FILE: stableEnvironmentFile,
        INSTALL_TRACKER_URL: "http://127.0.0.1:6723",
        ...(historyEncryptionKey ? { HISTORY_ENCRYPTION_KEY: historyEncryptionKey } : {}),
        ATTACHMENT_FALLBACK_MODELS: "claude-opus-4-8",
        ATTACHMENT_FALLBACK_PROTOCOLS: "openai-chat",
        ATTACHMENT_FALLBACK_ATTEMPTS: "3",
      },
    },
  ],
};
