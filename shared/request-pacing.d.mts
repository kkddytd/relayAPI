export const DEFAULT_RETRY_AFTER_MAX_MS: number;
export const DEFAULT_DETECTION_PHASE_DELAY_MS: number;
export const DEFAULT_CACHE_ROUND_DELAY_MS: number;
export const DEFAULT_CACHE_REQUEST_TIMEOUT_MS: number;
export function headerValue(headers: unknown, name: unknown): string | null;
export function parseRetryAfter(value: unknown, now?: number, maxDelayMs?: number): number;
export function responseRetryAfterMs(
  status: number,
  headers: unknown,
  options?: { now?: number; maxDelayMs?: number },
): number;
export function retryDelayMs(
  status: number,
  headers: unknown,
  options?: { now?: number; maxDelayMs?: number; fallbackMs?: number },
): number;
