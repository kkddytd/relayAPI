export const DEFAULT_RETRY_AFTER_MAX_MS = 120_000;
export const DEFAULT_DETECTION_PHASE_DELAY_MS = 3_000;
export const DEFAULT_CACHE_ROUND_DELAY_MS = 3_000;
export const DEFAULT_CACHE_REQUEST_TIMEOUT_MS = 45_000;

export function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const expected = String(name ?? "").toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(expected);
    return typeof value === "string" ? value : null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && typeof value === "string") return value;
  }
  return null;
}

export function parseRetryAfter(value, now = Date.now(), maxDelayMs = DEFAULT_RETRY_AFTER_MAX_MS) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const maximum = Number.isFinite(maxDelayMs) ? Math.max(0, Math.trunc(maxDelayMs)) : DEFAULT_RETRY_AFTER_MAX_MS;
  const seconds = Number(value.trim());
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1000)
    : Math.max(0, Date.parse(value) - now);
  return Number.isFinite(delay) ? Math.min(maximum, Math.max(0, Math.trunc(delay))) : 0;
}

export function responseRetryAfterMs(status, headers, options = {}) {
  if (status !== 429 && status !== 503) return 0;
  return parseRetryAfter(
    headerValue(headers, "retry-after"),
    options.now ?? Date.now(),
    options.maxDelayMs ?? DEFAULT_RETRY_AFTER_MAX_MS,
  );
}

export function retryDelayMs(status, headers, options = {}) {
  if (status !== 429 && status !== 503) return 0;
  const parsed = responseRetryAfterMs(status, headers, options);
  if (parsed > 0) return parsed;
  const fallback = Number.isFinite(options.fallbackMs)
    ? Math.max(0, Math.trunc(options.fallbackMs))
    : DEFAULT_DETECTION_PHASE_DELAY_MS;
  const maximum = Number.isFinite(options.maxDelayMs)
    ? Math.max(0, Math.trunc(options.maxDelayMs))
    : DEFAULT_RETRY_AFTER_MAX_MS;
  return Math.min(fallback, maximum);
}
