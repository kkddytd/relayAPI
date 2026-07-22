import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dashboardCss, dashboardHtml, dashboardJs } from "./dashboard.mjs";

const __filename = fileURLToPath(import.meta.url);
const rootDirectory = path.resolve(path.dirname(__filename), "../..");

// Deployments may install the tracker package separately or share the server
// dependency tree. Prefer the local package, then fall back to that shared tree.
const localRequire = createRequire(import.meta.url);
let Database;
try {
  Database = localRequire("better-sqlite3");
} catch (localError) {
  try {
    Database = createRequire(path.join(rootDirectory, "server/package.json"))("better-sqlite3");
  } catch {
    throw localError;
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(rootDirectory, ".env"));
loadEnvFile(path.join(rootDirectory, ".env.local"));

function localDate(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendText(res, statusCode, contentType, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function normalizeIp(value) {
  let candidate = String(value || "").trim();
  if (!candidate) return "";
  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  }
  const zoneIndex = candidate.indexOf("%");
  if (zoneIndex !== -1) candidate = candidate.slice(0, zoneIndex);
  if (candidate.toLowerCase().startsWith("::ffff:")) {
    const ipv4 = candidate.slice(7);
    if (net.isIP(ipv4) === 4) return ipv4;
  }
  return net.isIP(candidate) ? candidate : "";
}

function isLoopback(value) {
  const address = normalizeIp(value);
  if (address === "::1") return true;
  return net.isIP(address) === 4 && address.split(".")[0] === "127";
}

function forwardedIp(req) {
  const forwarded = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const firstForwarded = String(forwarded || "").split(",", 1)[0];
  return normalizeIp(firstForwarded) || normalizeIp(req.headers["x-real-ip"]);
}

function clientIp(req, trustProxy) {
  const directAddress = normalizeIp(req.socket.remoteAddress);
  if (trustProxy && isLoopback(directAddress)) return forwardedIp(req) || directAddress;
  return directAddress;
}

function recentLocalDates(timeZone, count) {
  const [year, month, day] = localDate(timeZone).split("-").map(Number);
  const todayUtc = Date.UTC(year, month - 1, day);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(todayUtc - (count - index - 1) * 86_400_000);
    return date.toISOString().slice(0, 10);
  });
}

export function createInstallTracker({
  dataDirectory,
  timeZone = process.env.INSTALL_TRACKER_TIME_ZONE || "Asia/Shanghai",
  trustProxy = process.env.INSTALL_TRACKER_TRUST_PROXY !== "false",
} = {}) {
  const directory = path.resolve(
    dataDirectory ||
      process.env.INSTALL_TRACKER_DATA_DIR ||
      (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "install-tracker") : path.join(rootDirectory, "data/install-tracker")),
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Ignore permission changes unsupported by the current filesystem.
  }
  const databasePath = path.join(directory, "installations.sqlite");
  const db = new Database(databasePath);
  try {
    fs.chmodSync(databasePath, 0o600);
  } catch {
    // Ignore permission changes unsupported by the current filesystem.
  }
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS installation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      ip_address TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS installation_events_local_date_idx
      ON installation_events(local_date);
  `);

  const columns = db.prepare("PRAGMA table_info(installation_events)").all();
  if (!columns.some((column) => column.name === "ip_address")) {
    db.exec("ALTER TABLE installation_events ADD COLUMN ip_address TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS installation_events_ip_address_idx
      ON installation_events(ip_address);
  `);

  const insertEvent = db.prepare("INSERT INTO installation_events(received_at, local_date, ip_address) VALUES (?, ?, ?)");
  const totalStatement = db.prepare("SELECT COUNT(*) AS value FROM installation_events");
  const todayStatement = db.prepare("SELECT COUNT(*) AS value FROM installation_events WHERE local_date = ?");
  const uniqueIpsStatement = db.prepare("SELECT COUNT(DISTINCT ip_address) AS value FROM installation_events WHERE ip_address <> ''");
  const todayUniqueIpsStatement = db.prepare(
    "SELECT COUNT(DISTINCT ip_address) AS value FROM installation_events WHERE local_date = ? AND ip_address <> ''",
  );
  const lastStatement = db.prepare("SELECT received_at FROM installation_events ORDER BY id DESC LIMIT 1");
  const dailyStatement = db.prepare(`
    SELECT local_date AS date, COUNT(*) AS count
    FROM installation_events
    WHERE local_date BETWEEN ? AND ?
    GROUP BY local_date
    ORDER BY local_date
  `);
  const clients = new Set();
  let databaseClosed = false;

  const stats = () => {
    const today = localDate(timeZone);
    const dates = recentLocalDates(timeZone, 14);
    const dailyCounts = new Map(
      dailyStatement.all(dates[0], dates.at(-1)).map((row) => [row.date, Number(row.count)]),
    );
    return {
      total: Number(totalStatement.get().value),
      today: Number(todayStatement.get(today).value),
      unique_ips: Number(uniqueIpsStatement.get().value),
      today_unique_ips: Number(todayUniqueIpsStatement.get(today).value),
      last_report_at: lastStatement.get()?.received_at ?? null,
      daily: dates.map((date) => ({ date, count: dailyCounts.get(date) || 0 })),
    };
  };
  const broadcast = () => {
    const payload = `event: stats\ndata: ${JSON.stringify(stats())}\n\n`;
    for (const client of clients) {
      if (client.destroyed || client.writableEnded) clients.delete(client);
      else client.write(payload);
    }
  };
  const disconnectStreams = () => {
    for (const client of clients) client.end();
    clients.clear();
  };

  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'");
    const pathname = (() => {
      try {
        return new URL(req.url || "/", "http://localhost").pathname;
      } catch {
        return "";
      }
    })();

    if (pathname === "/" || pathname === "/installation-stats/") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return sendText(res, 200, "text/html; charset=utf-8", dashboardHtml);
    }

    if (pathname === "/dashboard.css" || pathname === "/installation-stats/dashboard.css") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return sendText(res, 200, "text/css; charset=utf-8", dashboardCss);
    }

    if (pathname === "/dashboard.js" || pathname === "/installation-stats/dashboard.js") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return sendText(res, 200, "text/javascript; charset=utf-8", dashboardJs);
    }

    if (pathname === "/health") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return sendJson(res, 200, { ok: true, status: "ok" });
    }

    if (pathname === "/api/v1/installations/report") {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      req.on("error", () => {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: "request_failed" });
      });
      req.on("end", () => {
        insertEvent.run(new Date().toISOString(), localDate(timeZone), clientIp(req, trustProxy));
        res.statusCode = 204;
        res.setHeader("Cache-Control", "no-store");
        res.end();
        broadcast();
      });
      req.resume();
      return;
    }

    if (pathname === "/api/v1/installations/stats") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return sendJson(res, 200, { ok: true, ...stats() });
    }

    if (pathname === "/api/v1/installations/stream") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      clients.add(res);
      res.write(`event: stats\ndata: ${JSON.stringify(stats())}\n\n`);
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
      }, 20_000);
      heartbeat.unref();
      res.once("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  return {
    server,
    databasePath,
    stats,
    disconnectStreams,
    close() {
      disconnectStreams();
      if (!databaseClosed) {
        databaseClosed = true;
        db.close();
      }
    },
  };
}

const invokedDirectly = (() => {
  if (process.env.KANGKANG_INSTALL_TRACKER_MAIN === "true") return true;
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
})();
if (invokedDirectly) {
  const host = process.env.INSTALL_TRACKER_HOST || "127.0.0.1";
  const port = Number(process.env.INSTALL_TRACKER_PORT || 6723);
  const tracker = createInstallTracker();
  tracker.server.listen(port, host, () => {
    console.log(`安装统计服务已启动: http://${host}:${port}`);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Stop accepting new requests first, then close SQLite after all in-flight
    // empty reports have finished. SSE clients are ended explicitly so they do
    // not keep server.close() waiting.
    tracker.server.close(() => {
      tracker.close();
      process.exitCode = 0;
    });
    tracker.disconnectStreams();
    tracker.server.closeIdleConnections?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
