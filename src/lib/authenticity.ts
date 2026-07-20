import type { EndpointMode } from "@/lib/probeProtocol";
import { modelIdsShareProfile, resolveModelProfileId } from "@/lib/models";
import { OFFICIAL_DEDICATED_MODELS, classifyClaudeFamily } from "../../shared/official-scoring.mjs";

export type AuthenticityVerdict = "verified" | "consistent" | "suspicious" | "unverifiable";
export type AuthenticityEvidenceLevel =
  | "provider-transport"
  | "cryptographic"
  | "behavioral"
  | "conflict"
  | "insufficient";
export type AuthenticityReason =
  | "official-direct"
  | "signature-verified"
  | "signature-partial"
  | "signature-conflict"
  | "identity-mismatch"
  | "stage-fingerprint-conflict"
  | "custom-profile-echo"
  | "dedicated-match"
  | "dedicated-fail"
  | "local-signature-only"
  | "image-only"
  | "unsupported-model"
  | "upstream-unavailable"
  | "insufficient-evidence";
export type VerifierScope = "dedicated" | "quality-only";
export type EvidenceSignalStatus = "pass" | "warning" | "fail";
export type SignatureVerdict = "PASS" | "PARTIAL" | "FAIL" | "FORGED" | "ERROR" | "UNKNOWN" | null;

export interface SignatureEvidence {
  verdict: SignatureVerdict;
  modelName: string | null;
  cryptographicallyVerified: boolean;
  /** High-confidence protobuf-envelope classification compatible with the public score formula. */
  formulaCompatible?: boolean;
  /** Complete no-channel envelope observed on the dedicated signature probe. */
  directEnvelope?: boolean;
  wireFormatPresent: boolean;
}

export interface AuthenticityAssessment {
  verdict: AuthenticityVerdict;
  evidenceLevel: AuthenticityEvidenceLevel;
  reason: AuthenticityReason;
  verifierScope: VerifierScope;
}

export interface AuthenticityAssessmentInput {
  /** The exact model ID sent to the upstream endpoint. */
  modelId: string;
  /** The built-in model profile whose dedicated suite was selected. */
  expectedModelId?: string;
  resultKind: "text" | "image";
  identityStatus: EvidenceSignalStatus;
  behavioralStatus: EvidenceSignalStatus;
  officialTransportVerified: boolean;
  signature: SignatureEvidence;
  /** The observable signature-envelope model family conflicts with the selected profile. */
  signatureFamilyConflict?: boolean;
  /** All evidence probes failed because the upstream was rate-limited or unavailable. */
  upstreamUnavailable?: boolean;
  /** At least one, but not all, evidence probes failed upstream. */
  upstreamPartiallyUnavailable?: boolean;
  /** The public stage fingerprint was the only failing profile signal. */
  stageIdentityOnlyConflict?: boolean;
  /** An explicit custom upstream ID was echoed and lowered the public profile score. */
  customProfileEchoConflict?: boolean;
}

export type OfficialProvider = "anthropic" | "openai" | "google";

export interface TransportProbeEvidence {
  upstreamStatus: number;
  finalUpstreamUrl: string | null;
  upstreamRedirected: boolean;
  mode: EndpointMode;
}

const DEDICATED_VERIFIER_MODELS = new Set(OFFICIAL_DEDICATED_MODELS);

const EXPECTED_SIGNATURE_FAMILIES: Record<string, string> = {
  "claude-fable-5": "fable-5",
  "claude-opus-4-8": "opus-4-8",
  "claude-opus-4-7": "opus-4-7",
  "claude-opus-4-6": "opus-4-6",
  "claude-sonnet-4-6": "sonnet-4-6",
  "claude-sonnet-5": "sonnet-5",
};

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function normalizeClaudeSignatureFamily(value: string | null): string | null {
  const family = classifyClaudeFamily(value);
  return family && family !== "non-claude" && family !== "other-claude" && family !== "unknown-claude-internal"
    ? family
    : null;
}

export function hasDedicatedVerifier(modelId: string): boolean {
  const profileId = resolveModelProfileId(modelId) ?? normalizeModelId(modelId);
  return DEDICATED_VERIFIER_MODELS.has(profileId);
}

export function signatureModelMatches(modelId: string, signatureModelName: string | null): boolean {
  const profileId = resolveModelProfileId(modelId) ?? normalizeModelId(modelId);
  const expected = EXPECTED_SIGNATURE_FAMILIES[profileId];
  return Boolean(expected && normalizeClaudeSignatureFamily(signatureModelName) === expected);
}

export function getOfficialEndpointProvider(rawUrl: string, mode: EndpointMode): OfficialProvider | null {
  try {
    const raw = rawUrl.trim();
    const normalizedUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (host === "api.anthropic.com" && mode === "anthropic") return "anthropic";
    if (host === "api.openai.com" && mode.startsWith("openai-")) return "openai";
    if (
      mode === "anthropic" &&
      /(?:^|[.-])aiplatform\.googleapis\.com$/i.test(host) &&
      /\/publishers\/anthropic\/models\//i.test(parsed.pathname)
    ) return "google";
    if (
      mode === "google-generative" &&
      (host === "generativelanguage.googleapis.com" || /(?:^|[.-])aiplatform\.googleapis\.com$/i.test(host))
    ) return "google";
    return null;
  } catch {
    return null;
  }
}

export function hasVerifiedOfficialTransport(
  requestedEndpoint: string,
  mode: EndpointMode,
  probes: readonly TransportProbeEvidence[],
): boolean {
  const provider = getOfficialEndpointProvider(requestedEndpoint, mode);
  if (!provider || probes.length === 0) return false;
  const hasSuccessfulProbe = probes.some((probe) => probe.upstreamStatus >= 200 && probe.upstreamStatus < 300);
  return hasSuccessfulProbe && probes.every((probe) =>
    probe.upstreamStatus >= 100 &&
    probe.upstreamStatus < 600 &&
    !probe.upstreamRedirected &&
    Boolean(probe.finalUpstreamUrl) &&
    getOfficialEndpointProvider(probe.finalUpstreamUrl ?? "", probe.mode) === provider,
  );
}

export function deriveAuthenticityAssessment(input: AuthenticityAssessmentInput): AuthenticityAssessment {
  const expectedModelId = input.expectedModelId?.trim() || input.modelId;
  const requestedModelMatchesProfile =
    normalizeModelId(input.modelId) === normalizeModelId(expectedModelId) ||
    modelIdsShareProfile(input.modelId, expectedModelId);
  // `expectedModelId` selects the probe profile. A custom upstream alias may
  // use that dedicated suite, but cannot inherit cryptographic model proof
  // unless the alias itself resolves to the same canonical profile.
  const verifierScope: VerifierScope = hasDedicatedVerifier(expectedModelId) ? "dedicated" : "quality-only";
  const signatureVerdict = input.signature.verdict;
  const signatureFailure =
    signatureVerdict === "FAIL" ||
    signatureVerdict === "FORGED" ||
    signatureVerdict === "ERROR";

  // An unavailable relay cannot produce identity or behavior evidence. Treating
  // empty/429 responses as a model conflict creates a false substitution claim.
  if (input.upstreamUnavailable) {
    return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "upstream-unavailable", verifierScope };
  }

  if (input.identityStatus === "fail") {
    return { verdict: "suspicious", evidenceLevel: "conflict", reason: "identity-mismatch", verifierScope };
  }

  if (signatureFailure) {
    return { verdict: "suspicious", evidenceLevel: "conflict", reason: "signature-conflict", verifierScope };
  }

  if (input.signatureFamilyConflict) {
    return { verdict: "suspicious", evidenceLevel: "conflict", reason: "signature-conflict", verifierScope };
  }

  // A partial outage makes the suite incomplete. Keep explicit identity or
  // signature conflicts above, but do not turn missing probes into a model
  // substitution verdict.
  if (input.upstreamPartiallyUnavailable) {
    return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "upstream-unavailable", verifierScope };
  }

  // The public verifier deliberately caps some Claude profiles at 34 when a
  // capability stage emits a signature_delta (or matches the legacy quote
  // fingerprint). Real adaptive-thinking routes can also produce this shape,
  // so the signal is useful for reproducibility but is not substitution proof.
  if (input.stageIdentityOnlyConflict) {
    return { verdict: "unverifiable", evidenceLevel: "behavioral", reason: "stage-fingerprint-conflict", verifierScope };
  }

  // The public formula compares response model fields with the canonical
  // profile ID. A relay that truthfully echoes the explicit custom request ID
  // can therefore lose compatibility points without contradicting the user.
  if (input.customProfileEchoConflict) {
    return { verdict: "unverifiable", evidenceLevel: "behavioral", reason: "custom-profile-echo", verifierScope };
  }

  // No dedicated verifier can authenticate a custom/unsupported model ID.
  // Preserve explicit conflicts, but do not let a provider hostname or a
  // passing generic behavior suite turn it into an identity claim.
  if (verifierScope === "quality-only" && input.resultKind !== "image") {
    return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "unsupported-model", verifierScope };
  }

  const signatureMatches = signatureModelMatches(expectedModelId, input.signature.modelName);
  if (
    input.signature.cryptographicallyVerified &&
    (signatureVerdict === "PASS" || signatureVerdict === "PARTIAL") &&
    Boolean(input.signature.modelName) &&
    !signatureMatches
  ) {
    return { verdict: "suspicious", evidenceLevel: "conflict", reason: "signature-conflict", verifierScope };
  }

  // A provider hostname proves where the request terminated, not which model
  // generated the response. Keep this below identity and behavior conflicts,
  // and never promote transport evidence to a cryptographic verdict.
  if (verifierScope === "dedicated" && input.behavioralStatus === "fail") {
    return { verdict: "unverifiable", evidenceLevel: "behavioral", reason: "dedicated-fail", verifierScope };
  }

  if (requestedModelMatchesProfile && input.signature.cryptographicallyVerified && signatureVerdict === "PASS" && signatureMatches) {
    return { verdict: "verified", evidenceLevel: "cryptographic", reason: "signature-verified", verifierScope };
  }

  if (requestedModelMatchesProfile && input.signature.cryptographicallyVerified && signatureVerdict === "PARTIAL" && signatureMatches) {
    return { verdict: "consistent", evidenceLevel: "cryptographic", reason: "signature-partial", verifierScope };
  }

  if (input.resultKind === "image") {
    return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "image-only", verifierScope };
  }

  if (verifierScope === "quality-only") {
    return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "unsupported-model", verifierScope };
  }

  if (input.officialTransportVerified && input.identityStatus === "pass") {
    return { verdict: "consistent", evidenceLevel: "provider-transport", reason: "official-direct", verifierScope };
  }

  if (input.identityStatus === "pass" && input.behavioralStatus === "pass") {
    return { verdict: "consistent", evidenceLevel: "behavioral", reason: "dedicated-match", verifierScope };
  }

  // A passing behavior suite without an upstream model identity is not model
  // authentication: a relay can replay or emulate the same answers.
  if (input.identityStatus !== "pass") {
    return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "insufficient-evidence", verifierScope };
  }

  if (input.behavioralStatus === "fail") {
    return { verdict: "unverifiable", evidenceLevel: "behavioral", reason: "dedicated-fail", verifierScope };
  }

  if (input.signature.wireFormatPresent && !input.signature.cryptographicallyVerified) {
    return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "local-signature-only", verifierScope };
  }

  return { verdict: "unverifiable", evidenceLevel: "insufficient", reason: "insufficient-evidence", verifierScope };
}
