import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent } from "undici";
import {
  buildLiveKnowledgeQuestions,
  LIVE_KNOWLEDGE_QUESTION_TARGET,
  LIVE_KNOWLEDGE_REQUIRED_CORRECT,
  LIVE_KNOWLEDGE_SCHEMA_VERSION,
} from "./live-knowledge.mjs";
import {
  createOpenApiDocument,
  DETECTION_API_VERSION,
  DETECTION_MODELS,
  DETECTION_PROTOCOLS,
  detectionProbeFamily,
  modelFamily,
  resolveDetectionProfile,
  runModelDetection,
  validateDetectionRequest,
} from "./detection-api.mjs";
import { nextAnthropicCompatibilityRetry } from "./upstream-compat.mjs";
import { inspectClaudeSignatureEnvelope } from "./claude-signature.mjs";
import { analyzeAttachments, isUngroundedAttachmentAnalysis } from "./attachment-analysis.mjs";
import { attachmentViewUrl, publicAttachmentRecord, receiveAttachmentUpload, receiveAttachmentUploadWithFields } from "./attachments.mjs";
import { createAppStorage, credentialFingerprint } from "./storage.mjs";

export function extractAnthropicContentSignatures(payload) {
  const values = [];
  let emptyCount = 0;
  if (!payload || typeof payload !== "object") {
    return { values, emptyCount, messageId: null, model: null };
  }
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "thinking" || typeof block.signature !== "string") continue;
    if (block.signature.length === 0) emptyCount += 1;
    else values.push(block.signature);
  }
  return {
    values,
    emptyCount,
    messageId: typeof payload.id === "string" ? payload.id : null,
    model: typeof payload.model === "string" ? payload.model : null,
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const logDir = "/tmp/apiverify";
const maxLoggedStringLength = 12_000;
const liveKnowledgeCachePath = path.join(logDir, "live-knowledge.json");
let liveKnowledgeMemory = null;
let liveKnowledgeFetchInFlight = null;
let appStorageInstance = null;
let webSessionSecret = null;
const turnstileSessions = new Map();
const turnstileSessionTtlMs = 10 * 60 * 1000;
const webSessionCookieName = "kk_web_session";
const webSessionMaxAgeSeconds = 365 * 24 * 60 * 60;

function appStorage() {
  if (!appStorageInstance) appStorageInstance = createAppStorage({ rootDirectory: rootDir });
  return appStorageInstance;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(process.env.KK_ENV_FILE || "/var/lib/kk-model-monitor/.env");
loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(rootDir, ".env.local"));

const port = Number(process.env.PORT || 6722);
const host = process.env.HOST || "127.0.0.1";
const installTrackerUrl = process.env.INSTALL_TRACKER_URL || "http://127.0.0.1:6723";
const configuredLiveKnowledgeTtlMs = Number(process.env.LIVE_KNOWLEDGE_TTL_MS || 900_000);
const liveKnowledgeTtlMs = Number.isFinite(configuredLiveKnowledgeTtlMs)
  ? Math.max(60_000, configuredLiveKnowledgeTtlMs)
  : 900_000;
const liveKnowledgeTimeZone = process.env.LIVE_KNOWLEDGE_TIME_ZONE || "Asia/Shanghai";
const configuredMaxRequestBodyBytes = Number(process.env.MAX_REQUEST_BODY_BYTES || 2 * 1024 * 1024);
const maxRequestBodyBytes = Number.isFinite(configuredMaxRequestBodyBytes)
  ? Math.max(64 * 1024, configuredMaxRequestBodyBytes)
  : 2 * 1024 * 1024;
const configuredUpstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000);
const upstreamTimeoutMs = Number.isFinite(configuredUpstreamTimeoutMs)
  ? Math.max(5_000, configuredUpstreamTimeoutMs)
  : 120_000;
const configuredMaxUpstreamResponseBytes = Number(process.env.MAX_UPSTREAM_RESPONSE_BYTES || 16 * 1024 * 1024);
const maxUpstreamResponseBytes = Number.isFinite(configuredMaxUpstreamResponseBytes)
  ? Math.max(256 * 1024, configuredMaxUpstreamResponseBytes)
  : 16 * 1024 * 1024;
const configuredInboundRequestTimeoutMs = Number(process.env.INBOUND_REQUEST_TIMEOUT_MS || 30_000);
const inboundRequestTimeoutMs = Number.isFinite(configuredInboundRequestTimeoutMs)
  ? Math.max(5_000, Math.min(120_000, configuredInboundRequestTimeoutMs))
  : 30_000;
const configuredServerMaxConnections = Number(process.env.SERVER_MAX_CONNECTIONS || 256);
const serverMaxConnections = Number.isFinite(configuredServerMaxConnections)
  ? Math.max(16, Math.min(10_000, Math.floor(configuredServerMaxConnections)))
  : 256;
const configuredLiveKnowledgeMaxResponseBytes = Number(
  process.env.LIVE_KNOWLEDGE_MAX_RESPONSE_BYTES || 2 * 1024 * 1024,
);
const liveKnowledgeMaxResponseBytes = Number.isFinite(configuredLiveKnowledgeMaxResponseBytes)
  ? Math.max(64 * 1024, Math.min(8 * 1024 * 1024, configuredLiveKnowledgeMaxResponseBytes))
  : 2 * 1024 * 1024;
// Private targets are an explicit local-development capability. Merely
// listening on loopback must not silently turn the relay into an SSRF proxy.
const allowPrivateUpstreams = process.env.ALLOW_PRIVATE_UPSTREAMS === "true";
const turnstileSecret = process.env.TURNSTILE_SECRET_KEY || "";
const allowPublicProbeWithoutTurnstile = process.env.ALLOW_PUBLIC_PROBE_WITHOUT_TURNSTILE === "true";
const allowLanWebWithoutTurnstile = process.env.ALLOW_LAN_WEB_WITHOUT_TURNSTILE === "true";
const trustedWebProxyToken = process.env.TRUSTED_WEB_PROXY_TOKEN || "";
const internalProbeToken = randomUUID();
const detectorApiKeys = (process.env.DETECTOR_API_KEYS || process.env.DETECTOR_API_KEY || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const configuredDetectionMaxConcurrency = Number(process.env.DETECTION_MAX_CONCURRENCY || 2);
const detectionMaxConcurrency = Number.isFinite(configuredDetectionMaxConcurrency)
  ? Math.max(1, Math.min(10, Math.floor(configuredDetectionMaxConcurrency)))
  : 2;
const detectionSeedSecret = process.env.DETECTION_SEED_SECRET || createHash("sha256")
  .update(`kangkang-question-order:${DETECTION_API_VERSION}`)
  .digest("hex");
const configuredLogRetentionDays = Number(process.env.LOG_RETENTION_DAYS || 7);
const logRetentionDays = Number.isFinite(configuredLogRetentionDays)
  ? Math.max(1, Math.min(90, Math.floor(configuredLogRetentionDays)))
  : 7;
const configuredMaxLogFileBytes = Number(process.env.MAX_LOG_FILE_BYTES || 50 * 1024 * 1024);
const maxLogFileBytes = Number.isFinite(configuredMaxLogFileBytes)
  ? Math.max(1024 * 1024, Math.min(1024 * 1024 * 1024, Math.floor(configuredMaxLogFileBytes)))
  : 50 * 1024 * 1024;
const configuredMaxLogEntryBytes = Number(process.env.MAX_LOG_ENTRY_BYTES || 256 * 1024);
const maxLogEntryBytes = Number.isFinite(configuredMaxLogEntryBytes)
  ? Math.max(16 * 1024, Math.min(1024 * 1024, Math.floor(configuredMaxLogEntryBytes)))
  : 256 * 1024;
const configuredAttachmentOrphanRetentionHours = Number(process.env.ATTACHMENT_ORPHAN_RETENTION_HOURS || 24);
const attachmentOrphanRetentionMs = Number.isFinite(configuredAttachmentOrphanRetentionHours)
  ? Math.max(1, Math.min(8760, configuredAttachmentOrphanRetentionHours)) * 60 * 60 * 1000
  : 24 * 60 * 60 * 1000;
const attachmentFallbackModels = [...new Set((process.env.ATTACHMENT_FALLBACK_MODELS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean))]
  .slice(0, 3);
const attachmentFallbackProtocols = [...new Set((process.env.ATTACHMENT_FALLBACK_PROTOCOLS || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean))]
  .slice(0, 3);
const configuredAttachmentFallbackAttempts = Number(process.env.ATTACHMENT_FALLBACK_ATTEMPTS || 3);
const attachmentFallbackAttempts = Number.isFinite(configuredAttachmentFallbackAttempts)
  ? Math.max(1, Math.min(5, Math.trunc(configuredAttachmentFallbackAttempts)))
  : 3;
const trustProxy = process.env.TRUST_PROXY === "true";
const trustedProxyAddresses = new Set((process.env.TRUSTED_PROXY_ADDRESSES || "")
  .split(",")
  .map((item) => normalizeRemoteAddress(item))
  .filter(Boolean));
let activeDetections = 0;
let lastLogPruneDate = "";
const configuredProbeMaxConcurrency = Number(process.env.PROBE_MAX_CONCURRENCY || 8);
const probeMaxConcurrency = Number.isFinite(configuredProbeMaxConcurrency)
  ? Math.max(1, Math.min(100, Math.floor(configuredProbeMaxConcurrency)))
  : 8;
const configuredProbeRateLimitWindowMs = Number(process.env.PROBE_RATE_LIMIT_WINDOW_MS || 60_000);
const probeRateLimitWindowMs = Number.isFinite(configuredProbeRateLimitWindowMs)
  ? Math.max(10_000, configuredProbeRateLimitWindowMs)
  : 60_000;
const configuredProbeRateLimitMax = Number(process.env.PROBE_RATE_LIMIT_MAX || 60);
const probeRateLimitMax = Number.isFinite(configuredProbeRateLimitMax)
  ? Math.max(10, configuredProbeRateLimitMax)
  : 60;
const probeRateBuckets = new Map();
const configuredTurnstileRateLimitMax = Number(process.env.TURNSTILE_RATE_LIMIT_MAX || 20);
const turnstileRateLimitMax = Number.isFinite(configuredTurnstileRateLimitMax)
  ? Math.max(5, Math.min(200, Math.floor(configuredTurnstileRateLimitMax)))
  : 20;
const configuredTurnstileMaxConcurrency = Number(process.env.TURNSTILE_MAX_CONCURRENCY || 4);
const turnstileMaxConcurrency = Number.isFinite(configuredTurnstileMaxConcurrency)
  ? Math.max(1, Math.min(20, Math.floor(configuredTurnstileMaxConcurrency)))
  : 4;
const turnstileRateBuckets = new Map();
const turnstileMaxResponseBytes = 64 * 1024;
const maxTurnstileSessions = 10_000;
const configuredTurnstileHostnames = (process.env.TURNSTILE_ALLOWED_HOSTNAMES || "")
  .split(",")
  .map((item) => item.trim().toLowerCase().replace(/\.$/, ""))
  .filter(Boolean);
const allowedTurnstileHostnames = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  ...configuredTurnstileHostnames,
]);

export function isTurnstileHostnameAllowed(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return hostname !== "" && allowedTurnstileHostnames.has(hostname);
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function readUsageNumber(usage, paths) {
  for (const path of paths) {
    let cursor = usage;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = null;
        break;
      }
      cursor = cursor[key];
    }
    if (typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0) return cursor;
  }
  return 0;
}

function readUsageField(usage, paths) {
  for (const path of paths) {
    let cursor = usage;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = null;
        break;
      }
      cursor = cursor[key];
    }
    if (typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0) {
      return path.join(".");
    }
  }
  return null;
}

function maskSecretString(raw) {
  const value = raw.trim();
  if (!value) return value;
  if (value.length <= 10) return "***";
  return `${value.slice(0, 6)}***${value.slice(-2)}`;
}

function normalizedExactSecrets(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length >= 4),
  )].sort((left, right) => right.length - left.length);
}

function redactExactSecrets(value, exactSecrets = []) {
  let redacted = String(value);
  for (const secret of normalizedExactSecrets(exactSecrets)) {
    redacted = redacted.replaceAll(secret, "[redacted-credential]");
  }
  return redacted;
}

function redactExactSecretsInValue(value, exactSecrets = []) {
  if (typeof value === "string") return redactExactSecrets(value, exactSecrets);
  if (Array.isArray(value)) return value.map((item) => redactExactSecretsInValue(item, exactSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactExactSecretsInValue(nested, exactSecrets)]),
    );
  }
  return value;
}

function outboundCredentialSecrets(headers, endpointUrl) {
  const secrets = [];
  for (const [name, rawValue] of Object.entries(headers || {})) {
    if (!/(authorization|api[-_]?key|secret|token|password|cookie)/i.test(name)) continue;
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) continue;
    secrets.push(value);
    const authorizationValue = value.match(/^(?:bearer|basic)\s+(.+)$/i)?.[1]?.trim();
    if (authorizationValue) secrets.push(authorizationValue);
    if (/cookie/i.test(name)) {
      for (const part of value.split(";")) {
        const cookieValue = part.slice(part.indexOf("=") + 1).trim();
        if (part.includes("=") && cookieValue) secrets.push(cookieValue);
      }
    }
  }
  if (endpointUrl instanceof URL) {
    for (const [name, value] of endpointUrl.searchParams) {
      if (/(api[-_]?key|secret|token|password)/i.test(name) && value) {
        secrets.push(value, encodeURIComponent(value));
      }
    }
  }
  return normalizedExactSecrets(secrets);
}

const forbiddenOutboundHeaderNames = new Set([
  "__proto__",
  "connection",
  "constructor",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "prototype",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function sanitizeOutboundHeaders(rawHeaders) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(rawHeaders || {})) {
    if (typeof rawValue !== "string") continue;
    const name = String(rawName).trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\0\r\n]/.test(rawValue)) {
      const error = new Error("invalid_upstream_header");
      error.code = "invalid_upstream_header";
      throw error;
    }
    if (forbiddenOutboundHeaderNames.has(name)) {
      const error = new Error("forbidden_upstream_header");
      error.code = "forbidden_upstream_header";
      throw error;
    }
    headers[name] = rawValue;
  }
  return headers;
}

function redactValue(value, keyHint = "", exactSecrets = []) {
  const secretKeyLike = /(authorization|api[-_]?key|secret|token|password|cookie)/i.test(keyHint);

  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^bearer\s+/i.test(value)) {
      return `Bearer ${maskSecretString(value.replace(/^bearer\s+/i, ""))}`;
    }
    if (secretKeyLike) {
      return maskSecretString(value);
    }
    // Upstream errors and model output can echo credentials even when the
    // surrounding field is not named `token` or `key`.
    const masked = maskCredentialPatterns(value, exactSecrets);
    return masked.length > maxLoggedStringLength
      ? `${masked.slice(0, maxLoggedStringLength)}...[truncated]`
      : masked;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, keyHint, exactSecrets));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactValue(nested, key, exactSecrets);
    }
    return out;
  }

  return value;
}

export function maskCredentialPatterns(value, exactSecrets = []) {
  return redactExactSecrets(value, exactSecrets)
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, (match) => maskSecretString(match))
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, (match) => maskSecretString(match))
    .replace(/\bark-[A-Za-z0-9_-]{16,}\b/gi, (match) => maskSecretString(match))
    .replace(/\b[0-9a-f]{16,64}\.[A-Za-z0-9_-]{8,64}\b/gi, (match) => maskSecretString(match))
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, (match) => maskSecretString(match))
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, (match) => maskSecretString(match));
}

function redactEndpointForLog(raw) {
  try {
    const parsed = new URL(String(raw));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid-endpoint]";
  }
}

function publicEndpointUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function requestCookie(req, name) {
  const header = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function normalizePersistentSecret(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Derive a fixed-length secret from arbitrary configured text.
  }
  return createHash("sha256").update(raw).digest();
}

function loadWebSessionSecret() {
  if (webSessionSecret) return webSessionSecret;
  const configured = normalizePersistentSecret(process.env.WEB_SESSION_SECRET);
  if (configured) {
    webSessionSecret = configured;
    return webSessionSecret;
  }

  const keyPath = path.join(appStorage().dataDirectory, ".web-session-key");
  const readExisting = () => {
    const value = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
    if (value.length !== 32) throw new Error("invalid_web_session_key");
    return value;
  };
  try {
    webSessionSecret = readExisting();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const generated = randomBytes(32);
    try {
      fs.writeFileSync(keyPath, `${generated.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
      webSessionSecret = generated;
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
      webSessionSecret = readExisting();
    }
  }
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Ignore filesystems without POSIX permission support.
  }
  return webSessionSecret;
}

export function signWebSessionId(id, secret) {
  const normalizedId = String(id || "").trim();
  if (!/^[a-zA-Z0-9_-]{20,128}$/.test(normalizedId)) throw new Error("invalid_web_session_id");
  const signature = createHmac("sha256", secret).update(normalizedId).digest("base64url");
  return `${normalizedId}.${signature}`;
}

export function verifyWebSessionToken(token, secret) {
  const value = String(token || "");
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^[a-zA-Z0-9_-]{20,128}$/.test(id) || !/^[a-zA-Z0-9_-]{40,64}$/.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(id).digest("base64url");
  return safeSecretEqual(signature, expected) ? id : null;
}

function appendSetCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", value);
  else if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, value]);
  else res.setHeader("Set-Cookie", [existing, value]);
}

function isSecureRequest(req) {
  return req.socket?.encrypted === true || (
    isTrustedProxyRequest(req) && lastForwardedValue(req.headers?.["x-forwarded-proto"]) === "https"
  );
}

function ensureWebSession(req, res) {
  const secret = loadWebSessionSecret();
  const existing = verifyWebSessionToken(requestCookie(req, webSessionCookieName), secret);
  if (existing) return existing;
  const id = randomBytes(24).toString("base64url");
  const token = signWebSessionId(id, secret);
  appendSetCookie(
    res,
    `${webSessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${webSessionMaxAgeSeconds}${isSecureRequest(req) ? "; Secure" : ""}`,
  );
  return id;
}

function hasValidTurnstileSession(req) {
  const token = requestCookie(req, "api_verifier_turnstile");
  if (!token) return false;
  const expiresAt = turnstileSessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    turnstileSessions.delete(token);
    return false;
  }
  return true;
}

function normalizeRemoteAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isLoopbackAddress(value) {
  const address = normalizeRemoteAddress(value);
  return address === "127.0.0.1" || address === "::1";
}

function requestHasProxyHeaders(req) {
  return [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ].some((name) => typeof req.headers?.[name] === "string" && req.headers[name].trim() !== "");
}

export function isDirectLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress) || requestHasProxyHeaders(req)) return false;
  let requestHostname = "";
  try {
    requestHostname = new URL(`http://${req.headers?.host || ""}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return requestHostname === "localhost" || requestHostname === "127.0.0.1" || requestHostname === "[::1]" || requestHostname === "::1";
}

export function isDirectLanRequest(req) {
  if (requestHasProxyHeaders(req)) return false;
  const remoteAddress = normalizeRemoteAddress(req.socket?.remoteAddress);
  if (!remoteAddress || isLoopbackAddress(remoteAddress) || !isExplicitLocalUpstreamAddress(remoteAddress)) return false;
  let requestHostname = "";
  try {
    requestHostname = new URL(`http://${req.headers?.host || ""}`).hostname;
  } catch {
    return false;
  }
  return isExplicitLocalUpstreamAddress(requestHostname);
}

export function isTrustedWebProxyRequest(req, configuredToken = trustedWebProxyToken) {
  const suppliedToken = typeof req.headers?.["x-kangkang-trusted-web"] === "string"
    ? req.headers["x-kangkang-trusted-web"]
    : "";
  return Boolean(
    configuredToken &&
    suppliedToken &&
    isLoopbackAddress(req.socket?.remoteAddress) &&
    safeSecretEqual(suppliedToken, configuredToken)
  );
}

function isAllowedLocalWebRequest(req) {
  return isDirectLoopbackRequest(req) ||
    isTrustedWebProxyRequest(req) ||
    (allowLanWebWithoutTurnstile && isDirectLanRequest(req));
}

export function createConcurrencyGate(limit) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let active = 0;
  return {
    get active() {
      return active;
    },
    get limit() {
      return normalizedLimit;
    },
    tryAcquire() {
      if (active >= normalizedLimit) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
    },
  };
}

const probeConcurrencyGate = createConcurrencyGate(probeMaxConcurrency);
const turnstileConcurrencyGate = createConcurrencyGate(turnstileMaxConcurrency);

export function createClientDisconnectController(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error("client_disconnected"));
    }
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    },
  };
}

function isTrustedProxyRequest(req) {
  const socketAddress = normalizeRemoteAddress(req.socket?.remoteAddress) || "unknown";
  if (trustedProxyAddresses.size > 0) return trustedProxyAddresses.has(socketAddress);
  return trustProxy;
}

export function lastValidForwardedAddress(value) {
  if (typeof value !== "string") return "";
  const candidates = value.split(",").map((item) => normalizeRemoteAddress(item)).filter(Boolean);
  const candidate = candidates.at(-1) || "";
  return isIP(candidate) ? candidate : "";
}

function lastForwardedValue(value) {
  if (typeof value !== "string") return "";
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).at(-1) || "";
}

export function requestSourceKey(req) {
  const socketAddress = normalizeRemoteAddress(req.socket?.remoteAddress) || "unknown";
  if (!isTrustedProxyRequest(req)) return socketAddress;
  // The closest proxy appends the actual peer at the right edge. Taking the
  // first value would let a client prepend arbitrary identities and bypass the
  // rate limiter.
  return lastValidForwardedAddress(req.headers["x-forwarded-for"]) || socketAddress;
}

function safeSecretEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isInternalProbeRequest(req) {
  const token = typeof req.headers["x-kangkang-internal-probe"] === "string"
    ? req.headers["x-kangkang-internal-probe"]
    : "";
  return Boolean(token && safeSecretEqual(token, internalProbeToken));
}

function detectionApiAuthorization(req) {
  if (detectorApiKeys.length === 0) {
    return isDirectLoopbackRequest(req)
      ? { allowed: true, mode: "local", ownerScope: "local", fingerprint: null }
      : { allowed: false, status: 503, code: "detector_api_not_configured" };
  }
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const allowed = Boolean(token && detectorApiKeys.some((candidate) => safeSecretEqual(token, candidate)));
  return allowed
    ? { allowed: true, mode: "bearer", ownerScope: `api:${credentialFingerprint(token)}`, fingerprint: credentialFingerprint(token) }
    : { allowed: false, status: 401, code: "invalid_detector_api_key" };
}

function webDataAuthorization(req, res) {
  if (isDirectLoopbackRequest(req)) {
    return { allowed: true, mode: "local", ownerScope: "local", fingerprint: null };
  }
  const apiAuthorization = detectionApiAuthorization(req);
  if (apiAuthorization.allowed) return apiAuthorization;
  if (isTrustedWebProxyRequest(req) || (allowLanWebWithoutTurnstile && isDirectLanRequest(req))) {
    const session = ensureWebSession(req, res);
    return {
      allowed: true,
      mode: isTrustedWebProxyRequest(req) ? "trusted-proxy" : "lan",
      ownerScope: `web:${credentialFingerprint(session)}`,
      fingerprint: null,
    };
  }
  if (hasValidTurnstileSession(req)) {
    const session = ensureWebSession(req, res);
    return {
      allowed: true,
      mode: "turnstile",
      ownerScope: `web:${credentialFingerprint(session)}`,
      fingerprint: null,
    };
  }
  return {
    allowed: false,
    status: turnstileSecret ? 403 : apiAuthorization.status || 403,
    code: turnstileSecret ? "turnstile_required" : apiAuthorization.code || "web_access_denied",
  };
}

function requestPublicBaseUrl(req) {
  const forwardedProto = isTrustedProxyRequest(req) && typeof req.headers["x-forwarded-proto"] === "string"
    ? lastForwardedValue(req.headers["x-forwarded-proto"])
    : "";
  const protocol = forwardedProto === "https" ? "https" : "http";
  const rawHost = typeof req.headers.host === "string" ? req.headers.host.trim() : "";
  const safeHost = /^[a-z0-9.:[\]-]+$/i.test(rawHost) ? rawHost : `127.0.0.1:${port}`;
  return `${protocol}://${safeHost}`;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:",
  );
}

function checkRateLimit(req, buckets, maxRequests) {
  const now = Date.now();
  const source = requestSourceKey(req);
  const current = buckets.get(source);
  if (!current || current.resetAt <= now) {
    buckets.set(source, { count: 1, resetAt: now + probeRateLimitWindowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function pruneRateBuckets(buckets) {
  const now = Date.now();
  for (const [source, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(source);
  }
}

function checkProbeRateLimit(req) {
  return checkRateLimit(req, probeRateBuckets, probeRateLimitMax);
}

function parseIPv4Octets(value) {
  if (isIP(value) !== 4) return null;
  const octets = value.split(".").map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function isNonPublicIPv4(octets) {
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function parseIPv6Words(value) {
  if (isIP(value) !== 6) return null;
  let source = value.toLowerCase();
  if (source.includes(".")) {
    const separator = source.lastIndexOf(":");
    const octets = parseIPv4Octets(source.slice(separator + 1));
    if (!octets) return null;
    source = `${source.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...head, ...Array(missing).fill("0"), ...tail].map((part) => Number.parseInt(part, 16));
  return words.length === 8 && words.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? words
    : null;
}

function wordsToIPv4(words, offset = 6) {
  return [words[offset] >> 8, words[offset] & 0xff, words[offset + 1] >> 8, words[offset + 1] & 0xff];
}

export function isPrivateAddress(address) {
  const value = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const version = isIP(value);
  if (version === 4) {
    return isNonPublicIPv4(parseIPv4Octets(value));
  }
  if (version === 6) {
    const words = parseIPv6Words(value);
    if (!words) return true;
    const [a, b, c, d, e, f] = words;
    const ipv4Mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
    if (ipv4Mapped) return isNonPublicIPv4(wordsToIPv4(words));
    const ipv4Compatible = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0;
    if (ipv4Compatible) return isNonPublicIPv4(wordsToIPv4(words));
    const nat64WellKnown = a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;
    if (nat64WellKnown && isNonPublicIPv4(wordsToIPv4(words))) return true;
    // RFC 8215 reserves 64:ff9b:1::/48 for local-use translation. It is not a
    // globally attributable destination, even when its embedded IPv4 bits
    // happen to look public, so it must never bypass the private-target gate.
    const nat64LocalUse = a === 0x64 && b === 0xff9b && c === 0x1;
    if (nat64LocalUse) return true;
    const sixToFour = a === 0x2002;
    if (sixToFour && isNonPublicIPv4(wordsToIPv4(words, 1))) return true;
    return (a & 0xfe00) === 0xfc00 ||
      (a & 0xffc0) === 0xfe80 ||
      (a & 0xffc0) === 0xfec0 ||
      (a & 0xff00) === 0xff00 ||
      (a === 0x100 && b === 0 && c === 0 && d === 0) ||
      (a === 0x2001 && b === 0) ||
      (a === 0x2001 && b === 2 && c === 0) ||
      (a === 0x2001 && b >= 0x10 && b <= 0x1f) ||
      (a === 0x2001 && b === 0x0db8) ||
      (a >= 0x3ff0 && a <= 0x3fff);
  }
  return false;
}

function isKnownCloudMetadataAddress(address) {
  const value = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (["100.100.100.200", "168.63.129.16", "169.254.169.254", "169.254.170.2"].includes(value)) {
    return true;
  }
  const words = parseIPv6Words(value);
  if (!words) return false;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  const nat64WellKnown = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  if (ipv4Mapped || ipv4Compatible || nat64WellKnown) {
    return isKnownCloudMetadataAddress(wordsToIPv4(words).join("."));
  }
  const sixToFour = words[0] === 0x2002;
  if (sixToFour) return isKnownCloudMetadataAddress(wordsToIPv4(words, 1).join("."));
  return words[0] === 0xfd00 && words[1] === 0x0ec2 &&
    words.slice(2, 7).every((word) => word === 0) && words[7] === 0x0254;
}

function isExplicitLocalUpstreamAddress(address) {
  const value = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (isKnownCloudMetadataAddress(value)) return false;
  const octets = parseIPv4Octets(value);
  if (octets) {
    const [a, b] = octets;
    return a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  const words = parseIPv6Words(value);
  if (!words) return false;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (ipv4Mapped) {
    return isExplicitLocalUpstreamAddress(wordsToIPv4(words).join("."));
  }
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const uniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  return loopback || uniqueLocal;
}

export function isUpstreamAddressAllowed(address, privateTargetsAllowed = false) {
  if (isKnownCloudMetadataAddress(address)) return false;
  if (!isPrivateAddress(address)) return true;
  return privateTargetsAllowed && isExplicitLocalUpstreamAddress(address);
}

export function waitForPromiseWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("operation_aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("operation_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function assertUpstreamEndpointAllowed(endpointUrl, privateTargetsAllowed = false, requestSignal) {
  const hostname = endpointUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (/^(?:metadata\.google\.internal|metadata\.goog|instance-data\.ec2\.internal)$/i.test(hostname)) {
    throw new Error("private_upstream_blocked");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isUpstreamAddressAllowed(hostname, privateTargetsAllowed)) throw new Error("private_upstream_blocked");
    return { address: hostname, family: literalFamily };
  }
  if (!privateTargetsAllowed && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw new Error("private_upstream_blocked");
  }
  try {
    const lookupTimeout = AbortSignal.timeout(5_000);
    const lookupSignal = requestSignal
      ? AbortSignal.any([requestSignal, lookupTimeout])
      : lookupTimeout;
    const records = await waitForPromiseWithSignal(
      dns.lookup(hostname, { all: true, verbatim: true }),
      lookupSignal,
    );
    if (records.length === 0) throw new Error("upstream_hostname_unresolvable");
    if (records.some((record) => !isUpstreamAddressAllowed(record.address, privateTargetsAllowed))) {
      throw new Error("private_upstream_blocked");
    }
    return records[0];
  } catch (error) {
    if (requestSignal?.aborted) throw requestSignal.reason ?? error;
    if (error instanceof Error && ["private_upstream_blocked", "upstream_hostname_unresolvable"].includes(error.message)) throw error;
    throw new Error("upstream_hostname_unresolvable");
  }
}

function createPinnedDispatcher(record) {
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options && typeof options === "object" && options.all) {
          callback(null, [{ address: record.address, family: record.family }]);
          return;
        }
        callback(null, record.address, record.family);
      },
    },
  });
}

async function closeDispatcher(dispatcher) {
  if (!dispatcher) return;
  try {
    await dispatcher.close();
  } catch {
    // The response has already been consumed or failed; no further action is needed.
  }
}

function ensurePrivateLogDirectory() {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(logDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("unsafe_log_directory");
  }
  if (typeof process.getuid === "function" && typeof stat.uid === "number" && stat.uid !== process.getuid()) {
    throw new Error("unsafe_log_directory_owner");
  }
  try {
    fs.chmodSync(logDir, 0o700);
  } catch {
    // Some read-only or non-POSIX filesystems do not support chmod.
  }
}

function pruneExpiredLogs() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastLogPruneDate === today) return;
  lastLogPruneDate = today;
  const cutoff = Date.now() - logRetentionDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) continue;
    const filePath = path.join(logDir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {
      // A concurrent cleanup or permission change is harmless.
    }
  }
}

function hardenExistingLogFiles() {
  try {
    ensurePrivateLogDirectory();
    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        fs.chmodSync(path.join(logDir, entry.name), 0o600);
      } catch {
        // Best-effort hardening for files created by older versions.
      }
    }
    pruneExpiredLogs();
  } catch {
    // Logging remains optional when the filesystem is unavailable.
  }
}

export function serializeBoundedLogEntry(kind, payload, limitBytes = maxLogEntryBytes, timestamp = new Date().toISOString()) {
  const entry = { ...payload, ts: timestamp, kind: String(kind).slice(0, 100) };
  const serialized = JSON.stringify(entry);
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= limitBytes) return serialized;
  return JSON.stringify({
    ts: timestamp,
    kind: String(kind).slice(0, 100),
    truncated: true,
    originalBytes,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  });
}

function appendLog(kind, payload) {
  let descriptor = null;
  try {
    ensurePrivateLogDirectory();
    pruneExpiredLogs();
    const date = new Date().toISOString().slice(0, 10);
    const logPath = `${logDir}/${date}.log`;
    const flags = fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(logPath, flags, 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("unsafe_log_file");
    if (typeof process.getuid === "function" && typeof stat.uid === "number" && stat.uid !== process.getuid()) {
      throw new Error("unsafe_log_file_owner");
    }
    const line = serializeBoundedLogEntry(kind, payload);
    if (stat.size + Buffer.byteLength(line) + 1 > maxLogFileBytes) return;
    fs.writeSync(descriptor, `${line}\n`, null, "utf8");
    try {
      fs.fchmodSync(descriptor, 0o600);
    } catch {
      // Best-effort permission hardening.
    }
  } catch {
    // ignore logging failures
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Logging is optional and the descriptor may already be invalid.
      }
    }
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function isJsonRequest(req) {
  const raw = req?.headers?.["content-type"];
  if (typeof raw !== "string") return false;
  const mediaType = raw.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

function readLiveCacheFile() {
  try {
    const stat = fs.lstatSync(liveKnowledgeCachePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(liveKnowledgeCachePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.questions)) return null;
    if (
      parsed.schemaVersion !== LIVE_KNOWLEDGE_SCHEMA_VERSION ||
      typeof parsed.generatedAt !== "string" ||
      parsed.questions.length !== LIVE_KNOWLEDGE_QUESTION_TARGET ||
      parsed.requiredCorrect !== LIVE_KNOWLEDGE_REQUIRED_CORRECT
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLiveCacheFile(snapshot) {
  let temporaryPath = null;
  try {
    ensurePrivateLogDirectory();
    temporaryPath = path.join(logDir, `.live-knowledge-${process.pid}-${randomUUID()}.tmp`);
    fs.writeFileSync(temporaryPath, JSON.stringify(snapshot), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, liveKnowledgeCachePath);
    temporaryPath = null;
    try {
      fs.chmodSync(liveKnowledgeCachePath, 0o600);
    } catch {
      // Best-effort permission hardening.
    }
  } catch {
    // A memory-only cache is still useful when the filesystem is read-only.
  } finally {
    if (temporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // A failed atomic cache write may not have created the temp file.
      }
    }
  }
}

function cacheDecoratedSnapshot(snapshot, status) {
  const generatedAt = Date.parse(snapshot.generatedAt);
  const ageSeconds = Number.isFinite(generatedAt)
    ? Math.max(0, Math.floor((Date.now() - generatedAt) / 1000))
    : 0;
  return {
    ...snapshot,
    cache: {
      status,
      ageSeconds,
      ttlSeconds: Math.floor(liveKnowledgeTtlMs / 1000),
    },
  };
}

function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function liveKnowledgeDateString(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: liveKnowledgeTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (values.year && values.month && values.day) return `${values.year}-${values.month}-${values.day}`;
  } catch {
    // Fall back to UTC when an invalid deployment timezone is configured.
  }
  return utcDateString(date);
}

export async function readResponseTextWithLimit(response, limitBytes, errorCode = "response_too_large") {
  const normalizedLimit = Math.max(1, Math.floor(limitBytes));
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > normalizedLimit) {
    const error = new Error(errorCode);
    error.code = errorCode;
    throw error;
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text) > normalizedLimit) {
      const error = new Error(errorCode);
      error.code = errorCode;
      throw error;
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > normalizedLimit) {
        await reader.cancel(errorCode).catch(() => {});
        const error = new Error(errorCode);
        error.code = errorCode;
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream can already be canceled after crossing the byte limit.
    }
  }
}

export async function fetchLiveKnowledgeSnapshot(sourceDate = liveKnowledgeDateString(), signal) {
  const sourceUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${sourceDate.replace(/-/g, "/")}`;
  const response = await fetch(sourceUrl, {
    headers: {
      accept: "application/json",
      "user-agent": "kangkang-live-knowledge/1.0 (+local deployment)",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`live_source_http_${response.status}`);
  }
  const rawData = await readResponseTextWithLimit(
    response,
    liveKnowledgeMaxResponseBytes,
    "live_source_response_too_large",
  );
  let data;
  try {
    data = JSON.parse(rawData);
  } catch {
    throw new Error("live_source_invalid_json");
  }
  const questions = buildLiveKnowledgeQuestions(data);
  if (questions.length !== LIVE_KNOWLEDGE_QUESTION_TARGET) {
    throw new Error("live_source_missing_questions");
  }

  const sourceRevision = [
    data?.tfa?.revision,
    ...(Array.isArray(data?.news)
      ? data.news.flatMap((item) => Array.isArray(item?.links) ? item.links.map((link) => link?.revision) : [])
      : []),
    ...(Array.isArray(data?.mostread?.articles)
      ? data.mostread.articles.map((article) => article?.revision)
      : []),
  ].find((value) => typeof value === "string") || null;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ sourceDate, sourceRevision, questions }))
    .digest("hex")
    .slice(0, 20);
  return {
    schemaVersion: LIVE_KNOWLEDGE_SCHEMA_VERSION,
    snapshotId: `wikimedia-${sourceDate}-${fingerprint}`,
    generatedAt: new Date().toISOString(),
    sourceDate,
    sourceName: "Wikimedia featured feed (English)",
    sourceUrl,
    sourceRevision,
    requiredCorrect: LIVE_KNOWLEDGE_REQUIRED_CORRECT,
    cache: {
      status: "miss",
      ageSeconds: 0,
      ttlSeconds: Math.floor(liveKnowledgeTtlMs / 1000),
    },
    questions,
  };
}

async function getLiveKnowledgeSnapshot({ signal } = {}) {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error("client_disconnected");
    error.name = "AbortError";
    throw error;
  }
  const now = Date.now();
  const requestedDate = liveKnowledgeDateString();
  const cached = liveKnowledgeMemory || readLiveCacheFile();
  if (cached) {
    const generatedAt = Date.parse(cached.generatedAt);
    if (Number.isFinite(generatedAt) && now - generatedAt < liveKnowledgeTtlMs && cached.sourceDate === requestedDate) {
      liveKnowledgeMemory = cached;
      return cacheDecoratedSnapshot(cached, "hit");
    }
  }

  let inFlight = null;
  try {
    let fresh;
    if (signal) {
      // A caller-owned signal must not control a shared fetch: otherwise one
      // disconnected client can abort the snapshot awaited by other clients.
      fresh = await fetchLiveKnowledgeSnapshot(requestedDate, signal);
    } else {
      inFlight = liveKnowledgeFetchInFlight;
      if (!inFlight || inFlight.sourceDate !== requestedDate) {
        inFlight = {
          sourceDate: requestedDate,
          promise: fetchLiveKnowledgeSnapshot(requestedDate),
        };
        liveKnowledgeFetchInFlight = inFlight;
      }
      fresh = await inFlight.promise;
    }
    if (signal?.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      throw new Error("client_disconnected");
    }
    // A request started just before midnight must not populate or return the
    // previous day's snapshot after the configured calendar date changes.
    if (fresh.sourceDate !== liveKnowledgeDateString()) {
      return getLiveKnowledgeSnapshot({ signal });
    }
    liveKnowledgeMemory = fresh;
    writeLiveCacheFile(fresh);
    return cacheDecoratedSnapshot(fresh, "miss");
  } catch (error) {
    if (signal?.aborted) throw error;
    // A previous day's facts must never be presented as today's real-time
    // snapshot. Same-day stale data is still useful as an explicitly marked
    // fallback when Wikimedia is temporarily unavailable.
    if (cached && cached.sourceDate === liveKnowledgeDateString()) {
      liveKnowledgeMemory = cached;
      return cacheDecoratedSnapshot(cached, "stale");
    }
    throw error;
  } finally {
    if (inFlight && liveKnowledgeFetchInFlight === inFlight) {
      liveKnowledgeFetchInFlight = null;
    }
  }
}

async function handleLiveKnowledge(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const lifecycle = createClientDisconnectController(req, res);
  try {
    // Public snapshot reads share one bounded fixed-source fetch. A disconnected
    // reader stops receiving a response, but does not cancel cache population
    // that may already be serving other readers.
    const snapshot = await getLiveKnowledgeSnapshot();
    if (lifecycle.signal.aborted || res.destroyed) return;
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, 200, { ok: true, ...snapshot });
  } catch (error) {
    if (lifecycle.signal.aborted || res.destroyed) return;
    sendJson(res, 503, {
      ok: false,
      error: error instanceof Error ? error.message : "live_knowledge_unavailable",
    });
  } finally {
    lifecycle.cleanup();
  }
}

export function readRequestBody(req, limitBytes = maxRequestBodyBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req?.headers?.["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
      const error = new Error("request_body_too_large");
      error.code = "request_body_too_large";
      req.resume?.();
      reject(error);
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limitBytes) {
        tooLarge = true;
        const error = new Error("request_body_too_large");
        error.code = "request_body_too_large";
        reject(error);
        req.resume?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("aborted", () => {
      const error = new Error("client_disconnected");
      error.code = "client_disconnected";
      reject(error);
    });
    req.on("error", reject);
  });
}

async function handleTurnstileVerify(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  if (!turnstileSecret) {
    sendJson(res, 500, { ok: false, error: "missing_turnstile_secret" });
    return;
  }

  if (!isJsonRequest(req)) {
    res.setHeader("Accept-Post", "application/json");
    sendJson(res, 415, { ok: false, success: false, error: "unsupported_media_type" });
    return;
  }

  pruneRateBuckets(turnstileRateBuckets);
  const rateLimit = checkRateLimit(req, turnstileRateBuckets, turnstileRateLimitMax);
  if (!rateLimit.allowed) {
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    sendJson(res, 429, {
      ok: false,
      success: false,
      error: "turnstile_rate_limited",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const release = turnstileConcurrencyGate.tryAcquire();
  if (!release) {
    res.setHeader("Retry-After", "1");
    sendJson(res, 429, {
      ok: false,
      success: false,
      error: "turnstile_concurrency_limited",
      active: turnstileConcurrencyGate.active,
      limit: turnstileConcurrencyGate.limit,
    });
    return;
  }

  const lifecycle = createClientDisconnectController(req, res);
  let token = "";
  try {
    const raw = await readRequestBody(req, 16 * 1024);
    let parsed;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, 400, { ok: false, success: false, error: "invalid_json" });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, success: false, error: "invalid_request" });
      return;
    }
    token = typeof parsed.token === "string" ? parsed.token.trim() : "";

    appendLog("turnstile_request", {
      route: "/__turnstile/verify",
      request: redactValue(parsed),
    });

    if (!token) {
      const payload = { ok: false, success: false, error: "missing_token" };
      sendJson(res, 400, payload);
      appendLog("turnstile_response", {
        route: "/__turnstile/verify",
        status: 400,
        response: payload,
      });
      return;
    }
    if (token.length > 4096) {
      sendJson(res, 400, { ok: false, success: false, error: "invalid_token" });
      return;
    }

    const remoteIp = requestSourceKey(req);

    const body = new URLSearchParams();
    body.set("secret", turnstileSecret);
    body.set("response", token);
    if (isIP(remoteIp)) {
      body.set("remoteip", remoteIp);
    }

    const timeoutSignal = AbortSignal.timeout(10_000);
    const cfResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.any([lifecycle.signal, timeoutSignal]),
      redirect: "error",
    });
    const rawCfData = await readResponseTextWithLimit(
      cfResp,
      turnstileMaxResponseBytes,
      "turnstile_response_too_large",
    );
    if (!cfResp.ok) throw new Error(`turnstile_http_${cfResp.status}`);
    let cfData;
    try {
      cfData = JSON.parse(rawCfData);
    } catch {
      throw new Error("turnstile_invalid_response");
    }
    if (!cfData || typeof cfData !== "object" || Array.isArray(cfData)) {
      throw new Error("turnstile_invalid_response");
    }
    if (typeof cfData.success !== "boolean") throw new Error("turnstile_invalid_response");

    const verifiedHostname =
      typeof cfData.hostname === "string"
        ? String(cfData.hostname).trim().toLowerCase().replace(/\.$/, "")
        : "";
    const hostnameAllowed = isTurnstileHostnameAllowed(verifiedHostname);
    if (cfData && typeof cfData === "object" && cfData.success === true && !hostnameAllowed) {
      cfData.success = false;
      cfData["error-codes"] = [
        ...(Array.isArray(cfData["error-codes"]) ? cfData["error-codes"] : []),
        "invalid-hostname",
      ];
    }

    if (cfData && cfData.success === true) {
      const now = Date.now();
      for (const [token, expiresAt] of turnstileSessions) {
        if (expiresAt <= now) turnstileSessions.delete(token);
      }
      while (turnstileSessions.size >= maxTurnstileSessions) {
        const oldest = turnstileSessions.keys().next().value;
        if (!oldest) break;
        turnstileSessions.delete(oldest);
      }
      const sessionToken = randomUUID();
      turnstileSessions.set(sessionToken, now + turnstileSessionTtlMs);
      const forwardedProto = isTrustedProxyRequest(req) && typeof req.headers["x-forwarded-proto"] === "string"
        ? lastForwardedValue(req.headers["x-forwarded-proto"])
        : "";
      const secureCookie = Boolean(req.socket.encrypted) || forwardedProto === "https";
      res.setHeader(
        "Set-Cookie",
        `api_verifier_turnstile=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(turnstileSessionTtlMs / 1000)}${secureCookie ? "; Secure" : ""}`,
      );
    }
    const payload = redactExactSecretsInValue({ ok: true, ...cfData }, [token]);
    if (lifecycle.signal.aborted || res.destroyed) return;
    sendJson(res, 200, payload);
    appendLog("turnstile_response", {
      route: "/__turnstile/verify",
      status: 200,
      response: redactValue(payload),
    });
  } catch (error) {
    if (lifecycle.signal.aborted || res.destroyed) return;
    const detail = error instanceof Error ? error.message : "verify_failed";
    const payload = {
      ok: false,
      success: false,
      error: maskCredentialPatterns(detail, [token]),
    };
    const responseStatus = error?.code === "request_body_too_large"
      ? 413
      : ["turnstile_invalid_response", "turnstile_response_too_large"].includes(detail) || /^turnstile_http_/.test(detail)
        ? 502
        : 500;
    sendJson(res, responseStatus, payload);
    appendLog("turnstile_response", {
      route: "/__turnstile/verify",
      status: responseStatus,
      response: payload,
    });
  } finally {
    lifecycle.cleanup();
    release();
  }
}

async function handleProbe(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const release = probeConcurrencyGate.tryAcquire();
  if (!release) {
    res.setHeader("Retry-After", "1");
    sendJson(res, 429, {
      ok: false,
      error: "probe_concurrency_limited",
      active: probeConcurrencyGate.active,
      limit: probeConcurrencyGate.limit,
    });
    return;
  }

  const lifecycle = createClientDisconnectController(req, res);
  try {
    await handleProbeRequest(req, res, lifecycle.signal);
  } finally {
    lifecycle.cleanup();
    release();
  }
}

async function handleProbeRequest(req, res, requestSignal) {

  const internalRequest = isInternalProbeRequest(req);
  if (!internalRequest) {
    const trustedWebRequest = isTrustedWebProxyRequest(req) || (allowLanWebWithoutTurnstile && isDirectLanRequest(req));
    if (!turnstileSecret && !allowPublicProbeWithoutTurnstile && !isDirectLoopbackRequest(req) && !trustedWebRequest) {
      sendJson(res, 403, { ok: false, error: "public_probe_disabled" });
      return;
    }
    if (turnstileSecret && !trustedWebRequest && !hasValidTurnstileSession(req)) {
      sendJson(res, 403, { ok: false, error: "turnstile_required" });
      return;
    }

    pruneRateBuckets(probeRateBuckets);
    const rateLimit = checkProbeRateLimit(req);
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      sendJson(res, 429, { ok: false, error: "probe_rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }
  }

  if (!isJsonRequest(req)) {
    res.setHeader("Accept-Post", "application/json");
    sendJson(res, 415, { ok: false, error: "unsupported_media_type" });
    return;
  }

  let upstreamDispatcher = null;
  let outboundCredentials = [];
  try {
    // Internal probes are generated by this process and may carry a native
    // image/PDF as base64. Public probe callers keep the bounded JSON limit.
    const raw = await readRequestBody(req, internalRequest ? Number.POSITIVE_INFINITY : maxRequestBodyBytes);
    let parsed;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, error: "invalid_request" });
      return;
    }
    const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : "";
    const method = typeof parsed.method === "string" ? parsed.method : "POST";
    if (method !== "POST") {
      sendJson(res, 400, { ok: false, error: "unsupported_method" });
      return;
    }
    const rawHeaders = parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers)
      ? Object.fromEntries(Object.entries(parsed.headers).filter(([, value]) => typeof value === "string"))
      : {};
    let headers;
    try {
      headers = sanitizeOutboundHeaders(rawHeaders);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error?.code === "forbidden_upstream_header"
          ? "forbidden_upstream_header"
          : "invalid_upstream_header",
      });
      return;
    }
    const body = parsed.body ?? {};
    const stage = typeof parsed.stage === "string" ? parsed.stage : "unknown";

    let endpointUrl;
    try {
      endpointUrl = new URL(endpoint);
      if (!/^https?:$/.test(endpointUrl.protocol) || endpointUrl.username || endpointUrl.password) {
        throw new Error("invalid_upstream_endpoint");
      }
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_upstream_endpoint" });
      return;
    }
    outboundCredentials = outboundCredentialSecrets(headers, endpointUrl);
    const privateTargetsAllowed = allowPrivateUpstreams && (
      internalRequest
        ? parsed.internalAllowPrivateUpstream === true
        : isAllowedLocalWebRequest(req)
    );
    let pinnedAddress;
    try {
      pinnedAddress = await assertUpstreamEndpointAllowed(endpointUrl, privateTargetsAllowed, requestSignal);
    } catch (error) {
      if (requestSignal?.aborted || res.destroyed) return;
      const code = error instanceof Error ? error.message : "upstream_endpoint_blocked";
      sendJson(res, code === "private_upstream_blocked" ? 403 : 502, { ok: false, error: code });
      return;
    }

    appendLog("probe_request", {
      route: "/__probe",
      stage,
      endpoint: redactEndpointForLog(endpoint),
      method,
      request: {
        headers: redactValue(headers, "", outboundCredentials),
        body: redactValue(body, "", outboundCredentials),
      },
    });

    const mode =
      parsed.mode === "openai" ||
      parsed.mode === "openai-chat" ||
      parsed.mode === "openai-responses" ||
      parsed.mode === "openai-images" ||
      parsed.mode === "google-generative" ||
      parsed.mode === "anthropic"
          ? parsed.mode === "openai"
            ? "openai-chat"
            : parsed.mode
        : String(endpoint).toLowerCase().includes("/v1/responses")
          ? "openai-responses"
          : String(endpoint).toLowerCase().includes("/v1/chat/completions")
            ? "openai-chat"
            : String(endpoint).toLowerCase().includes("/v1/images/generations")
              ? "openai-images"
              : String(endpoint).toLowerCase().includes("generatecontent")
                ? "google-generative"
            : "anthropic";
    const anthropicStream =
      mode === "anthropic" &&
      body &&
      typeof body === "object" &&
      body.stream === true;
    const vertexStream =
      mode === "google-generative" &&
      /:streamGenerateContent(?:$|[?#])/i.test(`${endpointUrl.pathname}${endpointUrl.search}`);

    const started = Date.now();
    let upstream;
    let preloadedBodyText = null;
    const requestCompatibilityFallbacks = [];
    try {
      const requestedTimeoutMs = Number.isFinite(parsed.timeoutMs) ? Math.trunc(parsed.timeoutMs) : null;
      const probeTimeoutMs = (stage === "cache" || /^cachecheck-r\d+$/.test(stage))
        ? Math.min(upstreamTimeoutMs, Math.max(1_000, Math.min(requestedTimeoutMs ?? 10_000, 10_000)))
        : stage === "live-knowledge"
          ? Math.min(upstreamTimeoutMs, 45_000)
          : upstreamTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(probeTimeoutMs);
      const upstreamSignal = requestSignal
        ? AbortSignal.any([requestSignal, timeoutSignal])
        : timeoutSignal;
      let upstreamHeaders = { ...headers };
      if (!Object.keys(upstreamHeaders).some((name) => name.toLowerCase() === "accept-encoding")) {
        upstreamHeaders["accept-encoding"] = "identity";
      }
      let upstreamBody = body;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        upstreamDispatcher = createPinnedDispatcher(pinnedAddress);
        upstream = await fetch(endpointUrl, {
          method,
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamBody),
          signal: upstreamSignal,
          redirect: "manual",
          dispatcher: upstreamDispatcher,
        });
        if (mode !== "anthropic" || upstream.status !== 400) break;

        const validationBody = await readResponseTextWithLimit(
          upstream,
          maxUpstreamResponseBytes,
          "upstream_response_too_large",
        );
        const retry = nextAnthropicCompatibilityRetry({
          status: upstream.status,
          responseBody: validationBody,
          headers: upstreamHeaders,
          body: upstreamBody,
          applied: requestCompatibilityFallbacks,
          allowCompatibilityRetry: parsed.allowCompatibilityRetry === true,
        });
        if (!retry) {
          preloadedBodyText = validationBody;
          break;
        }

        requestCompatibilityFallbacks.push(retry.reason);
        appendLog("probe_compatibility_retry", {
          route: "/__probe",
          stage,
          endpoint: redactEndpointForLog(endpoint),
          reason: retry.reason,
        });
        await closeDispatcher(upstreamDispatcher);
        upstreamDispatcher = null;
        upstreamHeaders = retry.headers;
        upstreamBody = retry.body;
      }
    } catch (error) {
      await closeDispatcher(upstreamDispatcher);
      upstreamDispatcher = null;
      if (requestSignal?.aborted || res.destroyed) return;
      const detail = error instanceof Error && error.message
        ? error.message
        : "upstream_fetch_failed";
      const status = error?.name === "TimeoutError" || /timeout/i.test(detail) ? 504 : 0;
      const payload = {
        ok: true,
        latencyMs: Date.now() - started,
        firstChunkLatencyMs: null,
        status,
        bodyText: JSON.stringify({
          error: {
            type: "upstream_unavailable",
            message: maskCredentialPatterns(detail, outboundCredentials),
          },
        }),
        finalUpstreamUrl: publicEndpointUrl(endpointUrl.toString()),
        upstreamRedirected: false,
        responseHeaders: {},
      };
      sendJson(res, 200, payload);
      appendLog("probe_response", {
        route: "/__probe",
        stage,
        endpoint: redactEndpointForLog(endpoint),
        status: 200,
        response: redactValue(payload, "", outboundCredentials),
      });
      return;
    }
    const declaredUpstreamLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declaredUpstreamLength) && declaredUpstreamLength > maxUpstreamResponseBytes) {
      const error = new Error("upstream_response_too_large");
      error.code = "upstream_response_too_large";
      throw error;
    }
    const firstChunkStartedAt = Date.now();
    let firstChunkLatencyMs = null;
    let bodyText = "";
    let upstreamResponseBytes = 0;
    const accountResponseBytes = (chunk) => {
      upstreamResponseBytes += Buffer.byteLength(chunk);
      if (upstreamResponseBytes > maxUpstreamResponseBytes) {
        const error = new Error("upstream_response_too_large");
        error.code = "upstream_response_too_large";
        throw error;
      }
    };
    let signatureDeltaTotalLength = 0;
    let signatureDeltaCount = 0;
    let signatureEmptyCount = 0;
    let signatureValues = [];
    let messageId = null;
    let streamMessageStartModel = null;
    let streamMessageStartInputTokens = null;
    let streamMessageDeltaInputTokensSamples = [];
    let streamOutputTokensSamples = [];
    let sseEventTypes = [];
    let sseContentTypes = [];
    let parsedSseLines = 0;
    let upstreamUsage = {};

    if (preloadedBodyText !== null) {
      bodyText = preloadedBodyText;
      accountResponseBytes(bodyText);
    } else if (anthropicStream && upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawSse = "";
      let aggregatedText = "";
      let modelName = null;
      let stopReason = null;
      const contentTypesSet = new Set();
      const eventTypes = [];
      const usage = {};

      const mergeUsage = (source) => {
        if (!source || typeof source !== "object") return;
        for (const key of [
          "input_tokens",
          "output_tokens",
          "cache_read_input_tokens",
          "cache_creation_input_tokens",
          "total_tokens",
          "prompt_tokens",
          "completion_tokens",
        ]) {
          const value = source[key];
          if (typeof value === "number") {
            usage[key] = value;
          }
        }
      };

      const handleEvent = (event) => {
        const eventType = typeof event.type === "string" ? event.type : "";
        if (eventType) eventTypes.push(eventType);

        if (eventType === "message_start") {
          const message = event.message;
          if (message && typeof message.id === "string") messageId = message.id;
          if (message && typeof message.model === "string") {
            modelName = message.model;
            streamMessageStartModel = message.model;
          }
          mergeUsage(message?.usage);
          if (typeof message?.usage?.input_tokens === "number") {
            streamMessageStartInputTokens = message.usage.input_tokens;
          }
        } else if (eventType === "content_block_start") {
          const block = event.content_block;
          if (block && typeof block.type === "string") contentTypesSet.add(block.type);
        } else if (eventType === "content_block_delta") {
          const delta = event.delta;
          const deltaType = delta && typeof delta.type === "string" ? delta.type : "";
          if (deltaType === "text_delta") {
            if (typeof delta?.text === "string") aggregatedText += delta.text;
          } else if (deltaType === "signature_delta") {
            if (typeof delta?.signature === "string") {
              if (delta.signature.length === 0) signatureEmptyCount += 1;
              else {
                signatureDeltaTotalLength += delta.signature.length;
                signatureDeltaCount += 1;
                signatureValues.push(delta.signature);
              }
            }
          } else if (deltaType === "thinking_delta") {
            contentTypesSet.add("thinking");
          }
        } else if (eventType === "message_delta") {
          mergeUsage(event.usage);
          if (typeof event.usage?.input_tokens === "number") {
            streamMessageDeltaInputTokensSamples.push(event.usage.input_tokens);
          }
          if (typeof event.usage?.output_tokens === "number") {
            streamOutputTokensSamples.push(event.usage.output_tokens);
          }
          const delta = event.delta;
          if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        }
      };

      const consumeEventLine = (line) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let event = null;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (!event || typeof event !== "object") return;
        parsedSseLines += 1;
        handleEvent(event);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkLatencyMs === null) {
          firstChunkLatencyMs = Date.now() - firstChunkStartedAt;
        }
        if (!value) continue;

        const chunkText = decoder.decode(value, { stream: true });
        accountResponseBytes(chunkText);
        rawSse += chunkText;
        buffer += chunkText;

        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n");
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          consumeEventLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeEventLine(buffer.trim());

      if (parsedSseLines === 0) {
        bodyText = rawSse;
        try {
          const fallback = JSON.parse(bodyText);
          if (fallback?.usage && typeof fallback.usage === "object") {
            upstreamUsage = fallback.usage;
          }
        } catch {
          upstreamUsage = {};
        }
      } else {
        sseEventTypes = eventTypes;
        sseContentTypes = [...contentTypesSet];
        upstreamUsage = usage;
        bodyText = JSON.stringify({
          ...(messageId ? { id: messageId } : {}),
          model: modelName || null,
          role: "assistant",
          content: [{ type: "text", text: aggregatedText }],
          stop_reason: stopReason,
          usage,
          _sse_meta: {
            event_types: eventTypes,
            content_types: [...contentTypesSet],
            signature_delta_total_length: signatureDeltaTotalLength,
            signature_delta_count: signatureDeltaCount,
            signature_empty_count: signatureEmptyCount,
            message_id: messageId,
          },
        });
      }
    } else if (mode === "openai-chat" && body?.stream === true && upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawSse = "";
      let aggregatedText = "";
      let modelName = null;
      let role = "assistant";
      let finishReason = null;
      const eventTypes = [];
      const usage = {};

      const handleEvent = (event) => {
        const eventType =
          typeof event.object === "string"
            ? event.object
            : typeof event.type === "string"
              ? event.type
              : "chat.completion.chunk";
        eventTypes.push(eventType);
        if (typeof event.id === "string") messageId = event.id;
        if (typeof event.model === "string") modelName = event.model;
        if (event.usage && typeof event.usage === "object") Object.assign(usage, event.usage);

        const choice = Array.isArray(event.choices) ? event.choices[0] : null;
        const delta = choice && typeof choice.delta === "object" ? choice.delta : null;
        if (typeof delta?.role === "string") role = delta.role;
        if (typeof delta?.content === "string") aggregatedText += delta.content;
        if (typeof choice?.finish_reason === "string" || choice?.finish_reason === null) {
          finishReason = choice.finish_reason;
        }
      };

      const consumeEventLine = (line) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let event = null;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (!event || typeof event !== "object") return;
        parsedSseLines += 1;
        handleEvent(event);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkLatencyMs === null) {
          firstChunkLatencyMs = Date.now() - firstChunkStartedAt;
        }
        if (!value) continue;

        const chunkText = decoder.decode(value, { stream: true });
        accountResponseBytes(chunkText);
        rawSse += chunkText;
        buffer += chunkText;

        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n");
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          consumeEventLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeEventLine(buffer.trim());

      sseEventTypes = eventTypes;
      sseContentTypes = ["text"];
      upstreamUsage = usage;
      bodyText = parsedSseLines > 0
        ? JSON.stringify({
            id: messageId,
            model: modelName,
            choices: [{ message: { role, content: aggregatedText }, finish_reason: finishReason }],
            usage,
            _sse_meta: { event_types: eventTypes },
          })
        : rawSse;
    } else if (vertexStream && upstream.body) {
      // Vertex `streamGenerateContent` is newline/SSE framed JSON rather than
      // one JSON document. Normalize its chunks into the same response shape
      // used by the non-streaming Gemini adapter so the client can grade text,
      // usage, and model-version evidence consistently.
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawStream = "";
      let modelVersion = null;
      let finishReason = null;
      const parts = [];
      const usageMetadata = {};
      const eventTypes = [];

      const handleVertexEvent = (event) => {
        if (Array.isArray(event)) {
          event.forEach(handleVertexEvent);
          return;
        }
        if (!event || typeof event !== "object") return;
        const value = event;
        if (typeof value.modelVersion === "string") modelVersion = value.modelVersion;
        if (value.usageMetadata && typeof value.usageMetadata === "object") {
          Object.assign(usageMetadata, value.usageMetadata);
        }
        const candidate = Array.isArray(value.candidates) ? value.candidates[0] : null;
        if (!candidate || typeof candidate !== "object") return;
        if (typeof candidate.finishReason === "string") finishReason = candidate.finishReason;
        const candidateParts = candidate.content && typeof candidate.content === "object" &&
          Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
        for (const part of candidateParts) {
          if (!part || typeof part !== "object" || typeof part.text !== "string") continue;
          const normalizedPart = {
            text: part.text,
            ...(part.thought === true ? { thought: true } : {}),
          };
          parts.push(normalizedPart);
        }
      };

      const consumeVertexLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!data || data === "[DONE]") return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        parsedSseLines += 1;
        eventTypes.push("vertex_chunk");
        handleVertexEvent(event);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkLatencyMs === null) firstChunkLatencyMs = Date.now() - firstChunkStartedAt;
        if (!value) continue;
        const chunkText = decoder.decode(value, { stream: true });
        accountResponseBytes(chunkText);
        rawStream += chunkText;
        buffer += chunkText;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          consumeVertexLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeVertexLine(buffer);
      sseEventTypes = eventTypes;
      sseContentTypes = parts.length > 0 ? ["text"] : [];
      upstreamUsage = usageMetadata;
      bodyText = parsedSseLines > 0
        ? JSON.stringify({
            modelVersion,
            candidates: [{
              content: { parts },
              finishReason,
            }],
            usageMetadata,
            _sse_meta: { event_types: eventTypes },
          })
        : rawStream;
    } else if (upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkLatencyMs === null) {
          firstChunkLatencyMs = Date.now() - firstChunkStartedAt;
        }
        if (value) {
          const chunkText = decoder.decode(value, { stream: true });
          accountResponseBytes(chunkText);
          bodyText += chunkText;
        }
      }
      bodyText += decoder.decode();
    } else {
      if (Number(upstream.headers.get("content-length")) > maxUpstreamResponseBytes) {
        const error = new Error("upstream_response_too_large");
        error.code = "upstream_response_too_large";
        throw error;
      }
      bodyText = await upstream.text();
      accountResponseBytes(bodyText);
    }
    await closeDispatcher(upstreamDispatcher);
    upstreamDispatcher = null;

    const latencyMs = Date.now() - started;
    const respHeaders = Object.fromEntries(upstream.headers.entries());
    const responseHeaders = {};
    for (const name of [
      "content-type",
      "server",
      "via",
      "x-amzn-requestid",
      "x-amzn-bedrock-trace",
      "x-amzn-bedrock-content-type",
      "x-amzn-bedrock-invocation-latency",
      "x-amzn-bedrock-performance-config-latency",
      "x-goog-api-client",
      "x-goog-request-id",
      "x-goog-user-project",
      "x-cloud-trace-context",
    ]) {
      if (typeof respHeaders[name] === "string" && respHeaders[name]) {
        responseHeaders[name] = respHeaders[name];
      }
    }
    const redirectLocation = upstream.status >= 300 && upstream.status < 400
      ? upstream.headers.get("location")
      : null;
    let observedFinalUrl = upstream.url || endpoint;
    if (redirectLocation) {
      try {
        observedFinalUrl = new URL(redirectLocation, endpointUrl).toString();
      } catch {
        // Keep the requested endpoint when a malformed Location is returned.
      }
    }
    let parsedResponseBody = null;
    try {
      parsedResponseBody = JSON.parse(bodyText);
    } catch {
      parsedResponseBody = null;
    }

    // Non-streaming Anthropic/Vertex Messages responses carry the opaque
    // signature on the thinking content block instead of a signature_delta
    // SSE event. Feed both transports through the same envelope inspector.
    if (mode === "anthropic" && signatureValues.length === 0 && parsedResponseBody && typeof parsedResponseBody === "object") {
      const extracted = extractAnthropicContentSignatures(parsedResponseBody);
      if (extracted.messageId) messageId = extracted.messageId;
      if (extracted.model) streamMessageStartModel = extracted.model;
      signatureEmptyCount += extracted.emptyCount;
      signatureValues.push(...extracted.values);
      signatureDeltaCount += extracted.values.length;
      signatureDeltaTotalLength += extracted.values.reduce((sum, value) => sum + value.length, 0);
    }

    let usage = {};

    if (Object.keys(upstreamUsage).length > 0) {
      usage = upstreamUsage;
    } else if (parsedResponseBody && typeof parsedResponseBody === "object") {
      if (parsedResponseBody.usage && typeof parsedResponseBody.usage === "object") {
        usage = parsedResponseBody.usage;
      }
    }

    const cacheRead = readUsageNumber(usage, [
      ["cache_read_input_tokens"],
      ["cached_tokens"],
      ["prompt_tokens_details", "cached_tokens"],
      ["input_tokens_details", "cached_tokens"],
      ["cache_read_tokens"],
    ]);
    const cacheCreation = readUsageNumber(usage, [
      ["cache_creation_input_tokens"],
      ["cache_write_input_tokens"],
      ["cache_creation_tokens"],
    ]);
    const cacheEvidenceFields = [
      readUsageField(usage, [["cache_read_input_tokens"], ["cached_tokens"], ["prompt_tokens_details", "cached_tokens"], ["input_tokens_details", "cached_tokens"], ["cache_read_tokens"]]),
      readUsageField(usage, [["cache_creation_input_tokens"], ["cache_write_input_tokens"], ["cache_creation_tokens"]]),
    ].filter(Boolean);
    // A cache hit is only trusted when the provider reports cache token usage.
    // Relay/proxy cache headers are not model-level prompt-cache evidence.
    const cacheHit = cacheRead > 0;
    const signatureEnvelope = inspectClaudeSignatureEnvelope({
      signature: signatureValues.join(""),
      requestedModel: typeof body?.model === "string" ? body.model : null,
    });
    const signatureIsValidBase64 = signatureEnvelope.signatureIsValidBase64;
    const signatureVerdict = signatureEnvelope.signatureVerdict;
    const sigModelName = signatureEnvelope.sigModelName;
    const signatureEnvelopeModel = signatureEnvelope.signatureEnvelopeModel;
    const signatureEnvelopeMatchesRequested = signatureEnvelope.signatureEnvelopeMatchesRequested;
    // Envelope parsing is deliberately not presented as a provider signature
    // verification. Only the provider can make that cryptographic claim.
    const signatureCryptographicallyVerified = false;

    // Never echo the credential supplied for this outbound request, even when
    // an upstream includes an unknown credential format in a successful or
    // error response body.
    bodyText = redactExactSecrets(bodyText, outboundCredentials);

    const payload = redactExactSecretsInValue({
      ok: true,
      latencyMs,
      firstChunkLatencyMs,
      rawSseEventCount: parsedSseLines,
      status: upstream.status,
      usage,
      cacheHit,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      cacheEvidenceFields: [...new Set(cacheEvidenceFields)],
      signatureDeltaTotalLength,
      signatureDeltaCount,
      signatureEmptyCount,
      signatureIsValidBase64,
      signatureVerdict,
      signatureCompatibilityVerdict: signatureEnvelope.signatureCompatibilityVerdict,
      signatureCompatibilityReason: signatureEnvelope.signatureCompatibilityReason,
      signatureFormulaCompatible: signatureEnvelope.signatureFormulaCompatible,
      sigModelName,
      signatureEnvelopeModel,
      signatureEnvelopeMatchesRequested,
      signatureEnvelopeChannelPresent: signatureEnvelope.signatureEnvelopeChannelPresent,
      signatureEnvelopeChannelValue: signatureEnvelope.signatureEnvelopeChannelValue,
      signatureEnvelopeVersion: signatureEnvelope.signatureEnvelopeVersion,
      signatureEnvelopeKeyVersion: signatureEnvelope.signatureEnvelopeKeyVersion,
      signatureEnvelopeSchemaVersion: signatureEnvelope.signatureEnvelopeSchemaVersion,
      signatureEnvelopeVariant: signatureEnvelope.signatureEnvelopeVariant,
      signatureEnvelopePayloadType: signatureEnvelope.signatureEnvelopePayloadType,
      signatureEnvelopeSessionId: signatureEnvelope.signatureEnvelopeSessionId,
      signatureEnvelopeEncryptedPayloadBytes: signatureEnvelope.signatureEnvelopeEncryptedPayloadBytes,
      signatureFormat: signatureEnvelope.signatureFormat,
      signatureStructureIssues: signatureEnvelope.signatureStructureIssues,
      signatureReason: signatureEnvelope.signatureReason,
      signatureStructurallyParsed: signatureEnvelope.signatureStructurallyParsed,
      signatureCryptographicallyVerified,
      finalUpstreamUrl: publicEndpointUrl(observedFinalUrl),
      upstreamRedirected: upstream.redirected === true || (upstream.status >= 300 && upstream.status < 400),
      responseHeaders,
      messageId,
      streamMessageStartModel,
      streamMessageStartInputTokens,
      streamMessageDeltaInputTokensSamples,
      streamOutputTokensSamples,
      sseEventTypes,
      sseContentTypes,
      requestCompatibilityFallbacks,
      bodyText,
    }, outboundCredentials);
    sendJson(res, 200, payload);
    appendLog("probe_response", {
      route: "/__probe",
      stage,
      endpoint: redactEndpointForLog(endpoint),
      status: 200,
      response: redactValue(payload, "", outboundCredentials),
    });
  } catch (error) {
    await closeDispatcher(upstreamDispatcher);
    if (requestSignal?.aborted || res.destroyed) return;
    const payload = {
      ok: false,
      error: error?.code === "request_body_too_large"
        ? "request_body_too_large"
        : error?.code === "upstream_response_too_large"
          ? "upstream_response_too_large"
          : "probe_failed",
    };
    const responseStatus = error?.code === "request_body_too_large"
      ? 413
      : error?.code === "upstream_response_too_large"
        ? 502
        : 500;
    sendJson(res, responseStatus, payload);
    appendLog("probe_response", {
      route: "/__probe",
      status: responseStatus,
      response: payload,
    });
  }
}

function internalProbeUrl() {
  if (host === "::" || host === "::1") return `http://[::1]:${port}/__probe`;
  if (host === "0.0.0.0") return `http://127.0.0.1:${port}/__probe`;
  return `http://${host}:${port}/__probe`;
}

export function internalProbeUnavailableResult(reason, latencyMs = 0) {
  const detail = maskCredentialPatterns(String(reason || "internal_probe_unavailable")).slice(0, 500);
  return {
    ok: true,
    latencyMs: Math.max(0, Math.trunc(latencyMs)),
    firstChunkLatencyMs: null,
    status: 0,
    bodyText: JSON.stringify({
      error: {
        type: "internal_probe_unavailable",
        message: detail,
      },
    }),
    finalUpstreamUrl: null,
    upstreamRedirected: false,
    responseHeaders: {},
    requestCompatibilityFallbacks: [],
  };
}

export async function invokeInternalProbe(payload, options = {}) {
  const started = Date.now();
  let response;
  try {
    const timeoutSignal = AbortSignal.timeout(upstreamTimeoutMs + 10_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    response = await fetch(internalProbeUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kangkang-internal-probe": internalProbeToken,
      },
      body: JSON.stringify({
        ...payload,
        internalAllowPrivateUpstream: options.allowPrivateUpstream === true,
      }),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      if (options.signal.reason instanceof Error) throw options.signal.reason;
      const aborted = new Error("Detection request aborted");
      aborted.name = "AbortError";
      throw aborted;
    }
    const detail = error instanceof Error ? error.message : "internal_probe_fetch_failed";
    const reason = error?.name === "TimeoutError" || /(?:timeout|aborted)/i.test(detail)
      ? "internal_probe_timeout"
      : "internal_probe_fetch_failed";
    return internalProbeUnavailableResult(reason, Date.now() - started);
  }
  let result = null;
  try {
    result = await response.json();
  } catch {
    return internalProbeUnavailableResult("internal_probe_invalid_response", Date.now() - started);
  }
  if (!response.ok || !result || result.ok !== true) {
    const reason = typeof result?.error === "string" ? result.error : "internal_probe_failed";
    if (
      response.status >= 500 ||
      response.status === 429 ||
      reason === "probe_failed" ||
      reason === "probe_concurrency_limited" ||
      reason === "upstream_response_too_large"
    ) {
      return internalProbeUnavailableResult(reason, Date.now() - started);
    }
    throw new Error(reason);
  }
  return result;
}

function sendApiError(res, statusCode, code, message, details) {
  res.kangkangErrorCode = code;
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, statusCode, {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function canonicalDetectionRequest(value) {
  return {
    base_url: value.baseUrl,
    upstream_api_key: value.upstreamApiKey,
    model: value.model,
    ...(value.profileModel ? { profile_model: value.profileModel } : {}),
    protocol: value.protocol,
    question_mode: value.questionMode,
    rounds: value.rounds,
    checks: {
      cache: value.checks.cache,
      cache_runs: value.cacheRuns ?? 1,
      live_knowledge: value.checks.liveKnowledge,
    },
    attachments: Array.isArray(value.attachments) ? value.attachments : [],
  };
}

function normalizedHistoryVerdict(value) {
  return ["verified", "consistent", "suspicious", "unverifiable"].includes(value) ? value : "unverifiable";
}

function historyReason(row, result) {
  const reason = result?.authenticity?.reason;
  if (typeof reason === "string") return reason;
  if (row.status === "unavailable" || row.status === "incomplete") return "upstream-unavailable";
  if (row.verdict === "suspicious") return "identity-mismatch";
  if (row.verdict === "consistent") return "dedicated-match";
  return "insufficient-evidence";
}

export function publicAttachmentAnalysis(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return report ?? null;
  const items = Array.isArray(report.items)
    ? report.items.map((item, index) => {
        const { raw_response: _rawResponse, ...publicItem } = item && typeof item === "object" ? item : {};
        const invalidCompletedAnalysis = publicItem.status === "completed" && (
          !publicItem.analysis || isUngroundedAttachmentAnalysis(publicItem.analysis)
        );
        const normalizedItem = {
          ...publicItem,
          attachment_id: publicItem.name || `attachment-${index + 1}`,
          ...(typeof publicItem.name === "string" && publicItem.name.trim()
            ? { url: attachmentViewUrl(publicItem.name) }
            : {}),
          ...(invalidCompletedAnalysis ? {
            status: "failed",
            analysis: null,
            verification: null,
            error: "attachment_not_observed_by_model",
          } : {}),
        };
        const recognized = normalizedItem.status === "completed" && Boolean(normalizedItem.analysis) && !isUngroundedAttachmentAnalysis(normalizedItem.analysis);
        const recognitionStatus = normalizedItem.status === "completed" && !invalidCompletedAnalysis && (
          normalizedItem.recognition_status === "recognized" || normalizedItem.recognition_status === "not-recognized"
        )
          ? normalizedItem.recognition_status
          : recognized ? "recognized" : "not-recognized";
        const validRecognitionReasons = new Set([
          "model_returned_grounded_attachment_observation",
          "model_did_not_observe_attachment",
          "model_returned_invalid_response",
          "upstream_returned_invalid_json",
          "upstream_request_failed",
          "attachment_not_found",
          "attachment_analysis_failed",
        ]);
        const recognitionReason = !invalidCompletedAnalysis && validRecognitionReasons.has(normalizedItem.recognition_reason)
          ? normalizedItem.recognition_reason
          : recognized
            ? "model_returned_grounded_attachment_observation"
            : normalizedItem.error === "attachment_not_observed_by_model"
              ? "model_did_not_observe_attachment"
              : normalizedItem.error === "attachment_invalid_analysis_structure" || normalizedItem.error === "attachment_empty_model_response"
                ? "model_returned_invalid_response"
                : normalizedItem.error === "attachment_not_found"
                  ? "attachment_not_found"
                  : "attachment_analysis_failed";
        return {
          ...normalizedItem,
          recognition_status: recognitionStatus,
          recognition_reason: recognitionReason,
        };
      })
    : [];
  const total = Number.isInteger(report.total) && report.total >= 0 ? report.total : items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const recognizedCount = items.filter((item) => item.recognition_status === "recognized").length;
  return {
    ...report,
    status: total > 0 ? (completed === total ? "completed" : completed > 0 ? "partial" : "failed") : report.status,
    recognition_status: total === 0 ? "not-recognized" : recognizedCount === total ? "recognized" : recognizedCount > 0 ? "partial" : "not-recognized",
    recognition_total: total,
    recognized_count: recognizedCount,
    scored: false,
    affects_primary_score: false,
    completed,
    total,
    items,
  };
}

function publicHistoryEntry(row) {
  const result = row.result && typeof row.result === "object" ? row.result : {};
  const rawChecks = Array.isArray(result.checks) ? result.checks : [];
  const checks = rawChecks.map((item) => ({
    name: typeof item?.name === "string" ? item.name : typeof item?.id === "string" ? item.id : "check",
    status: ["pass", "warning", "fail"].includes(item?.status) ? item.status : "warning",
    detail: typeof item?.detail === "string" ? item.detail : "",
    category: ["ability", "authenticity", "operational"].includes(item?.category) ? item.category : undefined,
  }));
  const evidenceLevel = result?.authenticity?.evidenceLevel ?? result?.verdict?.evidence_level ?? "insufficient";
  const metrics = result?.metrics && typeof result.metrics === "object" ? result.metrics : {};
  const attachments = appStorage().listAttachments(row.attachmentIds ?? [], row.owner_scope)
    .map((attachment, index) => ({
      ...attachment,
      id: attachment.original_name || `attachment-${index + 1}`,
      name: attachment.original_name || `attachment-${index + 1}`,
      url: attachmentViewUrl(attachment.original_name || `attachment-${index + 1}`),
    }));
  return {
    storageId: row.id,
    id: typeof result.id === "string" ? result.id : row.report_id || row.id,
    source: row.source,
    timestamp: row.created_at,
    model: row.model,
    endpoint: row.base_url_display,
    score: typeof row.score === "number" ? row.score : null,
    status: normalizedHistoryVerdict(result?.authenticity?.verdict ?? result?.verdict?.value ?? row.verdict),
    runStatus: row.status,
    evidenceLevel: ["provider-transport", "cryptographic", "behavioral", "conflict", "insufficient"].includes(evidenceLevel)
      ? evidenceLevel
      : "insufficient",
    verdictReason: historyReason(row, result),
    verifierScope: result?.authenticity?.verifierScope ?? (result?.profile?.dedicated ? "dedicated" : "quality-only"),
    profileId: result?.profileId ?? result?.profile?.id ?? row.profile_model ?? undefined,
    resultKind: result?.kind === "image" || result?.profile?.family === "image" ? "image" : "text",
    checks,
    latency: typeof result?.latency === "number" ? result.latency : typeof metrics.core_latency_ms === "number" ? metrics.core_latency_ms : undefined,
    tps: typeof result?.tps === "number" ? result.tps : undefined,
    inputTokens: typeof result?.inputTokens === "number" ? result.inputTokens : typeof metrics.input_tokens === "number" ? metrics.input_tokens : undefined,
    outputTokens: typeof result?.outputTokens === "number" ? result.outputTokens : typeof metrics.output_tokens === "number" ? metrics.output_tokens : undefined,
    attachments,
    attachmentAnalysis: publicAttachmentAnalysis(result?.attachmentAnalysis ?? result?.attachment_analysis ?? null),
    canRetest: row.status !== "running",
  };
}

function historyAuthorization(req, res) {
  const authorization = webDataAuthorization(req, res);
  return authorization.allowed
    ? authorization
    : { ...authorization, code: authorization.code || "history_local_or_bearer_required" };
}

async function executePersistedDetection(value, {
  source,
  parentRunId = null,
  ownerScope,
  signal,
  allowPrivateUpstream = false,
} = {}) {
  const reportId = randomUUID();
  const request = canonicalDetectionRequest(value);
  const runId = appStorage().createRun({ source, ownerScope, parentRunId, request, reportId });
  try {
    const report = await runModelDetection(value, {
      id: reportId,
      seedSecret: detectionSeedSecret,
      signal,
      probe: (payload, options = {}) => invokeInternalProbe(payload, {
        ...options,
        allowPrivateUpstream,
      }),
      getLiveKnowledgeSnapshot,
    });
    if (value.attachments?.length > 0) {
      report.attachment_analysis = publicAttachmentAnalysis(await analyzeAttachments({
        input: value,
        attachmentSpecs: value.attachments,
        storage: appStorage(),
        ownerScope,
        signal,
        fallbackModels: attachmentFallbackModels,
        fallbackProtocols: attachmentFallbackProtocols,
        fallbackAttempts: attachmentFallbackAttempts,
        probe: (payload, options = {}) => invokeInternalProbe(payload, {
          ...options,
          allowPrivateUpstream,
        }),
      }));
      report.request.attachments = value.attachments.map((item) => {
        const record = appStorage().getAttachment(item.id, ownerScope);
        return {
          name: record?.original_name || "attachment",
          mode: item.mode,
        };
      });
    }
    appStorage().finishRun(runId, { status: report.status, report });
    return { runId, report };
  } catch (error) {
    appStorage().finishRun(runId, {
      status: signal?.aborted ? "cancelled" : "failed",
      errorCode: signal?.aborted ? "request_aborted" : "detection_failed",
      errorMessage: error instanceof Error ? maskCredentialPatterns(error.message, [value.upstreamApiKey]) : "detection_failed",
    });
    throw error;
  }
}

async function handleAttachmentUpload(req, res) {
  if (!ensureApiMethod(req, res, "POST")) return;
  req.setTimeout(0);
  const authorization = webDataAuthorization(req, res);
  if (!authorization.allowed) {
    sendApiError(res, authorization.status || 403, authorization.code || "attachment_access_denied", "Attachment upload requires local, Turnstile, or detector API access");
    return;
  }
  const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    sendApiError(res, 415, "unsupported_media_type", "Content-Type must be multipart/form-data");
    return;
  }
  const lifecycle = createClientDisconnectController(req, res);
  try {
    const { records, fields } = await receiveAttachmentUploadWithFields(req, {
      storage: appStorage(),
      ownerScope: authorization.ownerScope,
      signal: lifecycle.signal,
    });
    if (!lifecycle.signal.aborted && !res.destroyed) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Cookie, Authorization");
      const body = { ok: true, items: records.map(publicAttachmentRecord) };
      if (fields._sys != null) body._sys = fields._sys;
      sendJson(res, 201, body);
    }
  } catch (error) {
    if (lifecycle.signal.aborted || res.destroyed) return;
    const code = error?.code || error?.message || "attachment_upload_failed";
    sendApiError(res, 400, code, "Unable to store the attachment upload");
  } finally {
    lifecycle.cleanup();
  }
}

async function handleAttachmentDelete(req, res, attachmentId) {
  if (!ensureApiMethod(req, res, "DELETE")) return;
  const authorization = webDataAuthorization(req, res);
  if (!authorization.allowed) {
    sendApiError(res, authorization.status || 403, authorization.code || "attachment_access_denied", "Attachment deletion requires local, verified Web, or detector API access");
    return;
  }
  if (!/^att_[a-f0-9]{32}$/i.test(attachmentId)) {
    sendApiError(res, 400, "invalid_attachment_id", "Attachment ID is invalid");
    return;
  }
  const result = appStorage().deleteAttachment(attachmentId, authorization.ownerScope);
  if (!result.deleted) {
    if (result.reason === "attachment_in_use") {
      sendApiError(res, 409, "attachment_in_use", "Attachment is still referenced by saved history");
    } else {
      sendApiError(res, 404, "attachment_not_found", "Attachment does not exist in this session");
    }
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Cookie, Authorization");
  sendJson(res, 200, { ok: true, deleted: true, id: attachmentId });
}

async function handleWebAttachmentAnalysis(req, res) {
  if (!ensureApiMethod(req, res, "POST")) return;
  const authorization = webDataAuthorization(req, res);
  if (!authorization.allowed) {
    sendApiError(res, authorization.status || 403, authorization.code || "attachment_access_denied", "Attachment analysis requires local or verified web access");
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie, Authorization");
  if (/^multipart\/form-data\s*;/i.test(String(req.headers["content-type"] || ""))) {
    req.setTimeout(0);
    const lifecycle = createClientDisconnectController(req, res);
    let records = [];
    try {
      const uploaded = await receiveAttachmentUploadWithFields(req, {
        storage: appStorage(),
        ownerScope: authorization.ownerScope,
        signal: lifecycle.signal,
      });
      records = uploaded.records;
      const request = parseMultipartDetectionRequest(uploaded.fields, records);
      const validation = validateDetectionRequest(request);
      if (!validation.ok) {
        cleanupUploadedRecords(records, authorization.ownerScope);
        sendApiError(res, 400, "validation_failed", "One or more request fields are invalid", validation.errors);
        return;
      }
      const result = await analyzeAttachments({
        input: validation.value,
        attachmentSpecs: validation.value.attachments,
        storage: appStorage(),
        ownerScope: authorization.ownerScope,
        signal: lifecycle.signal,
        fallbackModels: attachmentFallbackModels,
        fallbackProtocols: attachmentFallbackProtocols,
        fallbackAttempts: attachmentFallbackAttempts,
        probe: (payload, options = {}) => invokeInternalProbe(payload, {
          ...options,
          allowPrivateUpstream: allowPrivateUpstreams && isAllowedLocalWebRequest(req),
        }),
      });
      if (!lifecycle.signal.aborted && !res.destroyed) {
        sendJson(res, 200, {
          ok: true,
          attachments: records.map(publicAttachmentRecord),
          attachment_analysis: publicAttachmentAnalysis(result),
        });
      }
    } catch (error) {
      cleanupUploadedRecords(records, authorization.ownerScope);
      if (lifecycle.signal.aborted || res.destroyed) return;
      sendApiError(res, 400, error?.code || "attachment_analysis_failed", "Unable to process the multipart attachment analysis request");
    } finally {
      lifecycle.cleanup();
    }
    return;
  }
  if (!isJsonRequest(req)) {
    sendApiError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
    return;
  }
  let body;
  try {
    body = JSON.parse(await readRequestBody(req, maxRequestBodyBytes) || "{}");
  } catch (error) {
    sendApiError(res, error?.code === "request_body_too_large" ? 413 : 400, error?.code || "invalid_json", "Invalid attachment-analysis request");
    return;
  }
  const validation = validateDetectionRequest(body);
  if (!validation.ok) {
    sendApiError(res, 400, "validation_failed", "One or more request fields are invalid", validation.errors);
    return;
  }
  if (validation.value.attachments.length === 0) {
    sendApiError(res, 400, "attachment_required", "At least one uploaded attachment is required");
    return;
  }
  const lifecycle = createClientDisconnectController(req, res);
  try {
    const result = await analyzeAttachments({
      input: validation.value,
      attachmentSpecs: validation.value.attachments,
      storage: appStorage(),
      ownerScope: authorization.ownerScope,
      signal: lifecycle.signal,
      fallbackModels: attachmentFallbackModels,
      fallbackProtocols: attachmentFallbackProtocols,
      fallbackAttempts: attachmentFallbackAttempts,
      probe: (payload, options = {}) => invokeInternalProbe(payload, {
        ...options,
        allowPrivateUpstream: allowPrivateUpstreams && isAllowedLocalWebRequest(req),
      }),
    });
    if (!lifecycle.signal.aborted && !res.destroyed) sendJson(res, 200, { ok: true, attachment_analysis: publicAttachmentAnalysis(result) });
  } catch (error) {
    if (lifecycle.signal.aborted || res.destroyed) return;
    sendApiError(res, 500, "attachment_analysis_failed", "Attachment analysis could not be completed");
  } finally {
    lifecycle.cleanup();
  }
}

async function handleWebHistory(req, res) {
  const authorization = historyAuthorization(req, res);
  if (!authorization.allowed) {
    sendApiError(res, authorization.status, authorization.code, "History is available locally or with a detector API key");
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie, Authorization");
  if (req.method === "GET") {
    const entries = appStorage().listRuns({ limit: 200, ownerScope: authorization.ownerScope }).map(publicHistoryEntry);
    sendJson(res, 200, { ok: true, items: entries });
    return;
  }
  if (req.method === "DELETE") {
    const deleted = appStorage().clearRuns(authorization.ownerScope);
    const attachmentsPruned = appStorage().pruneUnreferencedAttachments({
      ownerScope: authorization.ownerScope,
      olderThan: new Date(Date.now() - attachmentOrphanRetentionMs),
    });
    sendJson(res, 200, { ok: true, deleted, attachments_pruned: attachmentsPruned });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, DELETE");
    sendApiError(res, 405, "method_not_allowed", "Use GET, POST, or DELETE for this endpoint");
    return;
  }
  if (!isJsonRequest(req)) {
    sendApiError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
    return;
  }
  let body;
  try {
    body = JSON.parse(await readRequestBody(req, maxRequestBodyBytes) || "{}");
  } catch (error) {
    sendApiError(res, error?.code === "request_body_too_large" ? 413 : 400, error?.code || "invalid_json", "Invalid history record");
    return;
  }
  const validation = validateDetectionRequest(body?.request);
  if (!validation.ok || !body?.result || typeof body.result !== "object" || Array.isArray(body.result)) {
    sendApiError(res, 400, "validation_failed", "A valid detection request and result are required", validation.errors);
    return;
  }
  const missingAttachments = validation.value.attachments.filter(
    (attachment) => !appStorage().getAttachment(attachment.id, authorization.ownerScope),
  );
  if (missingAttachments.length > 0) {
    sendApiError(res, 404, "attachment_not_found", "One or more attachments do not belong to this session");
    return;
  }
  const safeResult = redactExactSecretsInValue(body.result, [validation.value.upstreamApiKey]);
  const request = canonicalDetectionRequest(validation.value);
  const runId = appStorage().createRun({
    source: "web",
    ownerScope: authorization.ownerScope,
    request,
    reportId: safeResult.id ?? null,
  });
  const status = safeResult?.upstreamAvailability?.allUnavailable ? "unavailable" : safeResult?.status || "completed";
  appStorage().finishRun(runId, { status, report: safeResult });
  sendJson(res, 201, {
    ok: true,
    item: publicHistoryEntry(appStorage().getRunPublic(runId, authorization.ownerScope)),
  });
}

async function handleWebHistoryRetest(req, res, runId) {
  if (!ensureApiMethod(req, res, "POST")) return;
  const authorization = historyAuthorization(req, res);
  if (!authorization.allowed) {
    sendApiError(res, authorization.status, authorization.code, "History retest is available locally or with a detector API key");
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie, Authorization");
  const stored = appStorage().getRunForRetry(runId, authorization.ownerScope);
  if (!stored) {
    sendApiError(res, 404, "history_not_found", "The history record does not exist");
    return;
  }
  const validation = validateDetectionRequest(stored.request);
  if (!validation.ok) {
    sendApiError(res, 409, "history_not_retestable", "The saved request is no longer compatible", validation.errors);
    return;
  }
  if (activeDetections >= detectionMaxConcurrency) {
    res.setHeader("Retry-After", "2");
    sendApiError(res, 429, "detection_concurrency_limited", "The detector is busy; retry shortly");
    return;
  }
  activeDetections += 1;
  const lifecycle = createClientDisconnectController(req, res);
  try {
    const executed = await executePersistedDetection(validation.value, {
      source: "retest",
      parentRunId: runId,
      ownerScope: authorization.ownerScope,
      signal: lifecycle.signal,
      allowPrivateUpstream: allowPrivateUpstreams && isAllowedLocalWebRequest(req),
    });
    if (!lifecycle.signal.aborted && !res.destroyed) {
      sendJson(res, 200, {
        ok: true,
        item: publicHistoryEntry(appStorage().getRunPublic(executed.runId, authorization.ownerScope)),
      });
    }
  } catch (error) {
    if (lifecycle.signal.aborted || res.destroyed) return;
    sendApiError(res, 500, "retest_failed", "The saved detection could not be repeated");
  } finally {
    lifecycle.cleanup();
    activeDetections -= 1;
  }
}

async function proxyInstallTracker(req, res, pathname) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    if (req.method === "POST") req.resume();
    const response = await fetch(`${installTrackerUrl}${pathname}`, {
      method: req.method,
      headers: { accept: req.headers.accept || "application/json" },
      signal: controller.signal,
    });
    res.statusCode = response.status;
    for (const name of ["content-type", "cache-control", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!response.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    sendApiError(res, 503, "installation_tracker_unavailable", "The installation tracker is unavailable");
  } finally {
    req.removeListener("aborted", abort);
    res.removeListener("close", abort);
  }
}

function ensureApiMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader("Allow", method);
  sendApiError(res, 405, "method_not_allowed", `Use ${method} for this endpoint`);
  return false;
}

async function handleDetectionModels(req, res) {
  if (!ensureApiMethod(req, res, "GET")) return;
  res.setHeader("Cache-Control", "public, max-age=300");
  sendJson(res, 200, {
    ok: true,
    api_version: "v1",
    engine_version: DETECTION_API_VERSION,
    custom_models_supported: true,
    protocols: DETECTION_PROTOCOLS,
    items: DETECTION_MODELS.map((model) => {
      const protocol = model.capability === "image"
        ? "openai-images"
        : model.provider === "Anthropic"
          ? "anthropic"
          : model.provider === "Google"
            ? "google-generative"
            : "openai-chat";
      const profile = resolveDetectionProfile(model.id);
      return {
        ...model,
        aliases: model.aliases ?? [],
        profile_model: model.id,
        probe_family: detectionProbeFamily({
          profileModel: profile.profileModelId || model.id,
          family: modelFamily(profile.profileModelId || model.id, protocol),
        }),
      };
    }),
  });
}

async function handleOpenApiDocument(req, res) {
  if (!ensureApiMethod(req, res, "GET")) return;
  res.setHeader("Cache-Control", "public, max-age=300");
  sendJson(res, 200, createOpenApiDocument(requestPublicBaseUrl(req)));
}

export function parseMultipartDetectionRequest(fields, records) {
  const raw = fields.request || fields.metadata || "{}";
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  const hasSuppliedSpecs = Object.prototype.hasOwnProperty.call(body, "attachments");
  if (hasSuppliedSpecs && !Array.isArray(body.attachments)) {
    const error = new Error("invalid_attachments");
    error.code = "invalid_attachments";
    throw error;
  }
  const suppliedSpecs = hasSuppliedSpecs ? body.attachments : [];
  if (hasSuppliedSpecs && suppliedSpecs.length !== records.length) {
    const error = new Error("attachment_count_mismatch");
    error.code = "attachment_count_mismatch";
    throw error;
  }
  const attachments = records.map((record, index) => {
    const spec = suppliedSpecs[index];
    if (hasSuppliedSpecs && (!spec || typeof spec !== "object" || Array.isArray(spec))) return spec;
    return {
      ...(spec || {}),
      id: record.id,
    };
  });
  return { ...body, attachments };
}

function cleanupUploadedRecords(records, ownerScope) {
  if (!Array.isArray(records) || records.length === 0) return;
  try {
    appStorage().deleteAttachments(records.map((record) => record.id), ownerScope, { requireUnreferenced: false });
  } catch (error) {
    appendLog("attachment_cleanup_error", { error: error?.message || "attachment_cleanup_failed" });
  }
}

async function handleMultipartDetectionApi(req, res, authorization) {
  req.setTimeout(0);
  const lifecycle = createClientDisconnectController(req, res);
  let records = [];
  try {
    const uploaded = await receiveAttachmentUploadWithFields(req, {
      storage: appStorage(),
      ownerScope: authorization.ownerScope,
      signal: lifecycle.signal,
    });
    records = uploaded.records;
    const request = parseMultipartDetectionRequest(uploaded.fields, records);
    const validation = validateDetectionRequest(request);
    if (!validation.ok) {
      cleanupUploadedRecords(records, authorization.ownerScope);
      sendApiError(res, 400, "validation_failed", "One or more request fields are invalid", validation.errors);
      return;
    }
    if (activeDetections >= detectionMaxConcurrency) {
      cleanupUploadedRecords(records, authorization.ownerScope);
      res.setHeader("Retry-After", "2");
      sendApiError(res, 429, "detection_concurrency_limited", "The detector is busy; retry shortly", {
        active: activeDetections,
        limit: detectionMaxConcurrency,
      });
      return;
    }

    activeDetections += 1;
    const privateTargetsAllowed = allowPrivateUpstreams && isDirectLoopbackRequest(req);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie, Authorization");
    try {
      const executed = await executePersistedDetection(validation.value, {
        source: "api",
        ownerScope: authorization.ownerScope,
        signal: lifecycle.signal,
        allowPrivateUpstream: privateTargetsAllowed,
      });
      res.kangkangRunId = executed.runId;
      if (!lifecycle.signal.aborted && !res.destroyed) sendJson(res, 200, executed.report);
    } catch (error) {
      if (lifecycle.signal.aborted || res.destroyed) return;
      appendLog("detection_api_error", {
        route: "/api/v1/detections",
        model: validation.value.model,
        endpoint: redactEndpointForLog(validation.value.baseUrl),
        error: error instanceof Error
          ? maskCredentialPatterns(error.message, [validation.value.upstreamApiKey])
          : "detection_failed",
      });
      sendApiError(res, 500, "detection_failed", "The detection engine could not complete this request");
    } finally {
      lifecycle.cleanup();
      activeDetections -= 1;
    }
  } catch (error) {
    cleanupUploadedRecords(records, authorization.ownerScope);
    if (lifecycle.signal.aborted || res.destroyed) return;
    const code = error?.code || error?.message || "attachment_upload_failed";
    sendApiError(res, code === "invalid_json" || code === "invalid_request" ? 400 : 400, code, "Unable to process the multipart detection request");
  } finally {
    lifecycle.cleanup();
  }
}

async function handleDetectionApi(req, res) {
  if (!ensureApiMethod(req, res, "POST")) return;
  const authorization = webDataAuthorization(req, res);
  if (!authorization.allowed) {
    if (authorization.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="kangkang-detection-api"');
    sendApiError(
      res,
      authorization.status,
      authorization.code,
      authorization.status === 503
        ? "Configure DETECTOR_API_KEYS or call through a trusted Web session"
        : "Provide a valid detector API key or verified Web session",
    );
    return;
  }

  if (/^multipart\/form-data\s*;/i.test(String(req.headers["content-type"] || ""))) {
    await handleMultipartDetectionApi(req, res, authorization);
    return;
  }

  if (!isJsonRequest(req)) {
    res.setHeader("Accept-Post", "application/json");
    sendApiError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
    return;
  }

  let raw;
  try {
    raw = await readRequestBody(req, maxRequestBodyBytes);
  } catch (error) {
    sendApiError(
      res,
      error?.code === "request_body_too_large" ? 413 : 400,
      error?.code === "request_body_too_large" ? "request_body_too_large" : "request_body_failed",
      error?.code === "request_body_too_large" ? "Detection request metadata exceeds the configured request limit" : "Unable to read the request body",
    );
    return;
  }

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    sendApiError(res, 400, "invalid_json", "Request body must be valid JSON");
    return;
  }
  const validation = validateDetectionRequest(body);
  if (!validation.ok) {
    sendApiError(res, 400, "validation_failed", "One or more request fields are invalid", validation.errors);
    return;
  }
  const missingAttachments = validation.value.attachments.filter(
    (attachment) => !appStorage().getAttachment(attachment.id, authorization.ownerScope),
  );
  if (missingAttachments.length > 0) {
    sendApiError(res, 404, "attachment_not_found", "One or more attachments do not belong to this API session");
    return;
  }
  if (activeDetections >= detectionMaxConcurrency) {
    res.setHeader("Retry-After", "2");
    sendApiError(res, 429, "detection_concurrency_limited", "The detector is busy; retry shortly", {
      active: activeDetections,
      limit: detectionMaxConcurrency,
    });
    return;
  }

  activeDetections += 1;
  const lifecycle = createClientDisconnectController(req, res);
  const privateTargetsAllowed = allowPrivateUpstreams && isDirectLoopbackRequest(req);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Cookie, Authorization");
  try {
    const executed = await executePersistedDetection(validation.value, {
      source: "api",
      ownerScope: authorization.ownerScope,
      signal: lifecycle.signal,
      allowPrivateUpstream: privateTargetsAllowed,
    });
    res.kangkangRunId = executed.runId;
    if (!lifecycle.signal.aborted && !res.destroyed) sendJson(res, 200, executed.report);
  } catch (error) {
    if (lifecycle.signal.aborted || res.destroyed) return;
    appendLog("detection_api_error", {
      route: "/api/v1/detections",
      model: validation.value.model,
      endpoint: redactEndpointForLog(validation.value.baseUrl),
      error: error instanceof Error
        ? maskCredentialPatterns(error.message, [validation.value.upstreamApiKey])
        : "detection_failed",
    });
    sendApiError(res, 500, "detection_failed", "The detection engine could not complete this request");
  } finally {
    lifecycle.cleanup();
    activeDetections -= 1;
  }
}

function apiAuthenticationMode() {
  const webSessionEnabled = Boolean(trustedWebProxyToken || turnstileSecret || allowLanWebWithoutTurnstile);
  if (detectorApiKeys.length > 0 && webSessionEnabled) return "bearer-or-web-session";
  if (detectorApiKeys.length > 0) return "bearer";
  if (webSessionEnabled) return "web-session-or-localhost";
  return "localhost-only";
}

async function handleApiIndex(req, res) {
  if (!ensureApiMethod(req, res, "GET")) return;
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, {
    ok: true,
    name: "kk 模型检测 API",
    api_version: "v1",
    engine_version: DETECTION_API_VERSION,
    endpoints: {
      detections: "/api/v1/detections",
      attachments: "/api/v1/attachments",
      attachment_delete: "/api/v1/attachments/{id}",
      installation_report: "/api/v1/installations/report",
      installation_stats: "/api/v1/installations/stats",
      installation_stream: "/api/v1/installations/stream",
      models: "/api/v1/models",
      openapi: "/api/v1/openapi.json",
      health: "/api/v1/health",
      documentation: "/api-docs",
    },
    authentication: apiAuthenticationMode(),
  });
}

async function handleHealth(req, res) {
  if (!ensureApiMethod(req, res, "GET")) return;
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, {
    ok: true,
    status: "ok",
    api_version: "v1",
    engine_version: DETECTION_API_VERSION,
    uptime_seconds: Math.round(process.uptime()),
    active_detections: activeDetections,
    authentication: apiAuthenticationMode(),
  });
}

export function isPathInsideDirectory(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function resolveStaticFile(urlPath) {
  try {
    const pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
    if (pathname.includes("\0") || pathname.includes("\\")) return null;
    if (pathname.split("/").some((segment) => segment === "..")) return null;
    const normalized = path.posix.normalize(pathname).replace(/^\/+/, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
      return path.join(distDir, "index.html");
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => segment.startsWith(".")) || normalized.toLowerCase().endsWith(".map")) {
      return null;
    }
    const candidate = path.resolve(distDir, normalized);
    return isPathInsideDirectory(distDir, candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveExistingFileWithinDirectory(root, candidate) {
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(candidate);
    if (!isPathInsideDirectory(realRoot, realFile) || realFile === realRoot) return null;
    const stat = fs.statSync(realFile);
    return stat.isFile() ? { filePath: realFile, stat } : null;
  } catch {
    return null;
  }
}

function resolveExistingStaticFile(candidate) {
  return resolveExistingFileWithinDirectory(distDir, candidate);
}

function shouldServeIndex(urlPath) {
  try {
    const pathname = new URL(urlPath, "http://localhost").pathname;
    return !path.extname(pathname);
  } catch {
    return false;
  }
}

function serveFile(req, res, staticFile) {
  try {
    const { filePath, stat } = staticFile;
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (ext === ".html") {
      res.setHeader("Cache-Control", "no-cache");
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 404;
        res.end("Not found");
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

function serveUploadedAttachment(req, res, urlPath) {
  const prefix = "/upload/";
  if (!urlPath.startsWith(prefix)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method not allowed");
    return true;
  }
  let name;
  try {
    name = decodeURIComponent(urlPath.slice(prefix.length));
  } catch {
    res.statusCode = 400;
    res.end("Invalid attachment path");
    return true;
  }
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    res.statusCode = 404;
    res.end("Not found");
    return true;
  }
  const record = appStorage().getLatestAttachmentByName(name);
  const candidate = path.join(appStorage().uploadDirectory, name);
  const existing = resolveExistingFileWithinDirectory(appStorage().uploadDirectory, candidate);
  if (!record || !existing) {
    res.statusCode = 404;
    res.end("Not found");
    return true;
  }
  const ext = path.extname(name).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypes[ext] || record.media_type || "application/octet-stream");
  res.setHeader("Content-Length", String(existing.stat.size));
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(existing.filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 404;
      res.end("Not found");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
  return true;
}

async function handleServerRequest(req, res) {
  applySecurityHeaders(res);
  const urlPath = req.url || "/";
  let pathname;
  try {
    pathname = new URL(urlPath, "http://localhost").pathname;
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  if (pathname.startsWith("/upload/")) {
    serveUploadedAttachment(req, res, pathname);
    return;
  }

  if (
    pathname === "/api/v1/detections" ||
    pathname === "/api/v1/attachments" ||
    /^\/api\/v1\/attachments\/[^/]+$/.test(pathname)
  ) {
    const auditStarted = Date.now();
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const detectorToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    res.once("finish", () => {
      try {
        appStorage().recordApiRequest({
          runId: res.kangkangRunId || null,
          route: pathname,
          method: req.method || "GET",
          statusCode: res.statusCode,
          errorCode: res.kangkangErrorCode || null,
          durationMs: Date.now() - auditStarted,
          detectorKeyFingerprint: detectorToken ? credentialFingerprint(detectorToken) : null,
        });
      } catch (error) {
        appendLog("api_audit_error", { route: pathname, error: error?.message || "audit_failed" });
      }
    });
  }

  if (pathname === "/api/v1") {
    await handleApiIndex(req, res);
    return;
  }

  if (pathname === "/api/v1/health") {
    await handleHealth(req, res);
    return;
  }

  if (pathname === "/api/v1/models") {
    await handleDetectionModels(req, res);
    return;
  }

  if (pathname === "/api/v1/openapi.json") {
    await handleOpenApiDocument(req, res);
    return;
  }

  if (pathname === "/api/v1/detections") {
    await handleDetectionApi(req, res);
    return;
  }

  if (pathname === "/api/v1/attachments") {
    await handleAttachmentUpload(req, res);
    return;
  }

  const attachmentDeleteMatch = pathname.match(/^\/api\/v1\/attachments\/([^/]+)$/);
  if (attachmentDeleteMatch) {
    let attachmentId;
    try {
      attachmentId = decodeURIComponent(attachmentDeleteMatch[1]);
    } catch {
      sendApiError(res, 400, "invalid_attachment_id", "Attachment ID is invalid");
      return;
    }
    await handleAttachmentDelete(req, res, attachmentId);
    return;
  }

  if (pathname === "/api/v1/web/attachment-analysis") {
    await handleWebAttachmentAnalysis(req, res);
    return;
  }

  if (pathname === "/api/v1/web/history") {
    await handleWebHistory(req, res);
    return;
  }

  const historyRetestMatch = pathname.match(/^\/api\/v1\/web\/history\/([^/]+)\/retry$/);
  if (historyRetestMatch) {
    await handleWebHistoryRetest(req, res, decodeURIComponent(historyRetestMatch[1]));
    return;
  }

  if ([
    "/api/v1/installations/report",
    "/api/v1/installations/stats",
    "/api/v1/installations/stream",
  ].includes(pathname)) {
    await proxyInstallTracker(req, res, pathname);
    return;
  }

  if (pathname === "/__turnstile/verify") {
    await handleTurnstileVerify(req, res);
    return;
  }

  if (pathname === "/__live-knowledge") {
    await handleLiveKnowledge(req, res);
    return;
  }

  if (pathname === "/__probe") {
    await handleProbe(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  let filePath = resolveStaticFile(urlPath);
  if (!filePath) {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }
  let staticFile = resolveExistingStaticFile(filePath);
  if (!staticFile) {
    if (shouldServeIndex(urlPath)) {
      filePath = path.join(distDir, "index.html");
      staticFile = resolveExistingStaticFile(filePath);
    } else {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
  }
  if (!staticFile) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  serveFile(req, res, staticFile);
}

const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
  void handleServerRequest(req, res).catch((error) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname.slice(0, 500);
    } catch {
      pathname = "[invalid-path]";
    }
    appendLog("request_handler_error", {
      route: pathname,
      error: typeof error?.code === "string" ? error.code : error?.name || "request_failed",
    });
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    applySecurityHeaders(res);
    if (pathname.startsWith("/api/") || pathname.startsWith("/__")) {
      sendJson(res, 500, { ok: false, error: "internal_server_error" });
    } else {
      res.statusCode = 500;
      res.end("Internal server error");
    }
  });
});

server.requestTimeout = inboundRequestTimeoutMs;
server.headersTimeout = Math.min(server.requestTimeout, 15_000);
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 100;
server.maxConnections = serverMaxConnections;

function pruneExpiredAttachments() {
  try {
    return appStorage().pruneUnreferencedAttachments({
      olderThan: new Date(Date.now() - attachmentOrphanRetentionMs),
    });
  } catch (error) {
    appendLog("attachment_prune_error", { error: error?.message || "attachment_prune_failed" });
    return 0;
  }
}

const invokedDirectly = (() => {
  if (process.env.KANGKANG_WEB_MAIN === "true") return true;
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
})();
if (invokedDirectly) {
  hardenExistingLogFiles();
  pruneExpiredAttachments();
  const attachmentPruneTimer = setInterval(pruneExpiredAttachments, 60 * 60 * 1000);
  attachmentPruneTimer.unref();
  server.listen(port, host, () => {
    console.log(`kk 模型检测服务已启动: http://${host}:${port}`);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(attachmentPruneTimer);
    server.close(() => {
      appStorageInstance?.close();
      appStorageInstance = null;
      webSessionSecret = null;
      process.exitCode = 0;
    });
    server.closeIdleConnections?.();
    const forceClose = setTimeout(() => {
      server.closeAllConnections?.();
      process.exitCode = 0;
    }, 10_000);
    forceClose.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
