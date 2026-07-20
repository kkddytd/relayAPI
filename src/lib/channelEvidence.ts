import type { EndpointMode } from "@/lib/probeProtocol";

export type ChannelKind =
  | "anthropic-direct"
  | "openai-direct"
  | "google-ai-studio"
  | "aws-bedrock"
  | "google-vertex"
  | "google-unknown"
  | "vertex-or-bedrock-proxy"
  | "kiro-like"
  | "relay-or-unknown";

export type ChannelConfidence = "high" | "medium" | "low" | "none";

export interface ChannelEvidence {
  kind: ChannelKind;
  confidence: ChannelConfidence;
  signals: string[];
  direct: boolean;
  requestedHost: string | null;
  finalHosts: string[];
  observedStatusCodes: number[];
}

export interface ChannelEvidenceInput {
  requestedUrl: string;
  mode: EndpointMode;
  finalUrls: readonly (string | null)[];
  statuses: readonly number[];
  /** Whether each response matched the selected protocol shape. */
  parseOk?: readonly boolean[];
  responseHeaders: readonly Record<string, string>[];
  payloads: readonly unknown[];
  messageIds?: readonly (string | null)[];
  signatureChannelMarkers?: readonly ({
    present: boolean;
    value: number | null;
    structurallyParsed: boolean;
  } | null)[];
}

function normalizeUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

function isBedrockHost(hostname: string): boolean {
  return /(^|\.)(?:bedrock-runtime|bedrock-runtime-fips|bedrock-agent-runtime)(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/i.test(hostname);
}

function isVertexHost(hostname: string): boolean {
  return /(^|\.)(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/i.test(hostname);
}

function hasHeader(headers: Record<string, string>, predicate: (name: string) => boolean): boolean {
  return Object.keys(headers).some((name) => predicate(name.toLowerCase()));
}

function hasBedrockPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  const output = value.output;
  const usage = value.usage;
  return Boolean(
    output && typeof output === "object" &&
      ("message" in (output as Record<string, unknown>) || "content" in (output as Record<string, unknown>)) &&
    typeof value.stopReason === "string" &&
    usage && typeof usage === "object" &&
    (typeof (usage as Record<string, unknown>).inputTokens === "number" ||
      typeof (usage as Record<string, unknown>).outputTokens === "number"),
  );
}

function hasVertexPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  const candidates = value.candidates;
  const usage = value.usageMetadata;
  return Array.isArray(candidates) && candidates.length > 0 &&
    candidates[0] && typeof candidates[0] === "object" &&
    typeof (candidates[0] as Record<string, unknown>).finishReason === "string" &&
    usage && typeof usage === "object" &&
    typeof (usage as Record<string, unknown>).promptTokenCount === "number";
}

function isAmazonQHost(hostname: string): boolean {
  return /(^|\.)(?:q|qdeveloper|qbusiness)\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/i.test(hostname);
}

function directHostKind(hostname: string): ChannelKind | null {
  if (isBedrockHost(hostname)) return "aws-bedrock";
  if (isVertexHost(hostname)) return "google-vertex";
  if (hostname === "api.anthropic.com") return "anthropic-direct";
  if (hostname === "api.openai.com") return "openai-direct";
  if (hostname === "generativelanguage.googleapis.com") return "google-ai-studio";
  return null;
}

export function detectChannelEvidence(input: ChannelEvidenceInput): ChannelEvidence {
  const requested = normalizeUrl(input.requestedUrl);
  const finals = input.finalUrls.map((value) => value ? normalizeUrl(value) : null).filter((value): value is URL => Boolean(value));
  const urls = [requested, ...finals].filter((value): value is URL => Boolean(value));
  const directKinds = urls.map((url) => directHostKind(url.hostname)).filter((kind): kind is ChannelKind => Boolean(kind));
  const finalDirectKinds = finals.map((url) => directHostKind(url.hostname)).filter((kind): kind is ChannelKind => Boolean(kind));
  const headers = input.responseHeaders;
  const hasBedrockHeaders = headers.some((value) => hasHeader(value, (name) => name.startsWith("x-amzn-bedrock-")));
  const hasGoogleHeaders = headers.some((value) => hasHeader(value, (name) => name.startsWith("x-goog-") || name === "x-cloud-trace-context"));
  const hasKiroMarker = urls.some((url) =>
    /(?:^|[.-])(?:kiro|codewhisperer|amazonq|qdeveloper|qbusiness)(?:[.-]|$)/i.test(url.hostname) ||
    isAmazonQHost(url.hostname) ||
    /(?:kiro|codewhisperer|amazonq|generateassistantresponse)/i.test(url.pathname),
  );
  const hasBedrockBody = input.payloads.some(hasBedrockPayload);
  const hasBedrockMessageId = input.messageIds?.some((value) => typeof value === "string" && /^msg_bdrk_/i.test(value)) ?? false;
  const hasVertexBody = input.payloads.some(hasVertexPayload);
  const hasClaudeCloudProxyMarker = input.signatureChannelMarkers?.some((marker) =>
    marker?.structurallyParsed === true && marker.present && marker.value === 1,
  ) ?? false;
  const cloudProxySignal = "Claude protobuf channel=1; structurally consistent with a Vertex/Bedrock-style proxy, but not source proof";
  const hasSuccessfulResponse = input.statuses.some((status, index) =>
    status >= 200 && status < 300 && (input.parseOk?.[index] ?? true),
  );
  const allSuccessfulResponses = input.statuses.length > 0 && input.statuses.every((status, index) =>
    status >= 200 && status < 300 && (input.parseOk?.[index] ?? true),
  );
  const context = {
    requestedHost: requested?.hostname ?? null,
    finalHosts: [...new Set(finals.map((url) => url.hostname))],
    observedStatusCodes: [...input.statuses],
  };

  const distinctFinalDirectKinds = [...new Set(finalDirectKinds)];
  const hasNonDirectFinal = finals.some((url) => !directHostKind(url.hostname));
  if (distinctFinalDirectKinds.length === 1 && !hasNonDirectFinal) {
    const kind = distinctFinalDirectKinds[0];
    const requestedKind = requested ? directHostKind(requested.hostname) : null;
    const finalMatchesRequested = Boolean(
      requested && finals.length > 0 && finals.every((url) => url.hostname === requested.hostname),
    );
    const direct = requestedKind === kind && finalMatchesRequested && allSuccessfulResponses && !hasClaudeCloudProxyMarker;
    return {
      ...context,
      kind,
      confidence: direct || (requestedKind === kind && finalMatchesRequested)
        ? direct ? "high" : "medium"
        : allSuccessfulResponses ? "medium" : "low",
      direct,
      signals: [
        direct
          ? `final upstream host matches ${kind}`
          : `final upstream host exposes ${kind} transport, but the requested relay path is not a direct provider proof`,
        ...(hasClaudeCloudProxyMarker ? [cloudProxySignal] : []),
      ],
    };
  }

  if (distinctFinalDirectKinds.length > 0 && (distinctFinalDirectKinds.length > 1 || hasNonDirectFinal)) {
    return {
      ...context,
      kind: "relay-or-unknown",
      confidence: "none",
      direct: false,
      signals: [
        "probe rounds ended on mixed or non-official hosts; channel cannot be confirmed",
        ...(hasClaudeCloudProxyMarker ? [cloudProxySignal] : []),
      ],
    };
  }

  if (directKinds.length > 0 && finals.length === 0) {
    const kind = directKinds[0];
    const successful = input.statuses.some((status) => status >= 200 && status < 300);
    return {
      ...context,
      kind,
      confidence: successful ? hasClaudeCloudProxyMarker ? "medium" : "high" : "medium",
      direct: successful && !hasClaudeCloudProxyMarker,
      signals: [
        successful ? `requested host matches ${kind}` : `requested host matches ${kind}, but no successful upstream response confirmed it`,
        ...(hasClaudeCloudProxyMarker ? [cloudProxySignal] : []),
      ],
    };
  }

  if (hasKiroMarker) {
    return {
      ...context,
      kind: "kiro-like",
      confidence: "low",
      direct: false,
      signals: [
        "endpoint contains a Kiro/Amazon agent marker; this is not provider proof",
        ...(hasClaudeCloudProxyMarker ? [cloudProxySignal] : []),
      ],
    };
  }

  if (hasBedrockHeaders || hasBedrockBody || hasBedrockMessageId) {
    return {
      ...context,
      kind: "aws-bedrock",
      confidence: hasBedrockHeaders || hasBedrockBody ? "medium" : "low",
      direct: false,
      signals: [
        ...(hasBedrockHeaders ? ["AWS/Bedrock response header marker"] : []),
        ...(hasBedrockBody ? ["native Bedrock response fields"] : []),
        ...(hasBedrockMessageId ? ["Bedrock-style msg_bdrk_ message ID prefix; this field is forgeable"] : []),
        ...(hasClaudeCloudProxyMarker ? [cloudProxySignal] : []),
      ],
    };
  }

  if (hasGoogleHeaders || hasVertexBody) {
    return {
      ...context,
      kind: "google-unknown",
      confidence: "low",
      direct: false,
      signals: [
        ...(hasGoogleHeaders ? ["Google response header marker"] : []),
        ...(hasVertexBody ? ["native Google generative response fields"] : []),
        "Vertex versus AI Studio is unresolved without a verifiable upstream host",
        ...(hasClaudeCloudProxyMarker ? [cloudProxySignal] : []),
      ],
    };
  }

  if (hasClaudeCloudProxyMarker) {
    return {
      ...context,
      kind: "vertex-or-bedrock-proxy",
      confidence: "low",
      direct: false,
      signals: [cloudProxySignal],
    };
  }

  return {
    ...context,
    kind: "relay-or-unknown",
    confidence: "none",
    direct: false,
    signals: [
      ...(requested && !directHostKind(requested.hostname)
        ? ["requested host is not an official provider hostname"]
        : []),
      input.mode === "anthropic"
        ? "standard Anthropic-compatible response does not reveal the hidden upstream channel"
        : "custom or relay endpoint does not expose a verifiable channel marker",
    ],
  };
}
