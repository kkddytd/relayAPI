export type UpstreamAvailabilityKind =
  | "available"
  | "rate-limited"
  | "authentication-error"
  | "service-error"
  | "network-error"
  | "invalid-response"
  | "unknown";

export interface UpstreamAvailabilitySummary {
  kind: UpstreamAvailabilityKind;
  failureKind: UpstreamAvailabilityKind | null;
  allUnavailable: boolean;
  hasUnavailable: boolean;
  statusCodes: number[];
  messages: string[];
}

const RATE_LIMIT_PATTERNS = [
  /channel[_ -]?all[_ -]?disabled/i,
  /too many requests/i,
  /rate[_ -]?limit/i,
  /rate limit/i,
  /throttl/i,
  /overloaded/i,
];

const SERVICE_ERROR_PATTERNS = [
  /service unavailable/i,
  /temporarily unavailable/i,
  /upstream unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /connection (?:reset|closed|refused)/i,
  /econn(?:reset|refused)/i,
  /fetch failed/i,
  /network error/i,
  /timed? ?out/i,
];

function compactMessage(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function classifyUpstreamFailure(
  statusCode: number | null | undefined,
  errorMessage: string | null | undefined,
): UpstreamAvailabilityKind {
  const status = typeof statusCode === "number" && Number.isFinite(statusCode) ? statusCode : 0;
  const message = typeof errorMessage === "string" ? errorMessage : "";

  if (status === 429 || RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "rate-limited";
  }
  if (status === 401 || status === 403) {
    return "authentication-error";
  }
  if (status >= 500 || SERVICE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return "service-error";
  }
  if (status === 0 && message) {
    return "network-error";
  }
  if (status >= 200 && status < 300) {
    return "available";
  }
  if (status >= 400) {
    return "invalid-response";
  }
  return "unknown";
}

export function isUpstreamUnavailable(
  statusCode: number | null | undefined,
  errorMessage: string | null | undefined,
): boolean {
  const kind = classifyUpstreamFailure(statusCode, errorMessage);
  return kind === "rate-limited" || kind === "authentication-error" || kind === "service-error" || kind === "network-error";
}

export function summarizeUpstreamAvailability(
  probes: readonly { upstreamStatus: number; errorMessage: string | null; parseOk: boolean; evidenceUsable?: boolean }[],
): UpstreamAvailabilitySummary {
  const statusCodes = [...new Set(probes
    .map((probe) => probe.upstreamStatus)
    .filter((status): status is number => Number.isFinite(status) && status > 0))];
  const messages = [...new Set(probes
    .map((probe) => typeof probe.errorMessage === "string" ? compactMessage(probe.errorMessage) : "")
    .filter(Boolean))];
  const unavailable = probes.filter((probe) => isUpstreamUnavailable(probe.upstreamStatus, probe.errorMessage));
  // A 2xx status alone is not a usable model response. Relays commonly return
  // a JSON error envelope with HTTP 200, and malformed/empty 2xx bodies are
  // equally incapable of providing identity or quality evidence.
  const available = probes.filter((probe) => probe.upstreamStatus >= 200 && probe.upstreamStatus < 300 &&
    (probe.evidenceUsable ?? probe.parseOk));
  const unusable = probes.filter((probe) => !available.includes(probe));
  const failureKinds = probes.map((probe) => classifyUpstreamFailure(probe.upstreamStatus, probe.errorMessage));
  const failureKind = failureKinds.includes("rate-limited")
    ? "rate-limited"
    : failureKinds.includes("authentication-error")
      ? "authentication-error"
      : failureKinds.includes("service-error")
        ? "service-error"
        : failureKinds.includes("network-error")
          ? "network-error"
        : failureKinds.includes("invalid-response") || failureKinds.includes("unknown") || unusable.length > 0
          ? "invalid-response"
          : null;

  if (probes.length > 0 && available.length === 0) {
    // No successful, parseable response means there is no evidence to score.
    // This includes 4xx validation errors and 2xx error envelopes, but keeps
    // the original rate-limit/service/network classification when available.
    return {
      kind: failureKind ?? "invalid-response",
      failureKind,
      allUnavailable: true,
      hasUnavailable: true,
      statusCodes,
      messages,
    };
  }

  if (available.length > 0) {
    // Keep expected/isolated validation failures (for example a Gemini
    // thinking-level variant that the provider does not implement) separate
    // from a hard outage. A valid response still supplies usable evidence;
    // only rate-limit/service/network failures make the run partially
    // unavailable.
    return { kind: "available", failureKind, allUnavailable: false, hasUnavailable: unavailable.length > 0, statusCodes, messages };
  }
  return { kind: "invalid-response", failureKind, allUnavailable: true, hasUnavailable: true, statusCodes, messages };
}
