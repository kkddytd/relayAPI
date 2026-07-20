import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function globalTeardown() {
  const directory = process.env.E2E_DATA_DIR;
  if (!directory || process.env.E2E_EPHEMERAL_DATA_DIR !== "true") return;
  const resolved = path.resolve(directory);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolved.startsWith(temporaryRoot)) fs.rmSync(resolved, { recursive: true, force: true });
}
