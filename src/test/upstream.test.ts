import { describe, expect, it } from "vitest";
import {
  classifyUpstreamFailure,
  isUpstreamUnavailable,
  summarizeUpstreamAvailability,
} from "@/lib/upstream";

describe("upstream availability classification", () => {
  it("recognizes relay channel shutdowns as rate limiting", () => {
    expect(classifyUpstreamFailure(429, "Too many requests")).toBe("rate-limited");
    expect(classifyUpstreamFailure(400, "channel_all_disabled")).toBe("rate-limited");
    expect(isUpstreamUnavailable(429, "channel_all_disabled")).toBe(true);
  });

  it("separates service errors from invalid request templates", () => {
    expect(classifyUpstreamFailure(503, "service unavailable")).toBe("service-error");
    expect(classifyUpstreamFailure(401, "invalid api key")).toBe("authentication-error");
    expect(isUpstreamUnavailable(403, "permission denied")).toBe(true);
    expect(classifyUpstreamFailure(400, "invalid request body")).toBe("invalid-response");
    expect(isUpstreamUnavailable(400, "invalid request body")).toBe(false);
  });

  it("marks an all-rate-limited probe suite unavailable instead of failed", () => {
    const summary = summarizeUpstreamAvailability([
      { upstreamStatus: 429, errorMessage: "channel_all_disabled", parseOk: false },
      { upstreamStatus: 429, errorMessage: "Too many requests", parseOk: false },
    ]);
    expect(summary).toMatchObject({ kind: "rate-limited", allUnavailable: true, hasUnavailable: true, statusCodes: [429] });
  });

  it("keeps a partially successful suite usable", () => {
    const summary = summarizeUpstreamAvailability([
      { upstreamStatus: 200, errorMessage: null, parseOk: true },
      { upstreamStatus: 429, errorMessage: "Too many requests", parseOk: false },
    ]);
    expect(summary).toMatchObject({ kind: "available", failureKind: "rate-limited", allUnavailable: false, hasUnavailable: true });
  });

  it("does not score a suite with only invalid or unparseable responses", () => {
    expect(summarizeUpstreamAvailability([
      { upstreamStatus: 200, errorMessage: "provider error", parseOk: false },
      { upstreamStatus: 400, errorMessage: "invalid request", parseOk: false },
    ])).toMatchObject({
      kind: "invalid-response",
      failureKind: "invalid-response",
      allUnavailable: true,
      hasUnavailable: true,
    });
  });
});
