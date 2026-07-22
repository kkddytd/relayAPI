import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironmentFiles, resolveInstallTrackerUrl } from "./start-config.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relayapi-start-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("start environment", () => {
  it("loads the configured tracker URL before startup and keeps explicit environment values", () => {
    const rootDirectory = temporaryDirectory();
    fs.writeFileSync(path.join(rootDirectory, ".env"), "INSTALL_TRACKER_URL=http://env-file:6723\nPORT=6722\n");
    fs.writeFileSync(path.join(rootDirectory, ".env.local"), "INSTALL_TRACKER_URL=http://local-file:6723\n");
    const environment = { KK_ENV_FILE: path.join(rootDirectory, "missing.env") };

    loadEnvironmentFiles(rootDirectory, environment);

    expect(resolveInstallTrackerUrl(environment)).toBe("http://env-file:6723");
    expect(environment.PORT).toBe("6722");
  });

  it("prioritizes the selected stable environment file and explicit process values", () => {
    const rootDirectory = temporaryDirectory();
    const stableFile = path.join(rootDirectory, "stable.env");
    fs.writeFileSync(stableFile, "INSTALL_TRACKER_URL=http://stable-file:6723\n");
    fs.writeFileSync(path.join(rootDirectory, ".env.local"), "INSTALL_TRACKER_URL=http://local-file:6723\n");
    const environment = {
      KK_ENV_FILE: stableFile,
      INSTALL_TRACKER_URL: "http://process-value:6723",
    };

    loadEnvironmentFiles(rootDirectory, environment);

    expect(resolveInstallTrackerUrl(environment)).toBe("http://process-value:6723");
  });

  it("derives the internal tracker URL from its configured host and port", () => {
    expect(resolveInstallTrackerUrl({
      INSTALL_TRACKER_HOST: "0.0.0.0",
      INSTALL_TRACKER_PORT: "7823",
    })).toBe("http://127.0.0.1:7823");
    expect(resolveInstallTrackerUrl({
      INSTALL_TRACKER_HOST: "::1",
      INSTALL_TRACKER_PORT: "8823",
    })).toBe("http://[::1]:8823");
  });
});
