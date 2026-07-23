import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(rootDirectory, "scripts/report-installation.sh");
const temporaryDirectories = [];
const servers = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relayapi-install-report-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}/api/v1/installations/report`;
}

function runReport(markerFile, endpoint, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath, markerFile], {
      cwd: rootDirectory,
      env: {
        ...process.env,
        INSTALL_REPORT_ENDPOINT: endpoint,
        INSTALL_REPORT_ATTEMPTS: "1",
        INSTALL_REPORT_RETRY_DELAY_SECONDS: "0",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("installation report script", () => {
  it("uses one idempotency key across transport and retry attempts", async () => {
    const requests = [];
    const endpoint = await listen((req, res) => {
      requests.push(req.headers["idempotency-key"]);
      res.statusCode = requests.length === 1 ? 503 : 204;
      res.end();
    });
    const directory = temporaryDirectory();
    const markerFile = path.join(directory, ".installation-reported");

    const result = await runReport(markerFile, endpoint, { INSTALL_REPORT_ATTEMPTS: "2" });

    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(requests).size).toBe(1);
    expect(requests[0]).toMatch(/^relayapi-[A-Za-z0-9-]+$/);
    expect(fs.readFileSync(markerFile, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fs.readdirSync(path.join(directory, ".installation-report-queue"))).toEqual([]);
  });

  it("keeps failed events and flushes them with the next installation", async () => {
    const requests = [];
    let available = false;
    const endpoint = await listen((req, res) => {
      requests.push({ eventId: req.headers["idempotency-key"], available });
      res.statusCode = available ? 204 : 503;
      res.end();
    });
    const directory = temporaryDirectory();
    const markerFile = path.join(directory, ".installation-reported");
    const queueDirectory = path.join(directory, ".installation-report-queue");

    const failed = await runReport(markerFile, endpoint);
    expect(failed.code).toBe(1);
    expect(fs.readdirSync(queueDirectory)).toHaveLength(1);

    available = true;
    const recovered = await runReport(markerFile, endpoint);
    expect(recovered).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(fs.readdirSync(queueDirectory)).toEqual([]);
    const deliveredIds = new Set(requests.filter((item) => item.available).map((item) => item.eventId));
    expect(deliveredIds.size).toBe(2);
  });
});
