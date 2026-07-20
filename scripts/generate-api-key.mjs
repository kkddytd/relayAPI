import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.resolve(process.env.RELAYAPI_ENV_FILE || path.join(rootDirectory, ".env"));
const examplePath = path.join(rootDirectory, ".env.example");
const ensureOnly = process.argv.includes("--ensure");
const showOnly = process.argv.includes("--show");
const helpOnly = process.argv.includes("--help") || process.argv.includes("-h");

if (helpOnly) {
  console.log("用法：node scripts/generate-api-key.mjs [--ensure|--show]");
  console.log("  --ensure  仅在 DETECTOR_API_KEYS 为空时创建密钥");
  console.log("  --show    显示已配置的检测 API Key");
  process.exit(0);
}

const knownArguments = new Set(["--ensure", "--show"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !knownArguments.has(argument));
if (unknownArguments.length > 0) {
  console.error(`未知选项：${unknownArguments.join(", ")}`);
  process.exit(2);
}

function readValue(content, name) {
  const line = content.split(/\r?\n/).find((item) => item.trim().startsWith(`${name}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "") : "";
}

function setValue(content, name, value) {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((item) => item.trim().startsWith(`${name}=`));
  if (index >= 0) {
    lines[index] = `${name}=${value}`;
    return lines.join("\n");
  }
  return `${content.replace(/\s*$/, "")}\n${name}=${value}\n`;
}

function configuredKey(content) {
  return readValue(content, "DETECTOR_API_KEYS") || readValue(content, "DETECTOR_API_KEY");
}

let content = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, "utf8")
  : fs.existsSync(examplePath)
    ? fs.readFileSync(examplePath, "utf8")
    : "";
const current = configuredKey(content);

if (showOnly) {
  if (!current) {
    console.error(`${envPath} 中尚未配置检测 API Key。`);
    process.exit(1);
  }
  console.log(current);
  process.exit(0);
}

if (ensureOnly && current) {
  console.log(`检测 API Key 已配置在 ${envPath}。`);
  process.exit(0);
}

const generated = `det_${randomBytes(32).toString("base64url")}`;
content = setValue(content, "DETECTOR_API_KEYS", generated);
fs.mkdirSync(path.dirname(envPath), { recursive: true });
fs.writeFileSync(envPath, content, { mode: 0o600 });
try {
  fs.chmodSync(envPath, 0o600);
} catch {
  // Ignore filesystems without POSIX permissions.
}
console.log(`已生成检测 API Key，并保存到 ${envPath}：`);
console.log(generated);
