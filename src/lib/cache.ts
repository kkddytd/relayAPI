export interface CacheUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cachedTokens: number;
  /** OpenAI prompt_tokens includes cached tokens; Anthropic input_tokens does not. */
  inputTokensIncludeCache: boolean;
  evidenceFields: string[];
}

export interface CacheRound {
  round: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  hitRate: number | null;
  evidence: boolean;
  evidenceFields?: string[];
  inputTokensIncludeCache?: boolean;
  usageObserved?: boolean;
  usageComplete?: boolean;
  baseline?: CacheBaselineRound;
  baselineWeighted?: number;
  measuredWeighted?: number;
  multiplier?: number | null;
  inputDeltaPct?: number | null;
  outputDeltaPct?: number | null;
  cacheCreationDeltaPct?: number | null;
  cacheReadDeltaPct?: number | null;
}

export type CacheApplicabilityReason =
  | "protocol_not_supported"
  | "model_not_supported"
  | "upstream_unavailable";

export type CacheBaselineSource = "official-canonical" | "official-alias";
export type CacheRequestProfile = "custom" | "claude_code";

export interface CacheBaselineInfo {
  model: string | null;
  source: CacheBaselineSource | null;
  requestProfile: CacheRequestProfile;
  rounds: CacheBaselineRound[] | null;
}

export interface CacheReport {
  applicable: boolean;
  reason?: CacheApplicabilityReason;
  /** `incomplete` is the API wire name; `partial` remains accepted for local reports. */
  status: "confirmed" | "partial" | "incomplete" | "unconfirmed" | "unobserved" | "failed";
  rounds: CacheRound[];
  /** Number of logical cache rounds completed (the probe plans five). */
  completedRounds?: number;
  /** Number of logical rounds planned for this run. */
  logicalRounds?: number;
  /** Actual upstream request attempts, including transient retries. */
  requestAttempts?: number;
  /** Profiles used when the request-shape fallback runs. */
  requestProfilesUsed?: CacheRequestProfile[];
  evidenceFields: string[];
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Official-style arithmetic average of rounds 2-5. */
  hitRate: number | null;
  /** Diagnostic weighted aggregate for warm rounds only. */
  warmHitRate: number | null;
  evidenceSufficient: boolean;
  meteringObserved?: boolean;
  meteringComplete?: boolean;
  baselineMultiplier?: number | null;
  baselineHitRate?: number | null;
  comparisonHitRate?: number | null;
  compatibilityScore?: number | null;
  measuredCostIndex?: number;
  baselineCostIndex?: number | null;
  /** The model whose archived five-round profile is used as a reference. */
  baselineModel?: string | null;
  /** The evaluation profile that actually received the five observation requests. */
  observationModel?: string | null;
  baselineSource?: CacheBaselineSource | null;
  baselineAvailable?: boolean;
  /** Whether the selected model/profile has a directly comparable five-round baseline. */
  baselineComparison?: "reference-only" | "compared" | "none";
  /** The public comparison formula used zero warm-round reads because no warm usage fields were returned. */
  comparisonAssumption?: "missing_usage_treated_as_zero" | null;
  requestProfile?: CacheRequestProfile;
  requestTemplateVersion?: string;
  requestTemplateComparable?: boolean;
  /** Number of warm rounds with provider-reported cache usage fields. */
  observedWarmRounds?: number;
  /** Number of warm rounds required for a full confirmation (normally four). */
  requiredWarmRounds?: number;
  /** Number of warm rounds with a positive cache-read value. */
  warmRoundsWithRead?: number;
  failureDetail?: string;
  /** Number of independent five-round validation groups requested. */
  requestedRuns?: number;
  /** Number of independent validation groups completed. */
  completedRuns?: number;
  /** Aggregation used for independent validation groups. */
  aggregation?: "single" | "median";
  /** Per-group reports when independent validation was requested. */
  runs?: CacheRunReport[];
  /** Snake-case aliases used by the HTTP API wire format. */
  requested_runs?: number;
  completed_runs?: number;
  /** Snake-case alias for `aggregation`. */
  aggregation_method?: "single" | "median";
}

/** A single independent cache validation group (always up to five logical rounds). */
export interface CacheRunReport extends Omit<CacheReport, "runs"> {
  /** One-based validation-group index in API responses. */
  run?: number;
}

export interface CacheBaselineRound {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

const CACHE_BASELINE_PROFILES: Record<string, Record<CacheRequestProfile, CacheBaselineRound[]>> = {
  "claude-opus-4-6": {
    custom: [
      { input: 3, output: 22, cacheCreation: 4656, cacheRead: 0 },
      { input: 3, output: 17, cacheCreation: 46, cacheRead: 4656 },
      { input: 3, output: 14, cacheCreation: 41, cacheRead: 4702 },
      { input: 3, output: 14, cacheCreation: 38, cacheRead: 4743 },
      { input: 3, output: 11, cacheCreation: 38, cacheRead: 4781 },
    ],
    claude_code: [
      { input: 3, output: 67, cacheCreation: 23267, cacheRead: 0 },
      { input: 3, output: 55, cacheCreation: 240, cacheRead: 23267 },
      { input: 3, output: 15, cacheCreation: 233, cacheRead: 23507 },
      { input: 3, output: 16, cacheCreation: 232, cacheRead: 23740 },
      { input: 3, output: 16, cacheCreation: 233, cacheRead: 23972 },
    ],
  },
  "claude-opus-4-7": {
    custom: [
      { input: 6, output: 15, cacheCreation: 6276, cacheRead: 0 },
      { input: 6, output: 15, cacheCreation: 50, cacheRead: 6276 },
      { input: 6, output: 15, cacheCreation: 50, cacheRead: 6326 },
      { input: 6, output: 15, cacheCreation: 50, cacheRead: 6376 },
      { input: 6, output: 15, cacheCreation: 50, cacheRead: 6426 },
    ],
    claude_code: [
      { input: 6, output: 11, cacheCreation: 31776, cacheRead: 0 },
      { input: 6, output: 11, cacheCreation: 300, cacheRead: 31776 },
      { input: 6, output: 11, cacheCreation: 300, cacheRead: 32076 },
      { input: 6, output: 11, cacheCreation: 300, cacheRead: 32376 },
      { input: 6, output: 11, cacheCreation: 300, cacheRead: 32676 },
    ],
  },
  "claude-opus-4-8": {
    custom: [
      { input: 2, output: 14, cacheCreation: 5822, cacheRead: 0 },
      { input: 2, output: 14, cacheCreation: 45, cacheRead: 5822 },
      { input: 2, output: 14, cacheCreation: 45, cacheRead: 5867 },
      { input: 2, output: 14, cacheCreation: 45, cacheRead: 5912 },
      { input: 2, output: 14, cacheCreation: 45, cacheRead: 5957 },
    ],
    claude_code: [
      { input: 2, output: 18, cacheCreation: 31390, cacheRead: 0 },
      { input: 2, output: 18, cacheCreation: 303, cacheRead: 31390 },
      { input: 2, output: 18, cacheCreation: 303, cacheRead: 31693 },
      { input: 2, output: 18, cacheCreation: 303, cacheRead: 31996 },
      { input: 2, output: 18, cacheCreation: 303, cacheRead: 32299 },
    ],
  },
  "claude-sonnet-4-6": {
    custom: [
      { input: 3, output: 10, cacheCreation: 4640, cacheRead: 0 },
      { input: 3, output: 11, cacheCreation: 34, cacheRead: 4640 },
      { input: 3, output: 10, cacheCreation: 35, cacheRead: 4674 },
      { input: 3, output: 11, cacheCreation: 34, cacheRead: 4709 },
      { input: 3, output: 11, cacheCreation: 35, cacheRead: 4743 },
    ],
    claude_code: [
      { input: 3, output: 50, cacheCreation: 23156, cacheRead: 0 },
      { input: 3, output: 47, cacheCreation: 227, cacheRead: 23156 },
      { input: 3, output: 9, cacheCreation: 227, cacheRead: 23383 },
      { input: 3, output: 9, cacheCreation: 227, cacheRead: 23610 },
      { input: 3, output: 9, cacheCreation: 227, cacheRead: 23837 },
    ],
  },
};

// The archived reference catalog aliases these model IDs to an existing canonical
// profile. This is a reference mapping, not evidence that the upstream model
// itself has a Fable-specific baseline.
const CACHE_BASELINE_ALIASES: Record<string, string> = {
  "claude-sonnet-5": "claude-sonnet-4-6",
  "claude-fable-5": "claude-opus-4-8",
  "claude-5-fable": "claude-opus-4-8",
  fable5: "claude-opus-4-8",
  "fable-5": "claude-opus-4-8",
};

const CACHE_OBSERVATION_MODELS = new Set([
  ...Object.keys(CACHE_BASELINE_PROFILES),
  "claude-fable-5",
  "claude-5-fable",
  "fable5",
  "fable-5",
]);

function normalizeCacheModel(model: string): string {
  return model.trim().toLowerCase().replace(/\[(?:1m|fast)\]$/i, "");
}

/** Models for which the browser can send five real Anthropic cache requests. */
export function canRunCacheObservation(model: string): boolean {
  return CACHE_OBSERVATION_MODELS.has(normalizeCacheModel(model));
}

/** @deprecated Use canRunCacheObservation for explicit observation semantics. */
export const isCacheSupportedModel = canRunCacheObservation;

/** Models with a directly comparable public five-round baseline. */
export function hasOfficialComparableCacheBaseline(model: string): boolean {
  return Boolean(CACHE_BASELINE_PROFILES[normalizeCacheModel(model)]);
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readNestedNumber(source: unknown, paths: string[][]): { value: number | null; field: string | null } {
  for (const path of paths) {
    let cursor: unknown = source;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = null;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    const value = asNonNegativeNumber(cursor);
    if (value !== null) return { value, field: path.join(".") };
  }
  return { value: null, field: null };
}

export function extractCacheUsage(usage: unknown): CacheUsageSnapshot {
  const source = usage && typeof usage === "object" ? usage : {};
  const input = readNestedNumber(source, [["input_tokens"], ["prompt_tokens"]]);
  const output = readNestedNumber(source, [["output_tokens"], ["completion_tokens"]]);
  const explicitRead = readNestedNumber(source, [
    ["cache_read_input_tokens"],
    ["cache_read_tokens"],
  ]);
  const promptCached = readNestedNumber(source, [
    ["prompt_tokens_details", "cached_tokens"],
    ["input_tokens_details", "cached_tokens"],
    ["cached_tokens"],
  ]);
  const read = explicitRead.value !== null ? explicitRead : promptCached;
  const creation = readNestedNumber(source, [
    ["cache_creation_input_tokens"],
    ["cache_write_input_tokens"],
    ["cache_creation_tokens"],
  ]);

  const fields = [read.field, creation.field].filter(
    (field): field is string => Boolean(field),
  );
  const inputTokens = input.value ?? 0;
  const outputTokens = output.value ?? 0;
  const cacheReadTokens = read.value ?? 0;
  const cacheCreationTokens = creation.value ?? 0;
  const inputTokensIncludeCache =
    input.field === "prompt_tokens" &&
    explicitRead.value === null &&
    promptCached.value !== null;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cachedTokens: cacheReadTokens,
    inputTokensIncludeCache,
    evidenceFields: [...new Set(fields)],
  };
}

export function calculateCacheHitRate(snapshot: CacheUsageSnapshot): number | null {
  if (snapshot.evidenceFields.length === 0) return null;
  const denominator = snapshot.inputTokensIncludeCache
    ? snapshot.inputTokens + snapshot.cacheCreationTokens
    : snapshot.inputTokens + snapshot.cacheCreationTokens + snapshot.cacheReadTokens;
  if (denominator <= 0) return null;
  return Number(((snapshot.cacheReadTokens / denominator) * 100).toFixed(1));
}

export function calculateCacheCostIndex(snapshot: CacheUsageSnapshot): number {
  const uncachedInput = snapshot.inputTokensIncludeCache
    ? Math.max(0, snapshot.inputTokens - snapshot.cacheReadTokens)
    : snapshot.inputTokens;
  return Number(
    (
      uncachedInput +
      snapshot.cacheCreationTokens * 1.25 +
      snapshot.cacheReadTokens * 0.1 +
      snapshot.outputTokens * 5
    ).toFixed(2),
  );
}

export function calculateWeightedCacheCost(round: CacheBaselineRound): number {
  return round.input + round.cacheCreation * 1.25 + round.cacheRead * 0.1 + round.output * 5;
}

function cacheRoundDenominator(round: CacheRound): number {
  return round.inputTokensIncludeCache
    ? round.inputTokens + round.cacheCreationTokens
    : round.inputTokens + round.cacheCreationTokens + round.cacheReadTokens;
}

function cacheRoundHitRate(round: CacheRound): number | null {
  const hasEvidence = round.evidence || (round.evidenceFields?.length ?? 0) > 0;
  if (!hasEvidence) return null;
  const denominator = cacheRoundDenominator(round);
  if (denominator <= 0) return null;
  return Number(((round.cacheReadTokens / denominator) * 100).toFixed(1));
}

/** The compatibility average excludes round 1, which only creates the cache. */
function averageWarmHitRate(rounds: CacheRound[]): number | null {
  const observed = rounds
    .slice(1)
    .map(cacheRoundHitRate)
    .filter((value): value is number => value !== null);
  if (observed.length === 0) return null;
  return Number((observed.reduce((sum, value) => sum + value, 0) / observed.length).toFixed(1));
}

function weightedHitRate(rounds: CacheRound[]): number | null {
  const observed = rounds.filter((round) => cacheRoundHitRate(round) !== null);
  if (observed.length === 0) return null;
  const denominator = observed.reduce((sum, round) => sum + cacheRoundDenominator(round), 0);
  if (denominator <= 0) return null;
  const read = observed.reduce((sum, round) => sum + round.cacheReadTokens, 0);
  return Number(((read / denominator) * 100).toFixed(1));
}

export function compareCacheBaseline(
  rounds: CacheRound[],
  baseline: CacheBaselineRound[] | null | undefined,
): Pick<CacheReport, "baselineMultiplier" | "baselineHitRate" | "comparisonHitRate" | "comparisonAssumption" | "compatibilityScore" | "measuredCostIndex" | "baselineCostIndex" | "rounds"> {
  const percentDelta = (actual: number, expected: number): number | null =>
    expected <= 0 ? actual > 0 ? 100 : null : Number((((actual - expected) / expected) * 100).toFixed(1));
  const measured: CacheBaselineRound[] = rounds.map((round) => ({ input: round.inputTokens, output: round.outputTokens, cacheCreation: round.cacheCreationTokens, cacheRead: round.cacheReadTokens }));
  const measuredCostIndex = measured.reduce((sum, round) => sum + calculateWeightedCacheCost(round), 0);
  if (!baseline || baseline.length === 0) {
    return {
      baselineMultiplier: null,
      baselineHitRate: null,
      comparisonHitRate: null,
      comparisonAssumption: null,
      compatibilityScore: null,
      measuredCostIndex,
      baselineCostIndex: null,
      rounds: rounds.map((round, index) => ({
        ...round,
        measuredWeighted: round.usageComplete === false ? undefined : calculateWeightedCacheCost(measured[index]),
      })),
    };
  }
  const matchedBaseline = rounds.map((_, index) => baseline[Math.min(index, baseline.length - 1)]);
  const comparedRounds = rounds.map((round, index) => {
    const reference = matchedBaseline[index];
    const meteringComplete = round.usageComplete !== false;
    const measuredWeighted = meteringComplete ? calculateWeightedCacheCost(measured[index]) : undefined;
    const baselineWeighted = calculateWeightedCacheCost(reference);
    return {
      ...round,
      baseline: { ...reference },
      measuredWeighted,
      baselineWeighted,
      multiplier: measuredWeighted !== undefined && baselineWeighted > 0 ? Number((measuredWeighted / baselineWeighted).toFixed(3)) : null,
      inputDeltaPct: meteringComplete ? percentDelta(round.inputTokens, reference.input) : null,
      outputDeltaPct: meteringComplete && round.outputTokens > reference.output * 2 ? percentDelta(round.outputTokens, reference.output) : null,
      cacheCreationDeltaPct: meteringComplete ? percentDelta(round.cacheCreationTokens, reference.cacheCreation) : null,
      cacheReadDeltaPct: meteringComplete ? percentDelta(round.cacheReadTokens, reference.cacheRead) : null,
    };
  });
  const baselineCostIndex = matchedBaseline.reduce((sum, round) => sum + calculateWeightedCacheCost(round), 0);
  const baselinePostWarmup = matchedBaseline.slice(1);
  const baselineRoundHitRates = baselinePostWarmup
    .map((round) => {
      const denominator = round.input + round.cacheCreation + round.cacheRead;
      return denominator > 0 ? round.cacheRead / denominator * 100 : null;
    })
    .filter((value): value is number => value !== null);
  const baselineHitRate = baselineRoundHitRates.length > 0
    ? Number((baselineRoundHitRates.reduce((sum, value) => sum + value, 0) / baselineRoundHitRates.length).toFixed(1))
    : null;
  const warmRounds = rounds.slice(1, 5);
  const observedWarmRounds = warmRounds.filter(
    (round) => round.evidence || (round.evidenceFields?.length ?? 0) > 0,
  ).length;
  const measuredWarmRates = warmRounds.map((round) => {
    const denominator = round.inputTokens + round.cacheCreationTokens + round.cacheReadTokens;
    return denominator > 0 ? round.cacheReadTokens / denominator * 100 : 0;
  });
  const comparisonHitRate = rounds.length >= 5 && observedWarmRounds === 4
    ? Number((measuredWarmRates.reduce((sum, value) => sum + value, 0) / measuredWarmRates.length).toFixed(1))
    : observedWarmRounds === 0 && rounds.length >= 5
      ? 0
      : null;
  const comparisonAssumption = Boolean(baseline?.length) && rounds.length >= 5 && observedWarmRounds === 0
    ? "missing_usage_treated_as_zero" as const
    : null;
  const baselineMultiplier = baselineCostIndex > 0 ? Number((measuredCostIndex / baselineCostIndex).toFixed(3)) : null;
  const compatibilityScore = measuredCostIndex > 0 && baselineCostIndex > 0 && comparisonHitRate !== null && baselineHitRate !== null && baselineHitRate > 0
    ? Math.min(100, Math.max(0, Math.round(Math.min(
        baselineCostIndex / measuredCostIndex,
        comparisonHitRate / baselineHitRate / 0.98,
      ) * 100)))
    : null;
  return {
    baselineMultiplier,
    baselineHitRate,
    comparisonHitRate,
    comparisonAssumption,
    compatibilityScore,
    measuredCostIndex,
    baselineCostIndex,
    rounds: comparedRounds,
  };
}

export function getCacheBaselineInfo(model: string, requestProfile: CacheRequestProfile = "custom"): CacheBaselineInfo {
  const normalized = normalizeCacheModel(model);
  const canonicalModel = CACHE_BASELINE_PROFILES[normalized]
    ? normalized
    : CACHE_BASELINE_ALIASES[normalized] ?? null;
  if (!canonicalModel) {
    return { model: null, source: null, requestProfile, rounds: null };
  }
  const baseline = CACHE_BASELINE_PROFILES[canonicalModel]?.[requestProfile];
  if (!baseline) {
    return { model: null, source: null, requestProfile, rounds: null };
  }
  return {
    model: canonicalModel,
    source: canonicalModel === normalized ? "official-canonical" : "official-alias",
    requestProfile,
    rounds: baseline.map((round) => ({ ...round })),
  };
}

export function getCacheBaseline(model: string, requestProfile: CacheRequestProfile = "custom"): CacheBaselineRound[] | null {
  return getCacheBaselineInfo(model, requestProfile).rounds;
}

export function summarizeCacheRounds(rounds: CacheRound[], applicable = true): CacheReport {
  if (!applicable) {
    return {
      applicable: false,
      reason: "model_not_supported",
      status: "unconfirmed",
      rounds: [],
      completedRounds: 0,
      logicalRounds: 5,
      requestAttempts: 0,
      requestProfilesUsed: [],
      evidenceFields: [],
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      hitRate: null,
      warmHitRate: null,
      evidenceSufficient: false,
      baselineModel: null,
      baselineSource: null,
      baselineAvailable: false,
      baselineComparison: "none",
      comparisonAssumption: null,
      observedWarmRounds: 0,
      requiredWarmRounds: 4,
      warmRoundsWithRead: 0,
      meteringObserved: false,
      meteringComplete: false,
    };
  }

  const evidenceFields = [...new Set(rounds.flatMap((round) => round.evidenceFields ?? (round.evidence ? ["usage"] : [])))];
  const cacheReadTokens = rounds.reduce((sum, round) => sum + round.cacheReadTokens, 0);
  const cacheCreationTokens = rounds.reduce((sum, round) => sum + round.cacheCreationTokens, 0);
  const roundsWithEvidence = rounds.filter(
    (round) => round.evidence || (round.evidenceFields?.length ?? 0) > 0,
  ).length;
  const warmRounds = rounds.slice(1, 5);
  const warmRoundsWithEvidence = warmRounds.filter(
    (round) => round.evidence || (round.evidenceFields?.length ?? 0) > 0,
  ).length;
  const warmRoundsWithRead = warmRounds.filter((round) => round.cacheReadTokens > 0).length;
  const roundHasMetering = (round: CacheRound) => round.usageObserved ?? (
    round.inputTokens > 0 ||
    round.outputTokens > 0 ||
    round.cacheReadTokens > 0 ||
    round.cacheCreationTokens > 0 ||
    round.evidence ||
    (round.evidenceFields?.length ?? 0) > 0
  );
  const meteringObserved = rounds.some(roundHasMetering);
  const meteringComplete = rounds.length >= 5 && rounds.every((round) => round.usageComplete ?? roundHasMetering(round));
  // One cache-read field, especially in the first cache-creation request, is
  // not enough to establish repeatable prompt-cache behavior. Confirmation
  // requires provider usage evidence and real reads in all four warm rounds.
  const warmEvidenceSufficient = rounds.length >= 5 && warmRoundsWithEvidence === 4;
  const repeatedWarmReads = warmRoundsWithRead === 4;
  // Keep `hitRate` aligned with the official site's averageHitRate: arithmetic
  // mean of rounds 2-5. The weighted warm aggregate remains diagnostic.
  const hitRate = averageWarmHitRate(rounds);
  const warmHitRate = weightedHitRate(rounds.slice(1));

  return {
    applicable: true,
    status:
      rounds.length >= 5
        ? warmEvidenceSufficient && repeatedWarmReads
          ? "confirmed"
          : warmRoundsWithEvidence === 0
            ? "unobserved"
            : "unconfirmed"
        : roundsWithEvidence > 0
            ? "partial"
            : "unconfirmed",
    rounds,
    completedRounds: rounds.length,
    logicalRounds: 5,
    requestAttempts: rounds.length,
    requestProfilesUsed: [],
    evidenceFields,
    cacheReadTokens,
    cacheCreationTokens,
    hitRate,
    warmHitRate,
    evidenceSufficient: warmEvidenceSufficient && repeatedWarmReads,
    meteringObserved,
    meteringComplete,
    baselineModel: null,
    baselineSource: null,
    baselineAvailable: false,
    baselineComparison: "none",
    observedWarmRounds: warmRoundsWithEvidence,
    requiredWarmRounds: 4,
    warmRoundsWithRead,
  };
}
