import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createInstallTracker } from "./index.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kangkang-install-tracker-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(tracker) {
  await new Promise((resolve, reject) => {
    tracker.server.once("error", reject);
    tracker.server.listen(0, "127.0.0.1", resolve);
  });
  const address = tracker.server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function stop(tracker) {
  tracker.disconnectStreams();
  if (tracker.server.listening) {
    await new Promise((resolve) => tracker.server.close(resolve));
  }
  tracker.close();
}

async function readUntil(reader, expected) {
  const decoder = new TextDecoder();
  let value = "";
  for (let index = 0; index < 10; index += 1) {
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("sse_read_timeout")), 2_000);
      timer.unref();
    });
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk.done) break;
    value += decoder.decode(chunk.value, { stream: true });
    if (value.includes(expected)) return value;
  }
  throw new Error(`SSE stream did not contain ${expected}: ${value}`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("installation tracker", () => {
  it("accepts empty reports, streams live totals, and persists them across restarts", async () => {
    const dataDirectory = temporaryDirectory();
    const tracker = createInstallTracker({ dataDirectory, timeZone: "Asia/Shanghai", trustProxy: false });
    const baseUrl = await listen(tracker);
    let streamReader;
    try {
      const initialStats = await fetch(`${baseUrl}/api/v1/installations/stats`).then((response) => response.json());
      expect(initialStats).toMatchObject({
        ok: true,
        total: 0,
        today: 0,
        unique_ips: 0,
        today_unique_ips: 0,
        last_report_at: null,
      });
      expect(initialStats.daily).toHaveLength(14);

      const streamResponse = await fetch(`${baseUrl}/api/v1/installations/stream`);
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      streamReader = streamResponse.body.getReader();
      await readUntil(streamReader, '"total":0');

      const firstReport = await fetch(`${baseUrl}/api/v1/installations/report`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.99" },
      });
      expect(firstReport.status).toBe(204);
      await readUntil(streamReader, '"total":1');

      await streamReader.cancel();
      streamReader = null;
      const secondReport = await fetch(`${baseUrl}/api/v1/installations/report`, { method: "POST" });
      expect(secondReport.status).toBe(204);
      const finalStats = await fetch(`${baseUrl}/api/v1/installations/stats`).then((response) => response.json());
      expect(finalStats).toMatchObject({ ok: true, total: 2, today: 2, unique_ips: 1, today_unique_ips: 1 });
      expect(finalStats.last_report_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(finalStats.daily.at(-1)).toMatchObject({ count: 2 });
    } finally {
      await streamReader?.cancel().catch(() => undefined);
      await stop(tracker);
    }

    const reopened = createInstallTracker({ dataDirectory, timeZone: "Asia/Shanghai" });
    try {
      expect(reopened.stats()).toMatchObject({ total: 2, today: 2, unique_ips: 1, today_unique_ips: 1 });
      const db = new Database(reopened.databasePath, { readonly: true });
      try {
        expect(db.prepare("SELECT DISTINCT ip_address FROM installation_events").pluck().all()).toEqual(["127.0.0.1"]);
      } finally {
        db.close();
      }
    } finally {
      reopened.close();
    }
  });

  it("uses a forwarded source IP only from a trusted loopback proxy", async () => {
    const tracker = createInstallTracker({ dataDirectory: temporaryDirectory(), trustProxy: true });
    const baseUrl = await listen(tracker);
    try {
      const response = await fetch(`${baseUrl}/api/v1/installations/report`, {
        method: "POST",
        headers: {
          "x-forwarded-for": "198.51.100.27",
          "x-real-ip": "198.51.100.28",
        },
      });
      expect(response.status).toBe(204);
      expect(tracker.stats()).toMatchObject({ total: 1, unique_ips: 1, today_unique_ips: 1 });

      const db = new Database(tracker.databasePath, { readonly: true });
      try {
        expect(db.prepare("SELECT ip_address FROM installation_events").pluck().get()).toBe("198.51.100.27");
      } finally {
        db.close();
      }
    } finally {
      await stop(tracker);
    }
  });

  it("deduplicates retried installation events without changing legacy empty reports", async () => {
    const tracker = createInstallTracker({ dataDirectory: temporaryDirectory(), trustProxy: false });
    const baseUrl = await listen(tracker);
    try {
      const headers = { "idempotency-key": "relayapi-test-install-event" };
      expect(await fetch(`${baseUrl}/api/v1/installations/report`, { method: "POST", headers })).toHaveProperty("status", 204);
      expect(await fetch(`${baseUrl}/api/v1/installations/report`, { method: "POST", headers })).toHaveProperty("status", 204);
      expect(await fetch(`${baseUrl}/api/v1/installations/report`, { method: "POST" })).toHaveProperty("status", 204);
      expect(await fetch(`${baseUrl}/api/v1/installations/report`, { method: "POST" })).toHaveProperty("status", 204);
      expect(tracker.stats()).toMatchObject({ total: 3, today: 3, unique_ips: 1 });

      const invalid = await fetch(`${baseUrl}/api/v1/installations/report`, {
        method: "POST",
        headers: { "idempotency-key": "invalid/event/key" },
      });
      expect(invalid.status).toBe(400);
      expect(tracker.stats().total).toBe(3);
    } finally {
      await stop(tracker);
    }
  });

  it("trusts loopback proxy headers by default for proxied reports", async () => {
    const tracker = createInstallTracker({ dataDirectory: temporaryDirectory() });
    const baseUrl = await listen(tracker);
    try {
      const response = await fetch(`${baseUrl}/api/v1/installations/report`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      expect(response.status).toBe(204);
      const db = new Database(tracker.databasePath, { readonly: true });
      try {
        expect(db.prepare("SELECT ip_address FROM installation_events").pluck().get()).toBe("203.0.113.7");
      } finally {
        db.close();
      }
    } finally {
      await stop(tracker);
    }
  });

  it("migrates an existing installation database before recording source IPs", async () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = path.join(dataDirectory, "installations.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE installation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        local_date TEXT NOT NULL
      );
      INSERT INTO installation_events(received_at, local_date)
      VALUES ('2026-07-16T00:00:00.000Z', '2026-07-16');
    `);
    legacy.close();

    const tracker = createInstallTracker({ dataDirectory, trustProxy: false });
    const baseUrl = await listen(tracker);
    try {
      expect(await fetch(`${baseUrl}/api/v1/installations/report`, {
        method: "POST",
        headers: { "idempotency-key": "relayapi-migrated-install-event" },
      })).toHaveProperty("status", 204);
      const db = new Database(databasePath, { readonly: true });
      try {
        const columns = db.prepare("PRAGMA table_info(installation_events)").all();
        expect(columns.some((column) => column.name === "ip_address")).toBe(true);
        expect(columns.some((column) => column.name === "event_id")).toBe(true);
        expect(db.prepare("SELECT ip_address FROM installation_events ORDER BY id").pluck().all()).toEqual(["", "127.0.0.1"]);
        expect(db.prepare("SELECT event_id FROM installation_events ORDER BY id").pluck().all()).toEqual([
          "",
          "relayapi-migrated-install-event",
        ]);
      } finally {
        db.close();
      }
    } finally {
      await stop(tracker);
    }
  });

  it("serves the public dashboard and its static assets", async () => {
    const tracker = createInstallTracker({ dataDirectory: temporaryDirectory() });
    const baseUrl = await listen(tracker);
    try {
      const [page, css, script] = await Promise.all([
        fetch(`${baseUrl}/installation-stats/`),
        fetch(`${baseUrl}/installation-stats/dashboard.css`),
        fetch(`${baseUrl}/installation-stats/dashboard.js`),
      ]);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const pageBody = await page.text();
      expect(pageBody).toContain("累计安装次数");
      expect(pageBody).not.toContain("今日安装上报");
      expect(css.headers.get("content-type")).toContain("text/css");
      expect(await css.text()).toContain(".counter-line");
      expect(script.headers.get("content-type")).toContain("text/javascript");
      const scriptBody = await script.text();
      expect(scriptBody).toContain("EventSource");
      expect(scriptBody).toContain("drawSignalField");
    } finally {
      await stop(tracker);
    }
  });

  it("rejects non-POST report requests without changing the count", async () => {
    const tracker = createInstallTracker({ dataDirectory: temporaryDirectory() });
    const baseUrl = await listen(tracker);
    try {
      const response = await fetch(`${baseUrl}/api/v1/installations/report`);
      expect(response.status).toBe(405);
      expect(tracker.stats().total).toBe(0);
    } finally {
      await stop(tracker);
    }
  });
});
