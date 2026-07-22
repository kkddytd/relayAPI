import fs from "node:fs";
import path from "node:path";

export function loadEnvFile(filePath, environment = process.env) {
  if (!filePath || !fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && environment[key] === undefined) environment[key] = value;
  }
}

export function loadEnvironmentFiles(rootDirectory, environment = process.env) {
  loadEnvFile(environment.KK_ENV_FILE || "/var/lib/kk-model-monitor/.env", environment);
  loadEnvFile(path.join(rootDirectory, ".env"), environment);
  loadEnvFile(path.join(rootDirectory, ".env.local"), environment);
  return environment;
}

export function resolveInstallTrackerUrl(environment = process.env) {
  if (environment.INSTALL_TRACKER_URL) return environment.INSTALL_TRACKER_URL;
  const configuredHost = environment.INSTALL_TRACKER_HOST || "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  const port = environment.INSTALL_TRACKER_PORT || "6723";
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}
