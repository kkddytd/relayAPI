import { describe, expect, it } from "vitest";
import {
  deriveAuthenticityAssessment,
  getOfficialEndpointProvider,
  hasVerifiedOfficialTransport,
  hasDedicatedVerifier,
  signatureModelMatches,
  type AuthenticityAssessmentInput,
} from "@/lib/authenticity";

const baseInput: AuthenticityAssessmentInput = {
  modelId: "gpt-5.5",
  resultKind: "text",
  identityStatus: "pass",
  behavioralStatus: "pass",
  officialTransportVerified: false,
  signature: {
    verdict: null,
    modelName: null,
    cryptographicallyVerified: false,
    wireFormatPresent: false,
  },
};

describe("independent authenticity verdict", () => {
  it("keeps unsupported models unverifiable even with perfect behavior and a matching model field", () => {
    for (const modelId of ["gpt-5.6", "gpt-5.6-luna", "glm-5.2", "vendor/private-model-v9"]) {
      const result = deriveAuthenticityAssessment({ ...baseInput, modelId });
      expect(result.verdict, modelId).toBe("unverifiable");
      expect(result.verifierScope, modelId).toBe("quality-only");
      expect(result.reason, modelId).toBe("unsupported-model");
    }
  });

  it("never treats a local Base64-shaped signature as cryptographic proof", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      behavioralStatus: "warning",
      signature: {
        verdict: "PARTIAL",
        modelName: null,
        cryptographicallyVerified: false,
        wireFormatPresent: true,
      },
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toBe("local-signature-only");
  });

  it("treats a complete envelope model-family mismatch as a structural conflict", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      signatureFamilyConflict: true,
      signature: {
        verdict: "PASS",
        modelName: "claude-sonnet-5",
        cryptographicallyVerified: false,
        formulaCompatible: true,
        wireFormatPresent: true,
      },
    });
    expect(result).toMatchObject({
      verdict: "suspicious",
      evidenceLevel: "conflict",
      reason: "signature-conflict",
    });
  });

  it("marks an explicit model mismatch as suspicious regardless of capability score", () => {
    const result = deriveAuthenticityAssessment({ ...baseInput, identityStatus: "fail" });
    expect(result.verdict).toBe("suspicious");
    expect(result.reason).toBe("identity-mismatch");
  });

  it("does not turn an upstream outage into a substitution verdict", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-fable-5",
      identityStatus: "fail",
      behavioralStatus: "fail",
      upstreamUnavailable: true,
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toBe("upstream-unavailable");
    expect(result.evidenceLevel).toBe("insufficient");
  });

  it("does not score an incomplete probe suite as a substitution", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      behavioralStatus: "fail",
      upstreamPartiallyUnavailable: true,
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toBe("upstream-unavailable");
  });

  it("keeps quality-only custom IDs unavailable when one probe is rate-limited", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "vendor/private-model-v9",
      behavioralStatus: "fail",
      upstreamPartiallyUnavailable: true,
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toBe("upstream-unavailable");
  });

  it("uses the dedicated models implemented by the current public verifier", () => {
    expect(hasDedicatedVerifier("gpt-5.5")).toBe(true);
    expect(hasDedicatedVerifier("claude-fable-5")).toBe(true);
    expect(hasDedicatedVerifier("claude-5-fable")).toBe(true);
    expect(hasDedicatedVerifier("gemini-3.1-pro-preview")).toBe(true);
    expect(hasDedicatedVerifier("gpt-5.6-sol")).toBe(true);
    expect(hasDedicatedVerifier("gpt-5.6-terra")).toBe(true);
    expect(hasDedicatedVerifier("claude-sonnet-5")).toBe(true);
    expect(hasDedicatedVerifier("gpt-5.6")).toBe(false);
    expect(hasDedicatedVerifier("gpt-image-2")).toBe(false);
  });

  it("requires an exact HTTPS official hostname for provider transport evidence", () => {
    expect(getOfficialEndpointProvider("https://api.openai.com/v1", "openai-chat")).toBe("openai");
    expect(getOfficialEndpointProvider("api.openai.com/v1", "openai-chat")).toBe("openai");
    expect(getOfficialEndpointProvider("https://api.anthropic.com", "anthropic")).toBe("anthropic");
    expect(getOfficialEndpointProvider("https://generativelanguage.googleapis.com/v1beta", "google-generative")).toBe("google");
    expect(getOfficialEndpointProvider("https://us-central1-aiplatform.googleapis.com/v1/projects/demo", "google-generative")).toBe("google");
    expect(getOfficialEndpointProvider("https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/claude-opus-4-8:rawPredict", "anthropic")).toBe("google");
    expect(getOfficialEndpointProvider("https://api.openai.com.evil.example/v1", "openai-chat")).toBeNull();
    expect(getOfficialEndpointProvider("http://api.openai.com/v1", "openai-chat")).toBeNull();
    expect(getOfficialEndpointProvider("https://user@api.openai.com/v1", "openai-chat")).toBeNull();
  });

  it("accepts an expected 4xx from the same official host but rejects redirects and mixed hosts", () => {
    const medium = {
      upstreamStatus: 200,
      finalUpstreamUrl: "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
      upstreamRedirected: false,
      mode: "google-generative" as const,
    };
    const expectedMinimalError = { ...medium, upstreamStatus: 400 };
    expect(hasVerifiedOfficialTransport(
      "https://generativelanguage.googleapis.com",
      "google-generative",
      [medium, expectedMinimalError],
    )).toBe(true);
    expect(hasVerifiedOfficialTransport(
      "https://generativelanguage.googleapis.com",
      "google-generative",
      [medium, { ...expectedMinimalError, upstreamRedirected: true }],
    )).toBe(false);
    expect(hasVerifiedOfficialTransport(
      "https://generativelanguage.googleapis.com",
      "google-generative",
      [medium, { ...expectedMinimalError, finalUpstreamUrl: "https://relay.example/v1" }],
    )).toBe(false);
  });

  it("does not let official transport turn a failed behavior suite into a substitution claim", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "gpt-5.6-sol",
      behavioralStatus: "fail",
      officialTransportVerified: true,
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.evidenceLevel).toBe("behavioral");
    expect(result.reason).toBe("dedicated-fail");

    const consistent = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      officialTransportVerified: true,
    });
    expect(consistent.verdict).toBe("consistent");
    expect(consistent.evidenceLevel).toBe("provider-transport");
  });

  it("does not accept dedicated behavior as identity proof when the upstream omits model", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      identityStatus: "warning",
      behavioralStatus: "pass",
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toBe("insufficient-evidence");
  });

  it("uses the explicitly selected dedicated profile without treating it as cryptographic proof", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "vendor/private-opus-v9",
      expectedModelId: "claude-opus-4-8",
      behavioralStatus: "pass",
    });
    expect(result.verdict).toBe("consistent");
    expect(result.verifierScope).toBe("dedicated");
    expect(result.evidenceLevel).toBe("behavioral");
  });

  it("does not auto-resolve a namespaced ID, while an explicit profile still controls the probes", () => {
    expect(hasDedicatedVerifier("vendor/claude-opus-4-8")).toBe(false);
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "vendor/claude-opus-4-8",
      expectedModelId: "claude-opus-4-8",
      behavioralStatus: "pass",
    });
    expect(result.verdict).toBe("consistent");
    expect(result.verifierScope).toBe("dedicated");
  });

  it("does not promote an unrelated custom request ID to a cryptographic verdict", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "vendor/private-opus-v9",
      expectedModelId: "claude-opus-4-8",
      signature: {
        verdict: "PASS",
        modelName: "claude-opus-4-8",
        cryptographicallyVerified: true,
        wireFormatPresent: true,
      },
    });
    expect(result.verdict).toBe("consistent");
    expect(result.verifierScope).toBe("dedicated");
    expect(result.evidenceLevel).toBe("behavioral");
  });

  it("keeps a low dedicated behavior score separate from explicit identity conflicts", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      behavioralStatus: "fail",
      officialTransportVerified: true,
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.evidenceLevel).toBe("behavioral");
    expect(result.reason).toBe("dedicated-fail");
  });

  it("keeps a stage-only public fingerprint cap separate from substitution claims", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      behavioralStatus: "fail",
      stageIdentityOnlyConflict: true,
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.evidenceLevel).toBe("behavioral");
    expect(result.reason).toBe("stage-fingerprint-conflict");
  });

  it("does not let the stage-only label hide an explicit model mismatch", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      identityStatus: "fail",
      behavioralStatus: "fail",
      stageIdentityOnlyConflict: true,
    });
    expect(result.verdict).toBe("suspicious");
    expect(result.reason).toBe("identity-mismatch");
  });

  it("separates a custom model echo penalty from substitution evidence", () => {
    const result = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "vendor-sol-v9",
      expectedModelId: "gpt-5.6-sol",
      behavioralStatus: "fail",
      customProfileEchoConflict: true,
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.evidenceLevel).toBe("behavioral");
    expect(result.reason).toBe("custom-profile-echo");
  });

  it("requires a cryptographically verified PASS and matching signature family", () => {
    expect(signatureModelMatches("claude-opus-4-8", "claude_opus_4_8")).toBe(true);
    const verified = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      signature: {
        verdict: "PASS",
        modelName: "claude-opus-4-8",
        cryptographicallyVerified: true,
        wireFormatPresent: true,
      },
    });
    expect(verified.verdict).toBe("verified");
    expect(verified.reason).toBe("signature-verified");

    const partial = deriveAuthenticityAssessment({
      ...baseInput,
      modelId: "claude-opus-4-8",
      signature: {
        verdict: "PARTIAL",
        modelName: "opus-4-8",
        cryptographicallyVerified: true,
        wireFormatPresent: true,
      },
    });
    expect(partial.verdict).toBe("consistent");
    expect(partial.reason).toBe("signature-partial");
  });
});
