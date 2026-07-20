import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function globalSetup() {
  const directory = process.env.E2E_DATA_DIR;
  if (!directory || process.env.E2E_EPHEMERAL_DATA_DIR !== "true") return;
  const resolved = path.resolve(directory);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(temporaryRoot)) throw new Error("Refusing to clear a non-temporary E2E data directory");
  fs.mkdirSync(resolved, { recursive: true });
}
