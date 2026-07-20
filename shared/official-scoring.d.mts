export type CheckStatus = "pass" | "warning" | "fail";

export interface OfficialScoreProbe {
  protocolHints?: Record<string, boolean>;
  parseOk?: boolean;
  upstreamMessageId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  rawSseEventCount?: number;
  sseEventTypes?: string[];
  streamMessageStartModel?: string | null;
  streamMessageStartInputTokens?: number | null;
  streamMessageDeltaInputTokensSamples?: number[];
  streamOutputTokensSamples?: number[];
  emptySignatureDeltaCount?: number;
  contentTypes?: string[];
  responseText?: string;
}

export const OFFICIAL_SCORING_REFERENCE: Readonly<{
  capturedAt: string;
  bundle: string;
  bundleSha256: string;
  probeConstantsBundle: string;
  probeConstantsSha256: string;
}>;
export const OFFICIAL_DEDICATED_MODELS: readonly string[];
export const OFFICIAL_GPT_MODELS: readonly string[];
export function officialPassThreshold(profileModel: string | null | undefined): number;
export const OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID: string;
export const OFFICIAL_CLAUDE_PROBE_HEADERS: Readonly<Record<string, string>>;

export function isOfficialClaudeMessageId(value: unknown): boolean;
export function classifyClaudeFamily(value: unknown): string | null;
export function expectedClaudeFamily(modelId: unknown): string | null;
export function claudeSignaturePenalty(options: { verdict?: string | null; sigModelName?: string | null; expectedFamily?: string | null }): number;
export function claudeUpstreamModelPenalty(upstreamModelId?: string | null, expectedFamily?: string | null): number;
export function hasClaudeFamilyConflict(options: { expectedFamily?: string | null; sigModelName?: string | null; upstreamModelId?: string | null; signatureVerdict?: string | null }): boolean;
export function claudeProtocolPenalty(probes: readonly OfficialScoreProbe[]): number;
export function claudeParsePenalty(probes: readonly OfficialScoreProbe[]): number;
export function claudeMessageIdPenalty(probes: readonly OfficialScoreProbe[]): number;
export function claudeTokenPenalty(probes: readonly OfficialScoreProbe[]): number;
export function claudeSsePenalty(probes: readonly OfficialScoreProbe[]): number;
export function claudeThinkingPenalty(probes: readonly OfficialScoreProbe[]): number;

export function scoreClaudeCompatibility(options: {
  variant: "frontier" | "standard";
  probes: readonly OfficialScoreProbe[];
  expectedFamily?: string | null;
  upstreamModelId?: string | null;
  signature?: { verdict?: string | null; sigModelName?: string | null };
  knowledgePassed: boolean;
  pdfExecuted: boolean;
  pdfPass: boolean;
  calcExecuted: boolean;
  calcJsonLegal: boolean;
  calcResultCorrect: boolean;
  rightQuoteCount?: number;
  mainStageSignatureDeltaSum?: number;
  suppressStageSignatureCap?: boolean;
  modelFeaturePass?: boolean;
  includeIdentityEvidence?: boolean;
}): {
  score: number;
  penalties: Record<string, number>;
  totalPenalty: number;
  familyConflict: boolean;
  stageConflict: boolean;
};

export function classifyReportedGptModel(value: unknown): string | null;
export function officialGptModelMismatch(algorithmModel: unknown, reportedModel: unknown): boolean | null;
export function scoreGptCompatibility(options: {
  algorithmModel: string;
  reportedModel?: string | null;
  quizStatus: CheckStatus;
  protocolStatus: CheckStatus;
  responseStructureStatus: CheckStatus;
}): {
  supported: boolean;
  score: number | null;
  variantStatus: CheckStatus | "unsupported";
  mismatch: boolean | null;
};

export function scoreGeminiCompatibility(options: {
  mediumStatus: CheckStatus;
  variantStatus: CheckStatus;
  protocolStatus: CheckStatus;
  responseStructureStatus: CheckStatus;
  usedFallbackChallenge?: boolean;
  fallbackTokenCount?: number;
  fallbackLatencyMs?: number;
}): number;
