import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const requestedPort = Number(process.env.E2E_PORT || 6732);
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 6732;
const requestedTrackerPort = Number(process.env.E2E_TRACKER_PORT || port + 1);
const trackerPort = Number.isInteger(requestedTrackerPort) && requestedTrackerPort > 0
  ? requestedTrackerPort
  : port + 1;
const baseURL = `http://127.0.0.1:${port}`;
if (!process.env.E2E_DATA_DIR) {
  process.env.E2E_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kangkang-e2e-${port}-`));
  process.env.E2E_EPHEMERAL_DATA_DIR = "true";
}
const dataDirectory = process.env.E2E_DATA_DIR;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: false,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDirectory,
      HISTORY_ENCRYPTION_KEY: "kangkang-e2e-history-key",
      INSTALL_TRACKER_URL: `http://127.0.0.1:${trackerPort}`,
      INSTALL_TRACKER_HOST: "127.0.0.1",
      INSTALL_TRACKER_PORT: String(trackerPort),
      INSTALL_TRACKER_DATA_DIR: path.join(dataDirectory, "install-tracker"),
      ALLOW_PRIVATE_UPSTREAMS: "true",
      ALLOW_LAN_WEB_WITHOUT_TURNSTILE: "true",
      TRUST_PROXY: "true",
      TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
      TRUSTED_WEB_PROXY_TOKEN: "kk-e2e-trusted-web",
      ATTACHMENT_FALLBACK_MODELS: "e2e-vision-model",
      ATTACHMENT_FALLBACK_PROTOCOLS: "openai-chat",
      ATTACHMENT_FALLBACK_ATTEMPTS: "3",
    },
  },
});
