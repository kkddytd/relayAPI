import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_ROUND_DELAY_MS,
  DEFAULT_CACHE_REQUEST_TIMEOUT_MS,
  DEFAULT_DETECTION_PHASE_DELAY_MS,
  parseRetryAfter,
  responseRetryAfterMs,
  retryDelayMs,
} from "./request-pacing.mjs";

describe("request pacing", () => {
  it("parses Retry-After seconds and HTTP dates with a 120 second cap", () => {
    const now = Date.parse("2026-07-22T00:00:00Z");
    expect(parseRetryAfter("12", now)).toBe(12_000);
    expect(parseRetryAfter("Wed, 22 Jul 2026 00:00:45 GMT", now)).toBe(45_000);
    expect(parseRetryAfter("999", now)).toBe(120_000);
    expect(parseRetryAfter("invalid", now)).toBe(0);
  });

  it("uses Retry-After only for rate limiting and temporary unavailability", () => {
    const headers = new Headers({ "Retry-After": "7" });
    expect(responseRetryAfterMs(429, headers)).toBe(7_000);
    expect(responseRetryAfterMs(503, headers)).toBe(7_000);
    expect(responseRetryAfterMs(500, headers)).toBe(0);
  });

  it("falls back to the shared phase delay when Retry-After is absent", () => {
    expect(DEFAULT_CACHE_ROUND_DELAY_MS).toBe(3_000);
    expect(DEFAULT_CACHE_REQUEST_TIMEOUT_MS).toBe(45_000);
    expect(DEFAULT_DETECTION_PHASE_DELAY_MS).toBe(3_000);
    expect(retryDelayMs(429, {})).toBe(3_000);
    expect(retryDelayMs(503, { "retry-after": "0" })).toBe(3_000);
    expect(retryDelayMs(500, {})).toBe(0);
  });
});
