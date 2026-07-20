function headerKey(headers, expectedName) {
  return Object.keys(headers ?? {}).find((name) => name.toLowerCase() === expectedName.toLowerCase()) ?? null;
}

export function nextAnthropicCompatibilityRetry({
  status,
  responseBody,
  headers,
  body,
  applied = [],
  allowCompatibilityRetry = false,
}) {
  // Scoring requests must preserve the first upstream response. Removing a
  // rejected header changes the request fingerprint and can turn an official
  // verifier failure into a local success, so this fallback is operational
  // and explicitly opt-in only.
  if (!allowCompatibilityRetry) return null;
  if (status !== 400 || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const detail = String(responseBody ?? "");
  const appliedSet = new Set(applied);
  const betaHeader = headerKey(headers, "anthropic-beta");

  if (
    betaHeader &&
    !appliedSet.has("removed-anthropic-beta") &&
    /invalid beta flag|(?:anthropic[-_\s]?beta|beta flag).*(?:invalid|unsupported|not permitted)/i.test(detail)
  ) {
    const nextHeaders = { ...headers };
    delete nextHeaders[betaHeader];
    return { headers: nextHeaders, body, reason: "removed-anthropic-beta" };
  }

  return null;
}
