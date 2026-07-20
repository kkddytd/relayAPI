import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logPath = path.resolve(process.argv[2] || path.join(rootDirectory, "data/relayapi.log"));
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const logDescriptor = fs.openSync(logPath, "a");

try {
  const child = spawn(process.execPath, [path.join(rootDirectory, "server/start.mjs")], {
    cwd: rootDirectory,
    env: process.env,
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  child.unref();
  process.stdout.write(String(child.pid));
} finally {
  fs.closeSync(logDescriptor);
}
