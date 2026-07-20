import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trackerUrl = process.env.INSTALL_TRACKER_URL || "http://127.0.0.1:6723";
const children = new Set();
let stopping = false;

async function trackerAlreadyRunning() {
  try {
    const response = await fetch(`${trackerUrl}/health`, { signal: AbortSignal.timeout(600) });
    return response.ok;
  } catch {
    return false;
  }
}

function launch(relativePath, name) {
  const child = spawn(process.execPath, [path.join(rootDirectory, relativePath)], {
    cwd: rootDirectory,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`${name} stopped unexpectedly (${signal || code || 0})`);
    shutdown(code || 1);
  });
  return child;
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 12_000);
  timer.unref();
  if (children.size === 0) process.exit(exitCode);
  let remaining = children.size;
  for (const child of children) {
    child.once("exit", () => {
      remaining -= 1;
      if (remaining === 0) process.exit(exitCode);
    });
  }
}

if (!(await trackerAlreadyRunning())) launch("services/install-tracker/index.mjs", "installation tracker");
launch("server/index.mjs", "web server");

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
