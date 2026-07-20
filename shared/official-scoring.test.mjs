import { describe, expect, it } from "vitest";
import {
  OFFICIAL_CLAUDE_PROBE_HEADERS,
  OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID,
  OFFICIAL_SCORING_REFERENCE,
  officialGptModelMismatch,
  officialPassThreshold,
  scoreClaudeCompatibility,
  scoreGeminiCompatibility,
  scoreGptCompatibility,
} from "./official-scoring.mjs";

describe("current public scoring reference", () => {
  it("pins both the score bundle and probe constants bundle", () => {
    expect(OFFICIAL_SCORING_REFERENCE).toMatchObject({
      bundle: "shareReport-B_FOiUEI.js",
      bundleSha256: "02593b4301418722cbd19200822a87a05f041314504f07f0e37aebab415267e8",
      probeConstantsBundle: "probe-constants-YXB5_aNC.js",
      probeConstantsSha256: "ec057d221fa24d106fb64ccbc5914ae04fedb1b6f7f602fe15833768bbb41bcf",
    });
    expect(JSON.parse(OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID)).toMatchObject({
      device_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      account_uuid: expect.any(String),
      session_id: expect.any(String),
    });
    expect(OFFICIAL_CLAUDE_PROBE_HEADERS).toEqual({
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
  });
});

const fullHints = {
  hasModel: true,
  hasRole: true,
  hasContentArray: true,
  hasUsage: true,
  hasStopReason: true,
};

function claudeProbe(overrides = {}) {
  return {
    protocolHints: fullHints,
    parseOk: true,
    upstreamMessageId: "msg_abcdefghijklmnopqrstuvwxyz",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    rawSseEventCount: 0,
    sseEventTypes: [],
    streamMessageStartModel: null,
    streamMessageStartInputTokens: null,
    streamMessageDeltaInputTokensSamples: [],
    streamOutputTokensSamples: [],
    emptySignatureDeltaCount: 0,
    contentTypes: ["text"],
    responseText: "OK",
    ...overrides,
  };
}

describe("current public Claude compatibility formula", () => {
  it("reconstructs the public 77-point Bedrock-style Opus result", () => {
    const probes = [
      claudeProbe({ upstreamMessageId: "msg_bdrk_example1234567890" }),
      claudeProbe({ contentTypes: ["thinking", "text"] }),
      claudeProbe({ protocolHints: { hasModel: false, hasRole: false, hasContentArray: false, hasUsage: false, hasStopReason: false } }),
      claudeProbe(),
    ];
    const result = scoreClaudeCompatibility({
      variant: "frontier",
      probes,
      expectedFamily: "opus-4-8",
      upstreamModelId: "claude-opus-4-8",
      signature: { verdict: "PARTIAL", sigModelName: null },
      knowledgePassed: true,
      pdfExecuted: true,
      pdfPass: true,
      calcExecuted: true,
      calcJsonLegal: false,
      calcResultCorrect: false,
      mainStageSignatureDeltaSum: 0,
    });
    expect(result.score).toBe(77);
    expect(result.penalties).toMatchObject({ signature: 4, protocol: 3, structuredOutput: 12, messageId: 4 });
  });

  it("keeps the standard-Claude thinking penalty and Sonnet 5 quote exemption", () => {
    const base = {
      variant: "standard",
      probes: [claudeProbe()],
      upstreamModelId: "claude-sonnet-5",
      signature: { verdict: "PASS", sigModelName: "claude-sonnet-5" },
      knowledgePassed: true,
      pdfExecuted: true,
      pdfPass: true,
      calcExecuted: true,
      calcJsonLegal: true,
      calcResultCorrect: true,
      rightQuoteCount: 1,
    };
    expect(scoreClaudeCompatibility({ ...base, expectedFamily: "sonnet-5" }).score).toBe(92);
    expect(scoreClaudeCompatibility({ ...base, expectedFamily: "sonnet-4-6", upstreamModelId: "claude-sonnet-4-6", signature: { verdict: "PASS", sigModelName: "claude-sonnet-4-6" } }).score).toBe(34);
  });

  it("scores every dedicated Claude family from the same signal formula", () => {
    const profiles = [
      { family: "fable-5", variant: "frontier", modelFeaturePass: true },
      { family: "opus-4-8", variant: "frontier" },
      { family: "opus-4-7", variant: "frontier" },
      { family: "opus-4-6", variant: "standard" },
      { family: "sonnet-4-6", variant: "standard" },
      { family: "sonnet-5", variant: "standard" },
    ];

    for (const profile of profiles) {
      const model = `claude-${profile.family}`;
      const result = scoreClaudeCompatibility({
        variant: profile.variant,
        probes: [claudeProbe({ contentTypes: ["thinking", "text"] })],
        expectedFamily: profile.family,
        upstreamModelId: model,
        signature: { verdict: "PASS", sigModelName: model },
        knowledgePassed: true,
        pdfExecuted: true,
        pdfPass: true,
        calcExecuted: true,
        calcJsonLegal: true,
        calcResultCorrect: true,
        modelFeaturePass: profile.modelFeaturePass,
      });
      expect(result.score, profile.family).toBe(100);
    }
  });

  it("applies the frontier thinking-characteristic penalty when no thinking block is observed", () => {
    const result = scoreClaudeCompatibility({
      variant: "frontier",
      probes: [claudeProbe({ contentTypes: ["text"] })],
      expectedFamily: "opus-4-8",
      upstreamModelId: "claude-opus-4-8",
      signature: { verdict: "PASS", sigModelName: "claude-opus-4-8" },
      knowledgePassed: true,
      pdfExecuted: true,
      pdfPass: true,
      calcExecuted: true,
      calcJsonLegal: true,
      calcResultCorrect: true,
    });
    expect(result.score).toBe(92);
    expect(result.penalties.thinking).toBe(8);
  });

  it("treats an internal Claude signature model name as unknown rather than a substitution", () => {
    const result = scoreClaudeCompatibility({
      variant: "frontier",
      probes: [claudeProbe({ contentTypes: ["thinking", "text"] })],
      expectedFamily: "opus-4-8",
      upstreamModelId: "claude-opus-4-8",
      signature: { verdict: "PASS", sigModelName: "claude-quince" },
      knowledgePassed: true,
      pdfExecuted: true,
      pdfPass: true,
      calcExecuted: true,
      calcJsonLegal: true,
      calcResultCorrect: true,
    });
    expect(result.score).toBe(98);
    expect(result.penalties.signature).toBe(2);
    expect(result.familyConflict).toBe(false);
  });

  it("does not cap a complete direct-envelope frontier run when a capability stage emits thinking", () => {
    const base = {
      variant: "frontier",
      probes: [claudeProbe({ contentTypes: ["thinking", "text"] })],
      expectedFamily: "opus-4-8",
      upstreamModelId: "claude-opus-4-8",
      signature: { verdict: "PASS", sigModelName: "claude-opus-4-8" },
      knowledgePassed: true,
      pdfExecuted: true,
      pdfPass: true,
      calcExecuted: true,
      calcJsonLegal: true,
      calcResultCorrect: true,
      mainStageSignatureDeltaSum: 900,
    };
    expect(scoreClaudeCompatibility(base).score).toBe(34);
    const normalized = scoreClaudeCompatibility({ ...base, suppressStageSignatureCap: true });
    expect(normalized.score).toBe(100);
    expect(normalized.stageConflict).toBe(false);
  });

});

describe("current public GPT compatibility formula", () => {
  it("uses the family-specific public pass thresholds", () => {
    expect(officialPassThreshold("gpt-5.5")).toBe(70);
    expect(officialPassThreshold("gpt-5.6-sol")).toBe(70);
    expect(officialPassThreshold("gemini-3.1-pro-preview")).toBe(70);
    expect(officialPassThreshold("claude-opus-4-8")).toBe(60);
  });
  it("requires a reported variant for GPT 5.6 Sol/Terra but not GPT 5.4/5.5", () => {
    expect(officialGptModelMismatch("gpt-5.6-sol", null)).toBe(true);
    expect(officialGptModelMismatch("gpt-5.5", null)).toBe(false);
    expect(officialGptModelMismatch("gpt-5.6-sol", "gpt-5.6-terra-20260715")).toBe(true);
  });

  it("scores supported GPT models and rejects unsupported profiles", () => {
    expect(scoreGptCompatibility({
      algorithmModel: "gpt-5.5",
      reportedModel: null,
      quizStatus: "pass",
      protocolStatus: "pass",
      responseStructureStatus: "pass",
    }).score).toBe(100);
    expect(scoreGptCompatibility({
      algorithmModel: "gpt-5.6-sol",
      reportedModel: null,
      quizStatus: "pass",
      protocolStatus: "fail",
      responseStructureStatus: "pass",
    }).score).toBe(64);
    expect(scoreGptCompatibility({
      algorithmModel: "gpt-5.6-luna",
      reportedModel: "gpt-5.6-luna",
      quizStatus: "pass",
      protocolStatus: "pass",
      responseStructureStatus: "pass",
    })).toMatchObject({ supported: false, score: null });
  });

  it("applies the same public GPT formula to every dedicated GPT profile", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4"]) {
      expect(scoreGptCompatibility({
        algorithmModel: model,
        reportedModel: model,
        quizStatus: "pass",
        protocolStatus: "pass",
        responseStructureStatus: "pass",
      }), model).toMatchObject({ supported: true, score: 100, mismatch: false });
    }
  });
});

describe("current public Gemini compatibility formula", () => {
  it("applies the fallback token and latency penalties", () => {
    expect(scoreGeminiCompatibility({ mediumStatus: "pass", variantStatus: "pass", protocolStatus: "pass", responseStructureStatus: "pass" })).toBe(100);
    expect(scoreGeminiCompatibility({
      mediumStatus: "pass",
      variantStatus: "pass",
      protocolStatus: "pass",
      responseStructureStatus: "pass",
      usedFallbackChallenge: true,
      fallbackTokenCount: 4000,
      fallbackLatencyMs: 60000,
    })).toBe(75);
  });
});
