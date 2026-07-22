import { describe, expect, it } from "vitest";
import {
  canRunCacheObservation,
  calculateCacheHitRate,
  compareCacheBaseline,
  extractCacheUsage,
  getCacheBaseline,
  getCacheBaselineInfo,
  hasOfficialComparableCacheBaseline,
  isCacheSupportedModel,
  summarizeCacheRounds,
  type CacheRound,
} from "@/lib/cache";
import cacheProbeTemplate from "../../shared/cache-probe-custom.json";
import { OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID } from "../../shared/official-scoring.mjs";

describe("prompt cache evidence", () => {
  it("keeps the public custom cache request template byte-for-byte comparable", () => {
    const marker = "[cache_test_run: 2026-07-15T09:21:22Z]";
    const cachecheckSuffix = `[cachecheck mode]
This is an automated prompt-cache probe. Do NOT call any tools.
Reply with exactly one short sentence in plain text. No tool_use, no lists, no markdown.`;
    const tools = cacheProbeTemplate.tools.map((tool, index) => ({
      ...tool,
      description: `${tool.description}\n\n${marker}`,
      ...(index === cacheProbeTemplate.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    const body = {
      model: "claude-opus-4-8",
      system: [{ type: "text", text: `${cacheProbeTemplate.system}\n\n${cachecheckSuffix}\n\n${marker}`, cache_control: { type: "ephemeral" } }],
      tools,
      messages: [{ role: "user", content: [{ type: "text", text: "[cachecheck round 0] Do not call any tools. Reply with one short sentence only.", cache_control: { type: "ephemeral" } }] }],
      metadata: { user_id: OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID },
      max_tokens: 40960,
      stream: true,
    };
    expect(cacheProbeTemplate.version).toBe("public-cache-custom-2026-06-18-r5");
    expect(cacheProbeTemplate).not.toHaveProperty("metadataUserId");
    expect(JSON.stringify(body.system)).toHaveLength(493);
    expect(JSON.stringify(body.tools)).toHaveLength(14892);
    expect(JSON.stringify(body)).toHaveLength(15871);
  });

  it("reads Anthropic and OpenAI cache token fields", () => {
    const anthropic = extractCacheUsage({
      input_tokens: 3,
      output_tokens: 8,
      cache_read_input_tokens: 4800,
      cache_creation_input_tokens: 40,
    });
    expect(anthropic.cacheReadTokens).toBe(4800);
    expect(anthropic.inputTokensIncludeCache).toBe(false);
    expect(anthropic.cacheCreationTokens).toBe(40);
    expect(anthropic.evidenceFields).toEqual([
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]);

    const openAI = extractCacheUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(openAI.cacheReadTokens).toBe(80);
    expect(openAI.inputTokensIncludeCache).toBe(true);
    expect(calculateCacheHitRate(openAI)).toBe(80);
    expect(openAI.evidenceFields).toEqual(["prompt_tokens_details.cached_tokens"]);
  });

  it("does not infer cache evidence from ordinary usage tokens", () => {
    const usage = extractCacheUsage({ input_tokens: 100, output_tokens: 5 });
    expect(usage.evidenceFields).toEqual([]);
    expect(calculateCacheHitRate(usage)).toBeNull();
    const report = summarizeCacheRounds([{
      round: 1,
      latencyMs: 10,
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      hitRate: null,
      evidence: false,
    }]);
    expect(report.hitRate).toBeNull();
  });

  it("confirms only a complete five-round run with repeated cache reads", () => {
    const rounds: CacheRound[] = Array.from({ length: 5 }, (_, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: 3,
      outputTokens: 10,
      cacheReadTokens: index === 0 ? 0 : 4600 + index * 40,
      cacheCreationTokens: index === 0 ? 4600 : 40,
      hitRate: index === 0 ? 0 : 98,
      evidence: true,
      evidenceFields: ["cache_read_input_tokens", "cache_creation_input_tokens"],
    }));
    const report = summarizeCacheRounds(rounds);
    expect(report.status).toBe("confirmed");
    expect(report.evidenceSufficient).toBe(true);
    expect(report.evidenceFields).toContain("cache_read_input_tokens");
    // The official average excludes round 1 (cache creation) and averages
    // rounds 2-5 arithmetically instead of counting the warm-up as 0%.
    expect(report.hitRate).toBeCloseTo(99.1, 1);
    expect(report.warmHitRate).toBeCloseTo(report.hitRate ?? 0, 1);
  });

  it("keeps completed misses and incomplete evidence distinct", () => {
    const creationOnly: CacheRound[] = Array.from({ length: 5 }, (_, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: 3,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: index === 0 ? 5800 : 45,
      hitRate: 0,
      evidence: true,
      evidenceFields: ["cache_read_input_tokens", "cache_creation_input_tokens"],
    }));
    expect(summarizeCacheRounds(creationOnly).status).toBe("unconfirmed");

    const partial = summarizeCacheRounds(creationOnly.slice(0, 2));
    expect(partial.status).toBe("partial");
    expect(partial.rounds).toHaveLength(2);

    const noUsageFields = creationOnly.map((round) => ({
      ...round,
      cacheCreationTokens: 0,
      evidence: false,
      evidenceFields: [],
    }));
    expect(summarizeCacheRounds(noUsageFields).status).toBe("unobserved");
  });

  it("does not confirm from a first-round read or sparse warm evidence", () => {
    const firstRoundReadOnly: CacheRound[] = Array.from({ length: 5 }, (_, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: 3,
      outputTokens: 8,
      cacheReadTokens: index === 0 ? 5800 : 0,
      cacheCreationTokens: index === 0 ? 40 : 45,
      hitRate: index === 0 ? 99 : 0,
      evidence: true,
      evidenceFields: ["cache_read_input_tokens", "cache_creation_input_tokens"],
    }));
    const firstRoundReport = summarizeCacheRounds(firstRoundReadOnly);
    expect(firstRoundReport.status).toBe("unconfirmed");
    expect(firstRoundReport.evidenceSufficient).toBe(false);

    const sparseWarmEvidence = firstRoundReadOnly.map((round, index) => ({
      ...round,
      cacheReadTokens: index >= 1 && index <= 2 ? 5800 : 0,
      evidence: index <= 2,
      evidenceFields: index <= 2
        ? ["cache_read_input_tokens", "cache_creation_input_tokens"]
        : [],
    }));
    const sparseReport = summarizeCacheRounds(sparseWarmEvidence);
    expect(sparseReport.status).toBe("unconfirmed");
    expect(sparseReport.evidenceSufficient).toBe(false);
  });

  it("treats first-round-only usage as unobserved warm-cache behavior", () => {
    const rounds: CacheRound[] = Array.from({ length: 5 }, (_, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: 3,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: index === 0 ? 5800 : 0,
      hitRate: index === 0 ? 0 : null,
      evidence: index === 0,
      evidenceFields: index === 0 ? ["cache_creation_input_tokens"] : [],
    }));
    const report = summarizeCacheRounds(rounds);
    expect(report.status).toBe("unobserved");
    expect(report.observedWarmRounds).toBe(0);
    expect(report.evidenceSufficient).toBe(false);
  });

  it("requires token metering on every logical round before exposing aggregate measurements", () => {
    const rounds: CacheRound[] = Array.from({ length: 5 }, (_, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: index === 0 ? 12 : 0,
      outputTokens: index === 0 ? 3 : 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      hitRate: null,
      evidence: false,
      evidenceFields: [],
      usageObserved: index === 0,
    }));

    const report = summarizeCacheRounds(rounds);
    expect(report.meteringObserved).toBe(true);
    expect(report.meteringComplete).toBe(false);
  });

  it("distinguishes partial usage evidence from complete input and output metering", () => {
    const rounds: CacheRound[] = Array.from({ length: 5 }, (_, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: 12,
      outputTokens: index === 2 ? 0 : 3,
      cacheReadTokens: index > 0 ? 100 : 0,
      cacheCreationTokens: index === 0 ? 100 : 0,
      hitRate: index > 0 ? 80 : 0,
      evidence: true,
      evidenceFields: ["cache_read_input_tokens"],
      usageObserved: true,
      usageComplete: index !== 2,
    }));

    const report = summarizeCacheRounds(rounds);
    expect(report.meteringObserved).toBe(true);
    expect(report.meteringComplete).toBe(false);
  });

  it("keeps Fable observation separate from its Opus 4.8 reference baseline", () => {
    expect(canRunCacheObservation("claude-opus-4-8")).toBe(true);
    expect(canRunCacheObservation("claude-fable-5")).toBe(true);
    expect(canRunCacheObservation("claude-5-fable")).toBe(true);
    expect(isCacheSupportedModel("fable5")).toBe(true);
    expect(canRunCacheObservation("claude-sonnet-5")).toBe(false);
    expect(hasOfficialComparableCacheBaseline("claude-opus-4-8")).toBe(true);
    expect(hasOfficialComparableCacheBaseline("claude-fable-5")).toBe(false);
    const baseline = getCacheBaseline("claude-opus-4-8");
    expect(baseline).toHaveLength(5);
    const fableInfo = getCacheBaselineInfo("claude-fable-5");
    expect(fableInfo.model).toBe("claude-opus-4-8");
    expect(fableInfo.source).toBe("official-alias");
    expect(getCacheBaseline("claude-fable-5")).toEqual(baseline);
    expect(getCacheBaselineInfo("claude-5-fable").model).toBe("claude-opus-4-8");
    expect(getCacheBaselineInfo("claude-sonnet-5").model).toBe("claude-sonnet-4-6");
    expect(getCacheBaselineInfo("fable5").model).toBe("claude-opus-4-8");
    if (!baseline) throw new Error("missing baseline");
    const rounds: CacheRound[] = baseline.map((round, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: round.input,
      outputTokens: round.output,
      cacheReadTokens: round.cacheRead,
      cacheCreationTokens: round.cacheCreation,
      hitRate: null,
      evidence: true,
    }));
    expect(summarizeCacheRounds(rounds).hitRate).toBeCloseTo(99.2, 1);
    expect(compareCacheBaseline(rounds, baseline).baselineMultiplier).toBe(1);
    expect(compareCacheBaseline(rounds, null).compatibilityScore).toBeNull();
  });

  it("reproduces the public Opus 4.8 weighted baseline comparison", () => {
    const baseline = getCacheBaseline("claude-opus-4-8", "custom");
    if (!baseline) throw new Error("missing Opus 4.8 custom baseline");
    const rounds: CacheRound[] = [35, 77, 119, 161, 203].map((inputTokens, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens,
      outputTokens: 11,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      hitRate: null,
      evidence: false,
    }));
    const comparison = compareCacheBaseline(rounds, baseline);
    expect(comparison.baselineCostIndex).toBeCloseTo(10218.3, 1);
    expect(comparison.measuredCostIndex).toBe(870);
    expect(comparison.baselineMultiplier).toBe(0.085);
    expect(comparison.comparisonHitRate).toBe(0);
    expect(comparison.compatibilityScore).toBe(0);
    expect(comparison.rounds[0]).toMatchObject({ measuredWeighted: 90, multiplier: 0.012, cacheCreationDeltaPct: -100 });
  });

  it("does not calculate baseline compatibility from partial warm usage evidence", () => {
    const baseline = getCacheBaseline("claude-opus-4-8", "custom");
    if (!baseline) throw new Error("missing Opus 4.8 custom baseline");
    const rounds: CacheRound[] = baseline.map((round, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: round.input,
      outputTokens: round.output,
      cacheReadTokens: round.cacheRead,
      cacheCreationTokens: round.cacheCreation,
      hitRate: null,
      evidence: index < 4,
      evidenceFields: index < 4 ? ["cache_read_input_tokens", "cache_creation_input_tokens"] : [],
    }));
    const comparison = compareCacheBaseline(rounds, baseline);
    expect(comparison.comparisonHitRate).toBeNull();
    expect(comparison.compatibilityScore).toBeNull();
  });

  it("marks a canonical comparison that has only first-round usage as an explicit zero-read assumption", () => {
    const baseline = getCacheBaseline("claude-opus-4-8", "custom");
    if (!baseline) throw new Error("missing Opus 4.8 custom baseline");
    const rounds: CacheRound[] = baseline.map((round, index) => ({
      round: index + 1,
      latencyMs: 10,
      inputTokens: round.input,
      outputTokens: round.output,
      cacheReadTokens: index === 0 ? 0 : round.cacheRead,
      cacheCreationTokens: index === 0 ? round.cacheCreation : 0,
      hitRate: null,
      evidence: index === 0,
      evidenceFields: index === 0 ? ["cache_creation_input_tokens"] : [],
    }));
    const comparison = compareCacheBaseline(rounds, baseline);
    expect(comparison.comparisonHitRate).toBe(0);
    expect(comparison.compatibilityScore).toBe(0);
    expect(comparison.comparisonAssumption).toBe("missing_usage_treated_as_zero");
  });

  it("selects a separate Claude Code baseline after request-profile fallback", () => {
    const baseline = getCacheBaseline("claude-opus-4-8", "claude_code");
    expect(baseline?.[0]).toEqual({ input: 2, output: 18, cacheCreation: 31390, cacheRead: 0 });
    expect(getCacheBaselineInfo("claude-opus-4-8", "claude_code").requestProfile).toBe("claude_code");
  });

  it("records why a cache check was skipped", () => {
    const report = {
      ...summarizeCacheRounds([], false),
      reason: "protocol_not_supported" as const,
    };
    expect(report.applicable).toBe(false);
    expect(report.reason).toBe("protocol_not_supported");
  });
});
