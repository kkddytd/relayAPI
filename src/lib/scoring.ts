import type { AuthenticityStrategy, EvaluationGrades, EvaluationProfile } from "@/lib/evaluation";

export type SignalStatus = "pass" | "warning" | "fail";
export type AuthenticitySignal = "knowledge" | "identity" | "protocol" | "structure" | "thinking" | "signature";

export interface AuthenticitySignals {
  knowledge: SignalStatus;
  identity: SignalStatus;
  protocol: SignalStatus;
  structure: SignalStatus;
  thinking: SignalStatus;
  signature: SignalStatus;
}

export interface ScoreContribution {
  signal: AuthenticitySignal;
  status: SignalStatus;
  weight: number;
  awarded: number;
}

export interface AuthenticityScoreResult {
  score: number;
  contributions: ScoreContribution[];
}

const AUTHENTICITY_WEIGHTS: Record<AuthenticityStrategy, Partial<Record<AuthenticitySignal, number>>> = {
  // Compatibility weighting retained from the archived reference implementation.
  gpt: { knowledge: 60, identity: 20, protocol: 8, structure: 12 },
  "claude-modern": { knowledge: 20, identity: 20, protocol: 15, structure: 10, thinking: 15, signature: 20 },
  "claude-legacy": { knowledge: 20, identity: 20, protocol: 15, structure: 10, thinking: 15, signature: 20 },
  fable: { knowledge: 20, identity: 20, protocol: 15, structure: 10, thinking: 15, signature: 20 },
  "openai-compatible": { knowledge: 35, identity: 25, protocol: 18, structure: 22 },
};

function statusRatio(status: SignalStatus): number {
  if (status === "pass") return 1;
  if (status === "warning") return 0.5;
  return 0;
}

export function calculateCapabilityScore(grades: EvaluationGrades, profile?: EvaluationProfile): number {
  const weights = profile?.capabilityWeights ?? {
    reasoning: 24,
    coding: 22,
    instruction: 20,
    chinese: 16,
    memory: 18,
  };
  return Object.entries(weights).reduce((score, [dimension, weight]) => {
    return score + (grades[dimension as keyof typeof weights] ? weight : 0);
  }, 0);
}

export function calculateAuthenticityScore(
  profile: EvaluationProfile,
  signals: AuthenticitySignals,
): AuthenticityScoreResult {
  const weights = AUTHENTICITY_WEIGHTS[profile.authenticityStrategy];
  const contributions = Object.entries(weights).map(([signal, weight]) => {
    const typedSignal = signal as AuthenticitySignal;
    const typedWeight = weight ?? 0;
    return {
      signal: typedSignal,
      status: signals[typedSignal],
      weight: typedWeight,
      awarded: Math.round(typedWeight * statusRatio(signals[typedSignal])),
    };
  });

  let score = contributions.reduce((total, contribution) => total + contribution.awarded, 0);

  // These caps are part of the signal interpretation, not a claim of cryptographic proof.
  if (profile.authenticityStrategy === "gpt") {
    if (signals.knowledge === "fail") score = Math.min(score, 59);
    if (signals.identity !== "pass") score = Math.min(score, 64);
  } else if ((profile.authenticityStrategy.startsWith("claude") || profile.authenticityStrategy === "fable") && signals.identity === "fail") {
    score = Math.min(score, 49);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), contributions };
}
