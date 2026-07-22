export const OFFICIAL_SCORING_REFERENCE = Object.freeze({
  capturedAt: "2026-07-22",
  bundle: "shareReport-vS9UoxUO.js",
  bundleSha256: "32e3db32aa67543574ce9880093454a198d5f37359b91707d95ea41195696f8d",
  probeConstantsBundle: "probe-constants-DpbHYFO2.js",
  probeConstantsSha256: "d6f6bf9fa215d3de2c14d74b817f48ec2ac28cf124b07bef241643ea3e3bcfcd",
  reasoningBundle: "reasoningCheck-JktxwfVY.js",
  reasoningBundleSha256: "feef731234811199f4a7535d250e02994a77f084f803b5bbc95d2d49b15b9205",
  algorithmRegistryBundle: "detection-algorithm-registry-B4hNxm78.js",
  algorithmRegistryBundleSha256: "26788c314788bee39fd5c0ad1859a9d162771996466a67a6c1bb733cf0c08d67",
});

export const OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID =
  '{"device_id":"298863f3680a5437d5770973d49a9f941c9673bf21f1175468a0ba22be09cd24","account_uuid":"7b67e64a-c8c3-418b-b9ae-94fa744f1f9b","session_id":"bc811773-a80b-40ab-83c9-a721b83ae308"}';

export const OFFICIAL_CLAUDE_PROBE_HEADERS = Object.freeze({
  "x-claude-code-session-id": "a3d52921-8d7f-4a0e-bb90-55ec2e0fbd47",
  "x-stainless-arch": "arm64",
  "x-stainless-lang": "js",
  "x-stainless-os": "MacOS",
  "x-stainless-package-version": "0.81.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.3.0",
  "x-stainless-timeout": "600",
});

export const OFFICIAL_DEDICATED_MODELS = Object.freeze([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gemini-3.1-pro-preview",
]);

export const OFFICIAL_GPT_MODELS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
]);

/**
 * Public verifier pass thresholds are family-specific. Claude dedicated
 * profiles use 60; the dedicated GPT and Gemini profiles use 70.
 */
export function officialPassThreshold(profileModel) {
  const normalized = String(profileModel || "").trim().toLowerCase();
  return OFFICIAL_GPT_MODELS.includes(normalized) || normalized === "gemini-3.1-pro-preview" ? 70 : 60;
}

const OFFICIAL_SSE_EVENT_TYPES = new Set([
  "ping",
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);

const CLAUDE_COMPARABLE_FAMILIES = new Set([
  "opus-4-6",
  "sonnet-4-6",
  "sonnet-5",
  "opus-4-7",
  "opus-4-8",
  "fable-5",
  "unknown-claude-internal",
  "other-claude",
]);

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function statusWeight(status, weight) {
  if (status === "pass") return weight;
  if (status === "warning") return Math.round(weight * 0.5);
  return 0;
}

export function isOfficialClaudeMessageId(value) {
  return typeof value === "string" && /^msg_[A-Za-z0-9]{20,}$/.test(value);
}

export function classifyClaudeFamily(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.toLowerCase();
  const separator = "[\\s._/-]*";
  if (new RegExp(`fable${separator}5|5${separator}fable`).test(normalized)) return "fable-5";
  if (new RegExp(`opus${separator}4${separator}8|4${separator}8${separator}opus`).test(normalized)) return "opus-4-8";
  if (new RegExp(`opus${separator}4${separator}7|4${separator}7${separator}opus`).test(normalized)) return "opus-4-7";
  if (new RegExp(`opus${separator}4${separator}6|4${separator}6${separator}opus`).test(normalized)) return "opus-4-6";
  if (new RegExp(`sonnet${separator}4${separator}6|4${separator}6${separator}sonnet`).test(normalized)) return "sonnet-4-6";
  if (new RegExp(`sonnet${separator}5|5${separator}sonnet`).test(normalized)) return "sonnet-5";

  const tail = normalized.split(/[/:]/).filter(Boolean).pop() ?? normalized;
  if (/^claude-[a-z0-9][a-z0-9-]*$/.test(tail) &&
      !/^claude-\d/.test(tail) &&
      !/(?:^|-)(?:opus|sonnet|haiku)(?:-|$)/.test(tail)) {
    return "unknown-claude-internal";
  }
  if (/(?:^|[^a-z])(claude|opus|sonnet|haiku)/.test(normalized)) return "other-claude";
  return "non-claude";
}

export function expectedClaudeFamily(modelId) {
  const family = classifyClaudeFamily(modelId);
  return CLAUDE_COMPARABLE_FAMILIES.has(family) && family !== "unknown-claude-internal" && family !== "other-claude"
    ? family
    : null;
}

export function claudeSignaturePenalty({ verdict, sigModelName, expectedFamily }) {
  const normalizedVerdict = String(verdict || "").toUpperCase();
  const signatureFamily = classifyClaudeFamily(sigModelName);
  const unknownSignature = !signatureFamily || signatureFamily === "unknown-claude-internal";
  const matches = !unknownSignature && Boolean(expectedFamily) && signatureFamily === expectedFamily;

  if (normalizedVerdict === "PASS") return matches ? 0 : unknownSignature ? 2 : 16;
  if (normalizedVerdict === "PARTIAL") {
    return matches ? 1 : unknownSignature || signatureFamily === "unknown-claude-internal" ? 4 : 8;
  }
  if (["FAIL", "FORGED", "ERROR"].includes(normalizedVerdict)) return 16;
  return expectedFamily === "fable-5" && unknownSignature ? 6 : 10;
}

export function claudeUpstreamModelPenalty(upstreamModelId, expectedFamily) {
  const upstreamFamily = classifyClaudeFamily(upstreamModelId);
  if (!upstreamFamily) return 5;
  if (upstreamFamily === expectedFamily) return 0;
  return upstreamFamily === "non-claude" ? 14 : 10;
}

export function hasClaudeFamilyConflict({ expectedFamily, sigModelName, upstreamModelId, signatureVerdict }) {
  const signatureFamily = classifyClaudeFamily(sigModelName);
  const upstreamFamily = classifyClaudeFamily(upstreamModelId);
  if (signatureFamily === "unknown-claude-internal" &&
      upstreamFamily !== "non-claude") {
    return false;
  }
  return Boolean(
    (signatureFamily && upstreamFamily && CLAUDE_COMPARABLE_FAMILIES.has(signatureFamily) &&
      CLAUDE_COMPARABLE_FAMILIES.has(upstreamFamily) && signatureFamily !== upstreamFamily) ||
    (signatureFamily && CLAUDE_COMPARABLE_FAMILIES.has(signatureFamily) && upstreamFamily === "non-claude") ||
    (signatureFamily && CLAUDE_COMPARABLE_FAMILIES.has(signatureFamily) && expectedFamily && signatureFamily !== expectedFamily),
  );
}

export function claudeProtocolPenalty(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return 12;
  const hits = probes.flatMap((probe) => Object.values(probe.protocolHints || {})).filter(Boolean).length;
  const ratio = hits / (probes.length * 5);
  return ratio >= 0.8 ? 0 : ratio >= 0.6 ? 3 : ratio >= 0.4 ? 8 : 12;
}

export function claudeParsePenalty(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return 0;
  const failures = probes.filter((probe) => !probe.parseOk).length;
  return failures === 0 ? 0 : failures === 1 ? 4 : 8;
}

export function claudeMessageIdPenalty(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return 2;
  const withIds = probes.filter((probe) => typeof probe.upstreamMessageId === "string" && probe.upstreamMessageId.length > 0);
  if (withIds.length === 0) return 2;
  return withIds.every((probe) => isOfficialClaudeMessageId(probe.upstreamMessageId)) ? 0 : 4;
}

function tokenGrowthPenalty(value, threshold) {
  if (!Number.isFinite(value) || value <= threshold) return 0;
  let penalty = 3;
  const ratio = Math.floor(value / threshold);
  for (let index = 2; index <= ratio; index += 1) penalty += index * 3;
  return penalty;
}

export function claudeTokenPenalty(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return 0;
  const input = probes.reduce((sum, probe) => sum + (probe.inputTokens ?? 0), 0);
  const output = probes.reduce((sum, probe) => sum + (probe.outputTokens ?? 0), 0);
  const cacheRead = probes.reduce((sum, probe) => sum + (probe.cacheReadTokens ?? 0), 0);
  const cacheWrite = probes.reduce((sum, probe) => sum + (probe.cacheWriteTokens ?? 0), 0);
  let penalty = tokenGrowthPenalty(input, 3300) + tokenGrowthPenalty(output, 1000);
  if (cacheRead > 3000) penalty += 3;
  if (cacheWrite > 1000) penalty += 3;
  return Math.min(24, penalty);
}

function hasSseEvidence(probe) {
  return Boolean(
    (probe?.rawSseEventCount ?? 0) > 0 ||
    (Array.isArray(probe?.sseEventTypes) && probe.sseEventTypes.length > 0) ||
    (typeof probe?.streamMessageStartModel === "string" && probe.streamMessageStartModel.trim()) ||
    typeof probe?.streamMessageStartInputTokens === "number" ||
    (Array.isArray(probe?.streamMessageDeltaInputTokensSamples) && probe.streamMessageDeltaInputTokensSamples.length > 0) ||
    (Array.isArray(probe?.streamOutputTokensSamples) && probe.streamOutputTokensSamples.length > 0),
  );
}

function hasNonPingSseEvent(probe) {
  return hasSseEvidence(probe) && Array.isArray(probe.sseEventTypes) && probe.sseEventTypes.some((event) => event !== "ping");
}

export function claudeSsePenalty(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return 0;
  const sseProbes = probes.filter(hasSseEvidence);
  if (sseProbes.length === 0) return 0;
  let penalty = 0;
  if (sseProbes.some((probe) => (probe.sseEventTypes || []).some((event) => !OFFICIAL_SSE_EVENT_TYPES.has(event)))) penalty += 6;
  if (sseProbes.some((probe) => {
    const samples = Array.isArray(probe.streamOutputTokensSamples) ? probe.streamOutputTokensSamples : [];
    return samples.some((value, index) => index > 0 && value < samples[index - 1]);
  })) penalty += 6;
  if (sseProbes.some((probe) => {
    if (typeof probe.streamMessageStartInputTokens !== "number") return false;
    const samples = Array.isArray(probe.streamMessageDeltaInputTokensSamples) ? probe.streamMessageDeltaInputTokensSamples : [];
    return samples.some((value) => value !== probe.streamMessageStartInputTokens);
  })) penalty += 10;
  if (sseProbes.some((probe) => (probe.emptySignatureDeltaCount ?? 0) > 0)) penalty += 6;
  if (sseProbes.some((probe) => hasNonPingSseEvent(probe) &&
      (typeof probe.streamMessageStartModel !== "string" || !probe.streamMessageStartModel.trim() ||
        !probe.streamMessageStartModel.toLowerCase().includes("claude")))) penalty += 4;
  return Math.min(18, penalty);
}

export function claudeThinkingPenalty(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return 8;
  if (probes.some((probe) => Array.isArray(probe.contentTypes) && probe.contentTypes.includes("thinking"))) return 0;
  if (probes.some((probe) => typeof probe.responseText === "string" && /thinking/i.test(probe.responseText))) return 3;
  return 8;
}

export function scoreClaudeCompatibility(options) {
  const probes = Array.isArray(options.probes) ? options.probes : [];
  const signature = options.signature || { verdict: null, sigModelName: null };
  const expectedFamily = options.expectedFamily ?? null;
  const includeIdentityEvidence = options.includeIdentityEvidence !== false;
  const variant = options.variant === "standard" ? "standard" : "frontier";
  const penalties = {
    signature: includeIdentityEvidence
      ? claudeSignaturePenalty({ verdict: signature.verdict, sigModelName: signature.sigModelName, expectedFamily })
      : 0,
    upstreamModel: includeIdentityEvidence ? claudeUpstreamModelPenalty(options.upstreamModelId, expectedFamily) : 0,
    knowledge: options.knowledgePassed ? 0 : 18,
    protocol: claudeProtocolPenalty(probes),
    parse: claudeParsePenalty(probes),
    pdf: options.pdfExecuted && !options.pdfPass ? 12 : 0,
    structuredOutput: options.calcExecuted && (!options.calcJsonLegal || !options.calcResultCorrect) ? 12 : 0,
    messageId: includeIdentityEvidence ? claudeMessageIdPenalty(probes) : 0,
    tokens: includeIdentityEvidence ? claudeTokenPenalty(probes) : 0,
    sse: includeIdentityEvidence ? claudeSsePenalty(probes) : 0,
    // The public verifier applies the same thinking-characteristic penalty to
    // both its frontier (`sn`) and standard (`on`) Claude formulas.  A
    // frontier response that never emits a thinking block is therefore not a
    // perfect public-compatibility match, even when its text/protocol checks
    // pass.  Keep this out of the quality-only pass, which intentionally
    // excludes identity/behavior evidence.
    thinking: includeIdentityEvidence ? claudeThinkingPenalty(probes) : 0,
    modelFeature: includeIdentityEvidence && expectedFamily === "fable-5" && options.modelFeaturePass === false ? 20 : 0,
  };
  const totalPenalty = Object.values(penalties).reduce((sum, value) => sum + value, 0);
  let score = 100 - totalPenalty;
  const familyConflict = includeIdentityEvidence && hasClaudeFamilyConflict({
    expectedFamily,
    sigModelName: signature.sigModelName,
    upstreamModelId: options.upstreamModelId,
    signatureVerdict: signature.verdict,
  });
  const stageConflict = includeIdentityEvidence && (variant === "standard"
    ? expectedFamily !== "sonnet-5" && (options.rightQuoteCount ?? 0) >= 1
    : expectedFamily !== "fable-5" && (options.mainStageSignatureDeltaSum ?? 0) >= 1 && options.suppressStageSignatureCap !== true);
  if (familyConflict || stageConflict) score = Math.min(score, 34);
  return { score: clampScore(score), penalties, totalPenalty, familyConflict, stageConflict };
}

function normalizeGptAlgorithmModel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return OFFICIAL_GPT_MODELS.includes(normalized) ? normalized : null;
}

function hasMiniMarker(value) {
  return /(?:^|[-_ ])mini(?:\b|[-_])/i.test(String(value ?? "").trim().toLowerCase());
}

function containsVariantToken(value, token) {
  return new RegExp(`(?:^|[-_ ])${token}(?:\\b|[-_])`, "i").test(String(value ?? "").trim().toLowerCase());
}

function gptSuffix(value, minor) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  const match = normalized.match(new RegExp(`gpt[-_ ]?5(?:[.\\-_ ]?)${minor}((?:\\b|[-_]).*)?$`, "i"));
  return match ? (match[1] ?? "") : null;
}

export function classifyReportedGptModel(value) {
  const v56 = gptSuffix(value, "6");
  if (v56 !== null && !hasMiniMarker(v56)) {
    if (containsVariantToken(v56, "sol")) return "gpt-5.6-sol";
    if (containsVariantToken(v56, "terra")) return "gpt-5.6-terra";
    return null;
  }
  const v55 = gptSuffix(value, "5");
  if (v55 !== null && !hasMiniMarker(v55)) return "gpt-5.5";
  const v54 = gptSuffix(value, "4");
  return v54 !== null && !hasMiniMarker(v54) ? "gpt-5.4" : null;
}

export function officialGptModelMismatch(algorithmModel, reportedModel) {
  const expected = normalizeGptAlgorithmModel(algorithmModel);
  if (!expected) return null;
  const reported = String(reportedModel || "").trim();
  if (!reported) return expected === "gpt-5.6-sol" || expected === "gpt-5.6-terra";
  const classified = classifyReportedGptModel(reported);
  return classified ? classified !== expected : true;
}

function usageRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function usageInteger(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function nestedUsageValue(source, parent, child) {
  return usageRecord(source?.[parent])?.[child];
}

function firstUsageInteger(sources, select) {
  for (const source of sources) {
    const record = usageRecord(source);
    if (!record) continue;
    const value = usageInteger(select(record));
    if (value !== null) return value;
  }
  return null;
}

export function normalizeOpenAiTokenUsage(...values) {
  const sources = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
  const rawInputTokens = firstUsageInteger(sources, (source) =>
    source.prompt_tokens ?? source.input_tokens ?? source.promptTokenCount);
  const outputTokens = firstUsageInteger(sources, (source) =>
    source.completion_tokens ?? source.output_tokens ?? source.candidatesTokenCount);
  const reportedTotalTokens = firstUsageInteger(sources, (source) =>
    source.total_tokens ?? source.totalTokenCount);
  const inclusiveCacheRead = firstUsageInteger(sources, (source) =>
    source.cached_tokens ??
    nestedUsageValue(source, "prompt_tokens_details", "cached_tokens") ??
    nestedUsageValue(source, "input_tokens_details", "cached_tokens") ??
    source.cachedContentTokenCount);
  const additiveCacheRead = inclusiveCacheRead === null
    ? firstUsageInteger(sources, (source) => source.cache_read_input_tokens)
    : null;
  const inclusiveCacheWrite = firstUsageInteger(sources, (source) =>
    nestedUsageValue(source, "prompt_tokens_details", "cache_write_tokens") ??
    nestedUsageValue(source, "input_tokens_details", "cache_write_tokens") ??
    source.cache_write_tokens);
  const additiveCacheWrite = inclusiveCacheWrite === null
    ? firstUsageInteger(sources, (source) =>
        source.cache_creation_input_tokens ??
        source.cache_creation_tokens ??
        nestedUsageValue(source, "prompt_tokens_details", "cache_creation_input_tokens") ??
        nestedUsageValue(source, "prompt_tokens_details", "cache_creation_tokens") ??
        nestedUsageValue(source, "input_tokens_details", "cache_creation_input_tokens") ??
        nestedUsageValue(source, "input_tokens_details", "cache_creation_tokens"))
    : null;
  const rawInput = rawInputTokens ?? 0;
  const boundedCacheRead = Math.min(rawInput, inclusiveCacheRead ?? 0);
  const inputAfterCacheRead = rawInput - boundedCacheRead;
  const boundedCacheWrite = inclusiveCacheWrite !== null && inclusiveCacheWrite <= inputAfterCacheRead
    ? inclusiveCacheWrite
    : 0;
  const cacheReadTokens = inclusiveCacheRead === null ? additiveCacheRead ?? 0 : boundedCacheRead;
  const cacheWriteTokens = inclusiveCacheWrite ?? additiveCacheWrite ?? 0;

  return {
    rawInputTokens,
    inputTokens: rawInputTokens === null ? null : inputAfterCacheRead - boundedCacheWrite,
    outputTokens,
    totalTokens: reportedTotalTokens ?? (
      rawInputTokens !== null && outputTokens !== null ? rawInputTokens + outputTokens : null
    ),
    cacheReadTokens,
    cacheWriteTokens,
    inclusiveCacheReadTokens: boundedCacheRead,
    inclusiveCacheWriteTokens: boundedCacheWrite,
    additiveCacheReadTokens: additiveCacheRead ?? 0,
    additiveCacheWriteTokens: additiveCacheWrite ?? 0,
  };
}

const GPT56_TOKEN_THRESHOLDS = Object.freeze({
  input: 2000,
  output: 2000,
  cacheRead: 1000,
  cacheWrite: 1000,
});

function gpt56TokenCategoryPenalty(value, threshold) {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const excess = normalized - threshold;
  return excess <= 0 ? 0 : Math.min(6, Math.ceil(excess / 500) * 3);
}

export function gpt56TokenPenalty(algorithmModel, tokenUsage = {}) {
  const expected = normalizeGptAlgorithmModel(algorithmModel);
  const applicable = expected === "gpt-5.6-sol" || expected === "gpt-5.6-terra";
  const breakdown = {
    input: applicable ? gpt56TokenCategoryPenalty(tokenUsage.inputTokens, GPT56_TOKEN_THRESHOLDS.input) : 0,
    output: applicable ? gpt56TokenCategoryPenalty(tokenUsage.outputTokens, GPT56_TOKEN_THRESHOLDS.output) : 0,
    cacheRead: applicable ? gpt56TokenCategoryPenalty(tokenUsage.cacheReadTokens, GPT56_TOKEN_THRESHOLDS.cacheRead) : 0,
    cacheWrite: applicable ? gpt56TokenCategoryPenalty(tokenUsage.cacheWriteTokens, GPT56_TOKEN_THRESHOLDS.cacheWrite) : 0,
  };
  return {
    applicable,
    breakdown,
    total: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
  };
}

export function scoreGptCompatibility({
  algorithmModel,
  reportedModel,
  quizStatus,
  protocolStatus,
  responseStructureStatus,
  tokenUsage = {},
}) {
  const expected = normalizeGptAlgorithmModel(algorithmModel);
  if (!expected) {
    return {
      supported: false,
      score: null,
      baseScore: null,
      variantStatus: "unsupported",
      mismatch: null,
      tokenPenalty: gpt56TokenPenalty(null),
    };
  }
  const mismatch = officialGptModelMismatch(expected, reportedModel);
  const variantStatus = mismatch ? "fail" : "pass";
  let baseScore;
  if (variantStatus === "pass" && quizStatus === "pass") {
    baseScore = 100;
  } else {
    baseScore = statusWeight(quizStatus, 60) +
      statusWeight(variantStatus, 20) +
      statusWeight(protocolStatus, 8) +
      statusWeight(responseStructureStatus, 12);
    if (quizStatus === "fail") baseScore = Math.min(baseScore, 59);
    else if (variantStatus !== "pass") baseScore = Math.min(baseScore, 64);
  }
  const tokenPenalty = gpt56TokenPenalty(expected, tokenUsage);
  return {
    supported: true,
    score: clampScore(baseScore - tokenPenalty.total),
    baseScore: clampScore(baseScore),
    variantStatus,
    mismatch,
    tokenPenalty,
  };
}

export function scoreGeminiCompatibility({
  mediumStatus,
  variantStatus,
  protocolStatus,
  responseStructureStatus,
  usedFallbackChallenge = false,
  fallbackTokenCount = 0,
  fallbackLatencyMs = 0,
}) {
  let score = statusWeight(mediumStatus, 28) +
    statusWeight(mediumStatus, 26) +
    statusWeight(variantStatus, 28) +
    statusWeight(protocolStatus, 8) +
    statusWeight(responseStructureStatus, 10);
  if (usedFallbackChallenge && fallbackTokenCount > 3000) score -= 15;
  if (usedFallbackChallenge && fallbackLatencyMs > 50000) score -= 10;
  if (mediumStatus !== "pass") score = Math.min(score, 34);
  else if (variantStatus !== "pass") score = Math.min(score, 59);
  return clampScore(score);
}
