/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, CheckCircle2, CircleHelp, Info, ShieldCheck, Square, Zap } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { ApiConfig } from "@/components/ApiConfig";
import { ModelSelector } from "@/components/ModelSelector";
import { DetectionChecklist, type CheckItem } from "@/components/DetectionChecklist";
import { HistoryLog, type HistoryEntry } from "@/components/HistoryLog";
import { ScanningOverlay } from "@/components/ScanningOverlay";
import { CacheReportPanel } from "@/components/CacheReportPanel";
import { AttachmentUpload } from "@/components/AttachmentUpload";
import { AttachmentAnalysisPanel } from "@/components/AttachmentAnalysisPanel";
import { useI18n } from "@/i18n";
import type { I18nMessages } from "@/i18n/types";
import { getModelDisplayName, resolveModelProfileId } from "@/lib/models";
import type { ApiProtocol } from "@/lib/apiProtocol";
import { modelMatchesRequested, resolveEndpoint, type EndpointMode } from "@/lib/probeProtocol";
import { detectChannelEvidence, type ChannelEvidence } from "@/lib/channelEvidence";
import {
  createEvaluationSuite,
  createEvaluationSeed,
  createGptQuizPrompt,
  createLivenessPrompt,
  gradeEvaluation,
  knowledgeAnswerMatches,
  type EvaluationGrades,
  type EvaluationSuite,
} from "@/lib/evaluation";
import {
  canRunCacheObservation,
  calculateCacheHitRate,
  compareCacheBaseline,
  extractCacheUsage,
  getCacheBaselineInfo,
  hasOfficialComparableCacheBaseline,
  summarizeCacheRounds,
  type CacheRequestProfile,
  type CacheReport,
  type CacheRound,
  type CacheRunReport,
} from "@/lib/cache";
import {
  calculateAuthenticityScore,
  calculateCapabilityScore,
  type AuthenticitySignals,
} from "@/lib/scoring";
import {
  createLiveKnowledgePrompt,
  gradeLiveKnowledge,
  isLiveKnowledgeSnapshot,
  liveKnowledgeGradePasses,
  type LiveKnowledgeGrade,
  type LiveKnowledgeSnapshot,
} from "@/lib/liveKnowledge";
import {
  deriveAuthenticityAssessment,
  hasDedicatedVerifier,
  hasVerifiedOfficialTransport,
  type AuthenticityAssessment,
  type AuthenticityEvidenceLevel,
  type AuthenticityReason,
  type AuthenticityVerdict,
  type EvidenceSignalStatus,
  type SignatureEvidence,
  type VerifierScope,
} from "@/lib/authenticity";
import {
  isUpstreamUnavailable,
  summarizeUpstreamAvailability,
  type UpstreamAvailabilityKind,
  type UpstreamAvailabilitySummary,
} from "@/lib/upstream";
import { toast } from "sonner";
import type { AttachmentAnalysisReport, AttachmentDraft, UploadedAttachment } from "@/lib/attachments";
import { createRandomBytes, createUuid } from "@/lib/random";
import cacheProbeTemplate from "../../shared/cache-probe-custom.json";
import cacheClaudeCodeTemplate from "../../shared/cache-probe-claude-code.json";
import {
  OFFICIAL_CLAUDE_PROBE_HEADERS,
  OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID,
  claudeSignaturePenalty,
  classifyClaudeFamily,
  expectedClaudeFamily,
  normalizeOpenAiTokenUsage,
  officialPassThreshold,
  scoreClaudeCompatibility,
  scoreGeminiCompatibility,
  scoreGptCompatibility,
} from "../../shared/official-scoring.mjs";
import {
  DEFAULT_CACHE_ROUND_DELAY_MS,
  DEFAULT_CACHE_REQUEST_TIMEOUT_MS,
  DEFAULT_DETECTION_PHASE_DELAY_MS,
  retryDelayMs,
} from "../../shared/request-pacing.mjs";
import {
  buildOpenAiChatProbeBody,
  buildOpenAiResponsesProbeBody,
} from "../../shared/openai-probe-request.mjs";

interface DetectionResult {
  id: string;
  score: number | null;
  kind: "text" | "image";
  profileId: string;
  capabilityScore: number | null;
  authenticityScore: number | null;
  authenticity: AuthenticityAssessment;
  checks: CheckItem[];
  latency: number;
  tps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReport?: CacheReport;
  channelEvidence: ChannelEvidence;
  liveKnowledge?: LiveKnowledgeReport;
  upstreamAvailability?: UpstreamAvailabilitySummary;
  scoreBreakdown?: PrivateSignatureScoreBreakdown;
  attachmentAnalysis?: AttachmentAnalysisReport;
}

interface LiveKnowledgeReport {
  status: "passed" | "failed" | "no-live-access" | "unavailable" | "upstream-unavailable" | "skipped";
  snapshot: LiveKnowledgeSnapshot | null;
  grade: LiveKnowledgeGrade | null;
  upstreamStatus?: number;
  reason?: string;
  error?: string;
}

interface AttachmentRequestSpec {
  id: string;
  mode: "understand" | "verify";
  instruction?: string;
  expected_intent?: string;
}

type CheckStatus = "pass" | "warning" | "fail";

interface FamilyCheckAssessment {
  checks: CheckItem[];
  score: number;
  capabilityScore: number;
  authenticityScore: number;
  behavioralStatus: EvidenceSignalStatus;
  signatureEvidence?: SignatureEvidence;
  familyConflict: boolean;
  stageIdentityOnlyConflict: boolean;
  customProfileEchoConflict: boolean;
  scoreBreakdown?: PrivateSignatureScoreBreakdown;
}

interface PrivateSignatureScoreBreakdown {
  publicObservableScore: number;
  privateSignatureAdjustment: number;
  privateSignatureStatus: "verified" | "envelope_compatible" | "unavailable" | "not_observed";
}

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
      action?: string;
      size?: "normal" | "compact" | "flexible";
    }
  ) => string | number;
  reset: (widgetId?: string | number) => void;
  remove?: (widgetId?: string | number) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface ProbeResult {
  prompt: string;
  responseText: string;
  payload: unknown;
  latencyMs: number;
  firstTokenLatencyMs: number | null;
  tps: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheHit: boolean;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheEvidenceFields: string[];
  signatureDeltaTotalLength: number;
  signatureDeltaCount: number;
  signatureEmptyCount: number;
  signatureIsValidBase64: boolean | null;
  signatureVerdict: "PASS" | "PARTIAL" | "FAIL" | "FORGED" | "ERROR" | "UNKNOWN" | null;
  signatureCompatibilityVerdict: "PASS" | "PARTIAL" | "FAIL" | "FORGED" | "ERROR" | "UNKNOWN" | null;
  signatureCompatibilityReason: string | null;
  signatureFormulaCompatible: boolean;
  sigModelName: string | null;
  signatureEnvelopeModel: string | null;
  signatureEnvelopeMatchesRequested: boolean;
  signatureEnvelopeChannelPresent: boolean;
  signatureEnvelopeChannelValue: number | null;
  signatureEnvelopeVersion: number | null;
  signatureEnvelopeKeyVersion: number | null;
  signatureEnvelopeSchemaVersion: number | null;
  signatureEnvelopeVariant: number | null;
  signatureEnvelopePayloadType: string | null;
  signatureEnvelopeSessionId: string | null;
  signatureEnvelopeEncryptedPayloadBytes: number | null;
  signatureFormat: string | null;
  signatureStructureIssues: string[];
  signatureReason: string | null;
  signatureStructurallyParsed: boolean;
  signatureCryptographicallyVerified: boolean;
  payloadMessageId: string | null;
  messageId: string | null;
  streamMessageStartModel: string | null;
  sseEventTypes: string[];
  rawSseEventCount: number;
  upstreamStatus: number;
  finalUpstreamUrl: string | null;
  upstreamRedirected: boolean;
  responseHeaders: Record<string, string>;
  requestCompatibilityFallbacks: string[];
  errorMessage: string | null;
  streamMessageStartInputTokens: number | null;
  streamMessageDeltaInputTokensSamples: number[];
  streamOutputTokensSamples: number[];
  contentTypes: string[];
  jsonParseOk: boolean;
  parseOk: boolean;
  mode: EndpointMode;
  reportedModel: string | null;
  protocolHints: {
    hasModel: boolean;
    hasRole: boolean;
    hasContentArray: boolean;
    hasUsage: boolean;
    hasStopReason: boolean;
  };
}

interface ImageProbeResult {
  hasDataArray: boolean;
  hasImage: boolean;
  imageValueLength: number;
  imageFormatValid: boolean;
  revisedPrompt: string | null;
}

type CacheProbeStage = `cachecheck-r${0 | 1 | 2 | 3 | 4}`;

type ProbeStage =
  | "stage1"
  | "stage2"
  | "stage3"
  | "stage5-calc"
  | "image"
  | "extra"
  | "cache"
  | CacheProbeStage
  | "gemini-medium"
  | "gemini-minimal"
  | "gemini-challenge"
  | "gpt-quiz"
  | "liveness"
  | "live-knowledge"
  | "opus47-knowledge"
  | "opus47-pdf-dynamic"
  | "opus47-calc"
  | "opus47-sig"
  | "fable5-model-feature";

interface PublicErrorInfo {
  title: string;
  detail: string;
  source: "upstream" | "system";
  stage?: ProbeStage;
  statusCode?: number;
  retryAfterMs?: number;
}

class UserVisibleError extends Error {
  info: PublicErrorInfo;

  constructor(info: PublicErrorInfo) {
    super(info.title);
    this.name = "UserVisibleError";
    this.info = info;
  }
}

const IMAGE_PROBE_PROMPT =
  "A small centered green circle on a plain white background, flat vector style, no text.";
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const LOCAL_DETECTION_MODE = !TURNSTILE_SITE_KEY;
const PROBE_MAX_TOKENS = 10240;
const PROBE_THINKING_BUDGET = 4096;
const OPENAI_PROBE_MAX_OUTPUT_TOKENS = 10240;
// The public verifier uses normal Gemini sampling for the medium/minimal
// thinking probes. The challenge probe overrides temperature and topP below.
const GEMINI_GENERATION_CONFIG = { temperature: 0.7, maxOutputTokens: 2048, topP: 0.95 };
const OFFICIAL_CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_BILLING_HEADER = "x-anthropic-billing-header: cc_version=2.1.165; cc_entrypoint=cli; cch=3f806;";
const CACHE_PROBE_TEMPLATE_VERSION = cacheProbeTemplate.version;
const CLAUDE_CODE_CACHE_TEMPLATE_VERSION = cacheClaudeCodeTemplate.version;
const CACHECHECK_SYSTEM_SUFFIX = `[cachecheck mode]
This is an automated prompt-cache probe. Do NOT call any tools.
Reply with exactly one short sentence in plain text. No tool_use, no lists, no markdown.`;
const HISTORY_STORAGE_KEY = "api-verifier-history-v1";
const HISTORY_LIMIT = 10;
const SITE_URL = typeof window !== "undefined" ? new URL("/", window.location.origin).toString() : "/";
const OG_IMAGE_URL = typeof window !== "undefined" ? new URL("/og-image.svg", window.location.origin).toString() : "/og-image.svg";
let cacheRunSequence = Math.floor(Math.random() * 36 ** 3);

type CacheProbeTemplate = {
  version: string;
  system: string | Array<{ type?: string; text?: string; cache_control?: { type: string } }>;
  tools: Array<Record<string, unknown>>;
  metadataUserId?: string;
  userMessagePrefixes?: string[];
};

const cacheTemplates: Record<CacheRequestProfile, CacheProbeTemplate> = {
  custom: cacheProbeTemplate as CacheProbeTemplate,
  claude_code: cacheClaudeCodeTemplate as CacheProbeTemplate,
};

function cacheTemplateFor(profile: CacheRequestProfile): CacheProbeTemplate {
  return cacheTemplates[profile];
}

function createAnonymousClaudeUserId(): string {
  const bytes = createRandomBytes(32);
  const deviceId = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: "",
    session_id: createUuid(),
  });
}

function cacheProbeStage(roundIndex: number): CacheProbeStage {
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex > 4) {
    throw new Error("invalid_cache_round");
  }
  return `cachecheck-r${roundIndex}` as CacheProbeStage;
}

function createCacheRunId(): string {
  cacheRunSequence = (cacheRunSequence + 1) % (36 ** 3);
  const millisecondStamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  return `${millisecondStamp}${cacheRunSequence.toString(36).padStart(3, "0")}`;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Detection cancelled", "AbortError");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => window.setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Detection cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isCacheProbeStage(stage: PublicErrorInfo["stage"] | undefined): boolean {
  return typeof stage === "string" && /^cachecheck-r[0-4]$/.test(stage);
}

function createPdfBase64(text: string): string {
  const stream = `BT /F1 14 Tf 10 20 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 80] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${stream.length} >>
stream
${stream}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`;
  return btoa(pdf);
}

function extractResponseText(payload: any, mode: EndpointMode): string {
  if (!payload || typeof payload !== "object") return "";

  if (mode === "openai-images") {
    const image = Array.isArray(payload.data) ? payload.data[0] : null;
    if (typeof image?.b64_json === "string") return `[base64 image: ${image.b64_json.length} chars]`;
    if (typeof image?.url === "string") return image.url;
    return "";
  }

  if (mode === "openai-responses") {
    if (typeof payload.output_text === "string") {
      return payload.output_text.trim();
    }

    const output = Array.isArray(payload.output) ? payload.output : [];
    const parts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      // Responses may include a reasoning item before the final message.
      // Never mix an internal/reasoning summary into the answer that gets
      // graded by the deterministic probes.
      if (item.type !== "reasoning" && typeof item.text === "string") {
        parts.push(item.text);
      }
      if (Array.isArray(item.content)) {
        for (const contentItem of item.content) {
          if (contentItem && contentItem.type !== "reasoning" && contentItem.type !== "summary" && typeof contentItem.text === "string") {
            parts.push(contentItem.text);
          }
        }
      }
    }
    return parts.join("\n").trim();
  }

  if (mode === "openai-chat") {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      const parts = content
        .map((item: any) => (item && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean);
      return parts.join("\n").trim();
    }
    return "";
  }

  if (mode === "google-generative") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    return Array.isArray(parts)
      ? parts
        .filter((part: any) => part?.thought !== true)
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim()
      : "";
  }

  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const textParts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "thinking" && block.type !== "redacted_thinking" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n").trim();
}

function statusToScore(status: CheckStatus, weight: number): number {
  if (status === "pass") return weight;
  if (status === "warning") return Math.round(weight * 0.5);
  return 0;
}

function isClaudeLike(strategy: string): boolean {
  return strategy.startsWith("claude") || strategy === "fable";
}

function messageIdMatches(probe: ProbeResult, value: string): boolean {
  if (probe.mode === "anthropic") return /^msg_[A-Za-z0-9]{20,}$/.test(value);
  if (probe.mode === "openai-chat") return /^chatcmpl-[A-Za-z0-9._-]+$/.test(value);
  if (probe.mode === "openai-responses") return /^resp_[A-Za-z0-9._-]+$/.test(value);
  return false;
}

function comparableMessageId(probe: ProbeResult): string | null {
  return probe.mode === "anthropic" ? probe.payloadMessageId : probe.messageId;
}

function isUsableEvidenceProbe(probe: ProbeResult): boolean {
  return probe.upstreamStatus >= 200 && probe.upstreamStatus < 300 && probe.parseOk &&
    !isProviderErrorEnvelope(probe.payload) && hasProtocolResponseShape(probe.payload, probe.mode);
}

function shouldStopRequiredProbe(probe: ProbeResult): boolean {
  return !isUsableEvidenceProbe(probe);
}

function reportedModelsFromUsableProbes(probes: readonly ProbeResult[]): string[] {
  return probes
    .filter(isUsableEvidenceProbe)
    .flatMap((probe) => [probe.reportedModel, probe.streamMessageStartModel])
    .filter((model): model is string => Boolean(model));
}

function safeTrace(trace: unknown): string {
  // Keep the official PDF payload unchanged for request parity while ensuring
  // captured upstream text cannot reintroduce third-party branding in the UI.
  return JSON.stringify(trace, null, 2).replace(/hvoy(?:\.ai)?/gi, "kk");
}

async function fetchLiveKnowledgeSnapshot(signal?: AbortSignal): Promise<LiveKnowledgeSnapshot> {
  const response = await fetch("/__live-knowledge", { cache: "no-store", signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !isLiveKnowledgeSnapshot(payload)) {
    const detail = payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

function compactErrorText(raw: string, max = 260, currentApiKey = ""): string {
  if (!raw) return "";
  const exactSecrets = [
    currentApiKey.trim(),
    currentApiKey.trim().replace(/^(?:bearer\s+|x-api-key\s*:\s*)/i, ""),
  ].filter((value, index, values) => value.length >= 6 && values.indexOf(value) === index)
    .sort((a, b) => b.length - a.length);
  let redacted = raw;
  for (const secret of exactSecrets) {
    redacted = redacted.split(secret).join("[redacted-key]");
  }
  const noTags = redacted.replace(/<[^>]+>/g, " ");
  const normalized = noTags
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bark-[A-Za-z0-9._-]{8,}\b/g, "[redacted-key]")
    .replace(/\b[0-9a-f]{16,}\.[A-Za-z0-9_-]{8,}\b/gi, "[redacted-key]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-key]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]");
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function extractUpstreamErrorDetail(rawText: string, fallbackMessage: string, currentApiKey = ""): string {
  if (!rawText) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const topMessage = typeof parsed?.message === "string" ? parsed.message : "";
    const topDetail = typeof parsed?.detail === "string" ? parsed.detail : "";
    const topError = parsed?.error;
    const nestedError =
      topError && typeof topError === "object"
        ? (topError as Record<string, unknown>)
        : null;
    const nestedMessage = nestedError && typeof nestedError.message === "string" ? nestedError.message : "";
    const nestedDetail = nestedError && typeof nestedError.detail === "string" ? nestedError.detail : "";
    const nestedCode = nestedError && typeof nestedError.code === "string" ? nestedError.code : "";
    const candidates = [nestedMessage, nestedDetail, topMessage, topDetail, nestedCode];
    const first = candidates.find((x) => typeof x === "string" && x.trim());
    if (first) {
      return compactErrorText(first, 260, currentApiKey);
    }
  } catch {
    // fall through to plain text parsing
  }

  const plain = compactErrorText(rawText, 260, currentApiKey);
  return plain || fallbackMessage;
}

function isProviderErrorEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  // Anthropic, OpenAI-compatible relays, and Gemini all use a non-null
  // `error` object for failures. Some relays also preserve Anthropic's
  // top-level `type: error` marker while returning HTTP 200.
  return value.type === "error" || (value.error !== null && value.error !== undefined);
}

function hasProtocolResponseShape(payload: unknown, mode: EndpointMode): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (mode === "anthropic") return Array.isArray(value.content) && value.content.length > 0;
  if (mode === "openai-chat") return Array.isArray(value.choices) && value.choices.length > 0;
  if (mode === "openai-responses") return (typeof value.output_text === "string" && value.output_text.trim().length > 0) || (Array.isArray(value.output) && value.output.length > 0);
  if (mode === "openai-images") return Array.isArray(value.data) && value.data.length > 0;
  if (mode === "google-generative") return Array.isArray(value.candidates) && value.candidates.length > 0;
  return false;
}

async function sendProbe(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: ApiProtocol;
  prompt: string;
  stage: NonNullable<PublicErrorInfo["stage"]>;
  previousUserPrompt?: string;
  previousAssistantText?: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  cacheControl?: boolean;
  pdfText?: string;
  anthropicBeta?: string;
  thinkingMode?: "enabled" | "adaptive" | "adaptive-summarized" | "adaptive-omitted" | "omit";
  anthropicEffort?: "low" | "medium" | "high" | "xhigh";
  jsonSchema?: Record<string, unknown>;
  geminiThinkingLevel?: "medium" | "minimal";
  geminiGenerationConfigOverrides?: Record<string, unknown>;
  allowUpstreamError?: boolean;
  cacheRunId?: string;
  cacheRequestProfile?: CacheRequestProfile;
  cacheSessionId?: string;
  timeoutMs?: number;
  metadataUserId?: string;
  signal?: AbortSignal;
  messages: I18nMessages;
}): Promise<ProbeResult> {
  const { endpoint, mode } = resolveEndpoint(options.baseUrl, options.model, options.protocol);
  if (!endpoint) {
    throw new Error("API endpoint is empty");
  }

  const cacheRequestProfile = options.cacheRequestProfile ?? "custom";
  const cacheTemplate = cacheTemplateFor(cacheRequestProfile);
  const cacheUserPrefixes = options.cacheControl && cacheRequestProfile === "claude_code"
    ? cacheTemplate.userMessagePrefixes ?? []
    : [];
  const buildAnthropicUserContent = (text: string, pdfText?: string, cacheBreakpoint = false) => {
    const content: Array<any> = [];
    if (pdfText) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: createPdfBase64(pdfText) },
      });
    }
    for (const prefix of cacheUserPrefixes) {
      if (prefix.trim()) content.push({ type: "text", text: prefix });
    }
    content.push({
      type: "text",
      text,
      ...(cacheBreakpoint ? { cache_control: { type: "ephemeral" as const } } : {}),
    });
    return content;
  };

  const anthropicMessages: Array<{
    role: "user" | "assistant";
    content: Array<{
      type: "text";
      text: string;
      cache_control?: { type: "ephemeral" };
    }>;
  }> = [];
  const openAIMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

  if (options.history && options.history.length > 0) {
    for (const turn of options.history) {
      anthropicMessages.push({ role: turn.role, content: buildAnthropicUserContent(turn.text) });
      openAIMessages.push({ role: turn.role, content: turn.text });
    }
    anthropicMessages.push({ role: "user", content: buildAnthropicUserContent(options.prompt, options.pdfText, options.cacheControl) });
    openAIMessages.push({ role: "user", content: options.prompt });
  } else if (options.previousAssistantText !== undefined) {
    const previousUserPrompt = options.previousUserPrompt || options.prompt;
    anthropicMessages.push({ role: "user", content: buildAnthropicUserContent(previousUserPrompt) });
    anthropicMessages.push({ role: "assistant", content: [{ type: "text", text: options.previousAssistantText || "(empty)" }] });
    anthropicMessages.push({ role: "user", content: buildAnthropicUserContent(options.prompt, options.pdfText, options.cacheControl) });

    openAIMessages.push({ role: "user", content: previousUserPrompt });
    openAIMessages.push({ role: "assistant", content: options.previousAssistantText || "(empty)" });
    openAIMessages.push({ role: "user", content: options.prompt });
  } else {
    anthropicMessages.push({ role: "user", content: buildAnthropicUserContent(options.prompt, options.pdfText, options.cacheControl) });
    openAIMessages.push({ role: "user", content: options.prompt });
  }

  const cacheSessionId = options.cacheSessionId || "";
  const rawApiKey = options.apiKey.trim();
  const explicitBearerAuth = /^bearer\s+/i.test(rawApiKey);
  const normalizedApiKey = rawApiKey.replace(/^(?:bearer\s+|x-api-key\s*:\s*)/i, "");
  const baseMetadataUserId = options.metadataUserId || createAnonymousClaudeUserId();
  const usesOfficialClaudeProbeHeaders = !options.cacheControl && baseMetadataUserId === OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID;
  const cacheMetadataUserId = cacheRequestProfile === "custom"
    ? cacheTemplate.metadataUserId || OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID
    : (() => {
        try {
          const metadata = JSON.parse(cacheTemplate.metadataUserId || OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID) as Record<string, unknown>;
          metadata.session_id = cacheSessionId || metadata.session_id;
          return JSON.stringify(metadata);
        } catch {
          return cacheTemplate.metadataUserId || OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID;
        }
      })();
  const isVertexEndpoint = mode === "google-generative" && (() => {
    try {
      const parsed = new URL(endpoint);
      return /(?:^|[.-])aiplatform\.googleapis\.com$/i.test(parsed.hostname) &&
        /\/projects\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  })();
  const isVertexAnthropicEndpoint = mode === "anthropic" && (() => {
    try {
      const parsed = new URL(endpoint);
      return /(?:^|[.-])aiplatform\.googleapis\.com$/i.test(parsed.hostname) &&
        /\/publishers\/anthropic\/models\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  })();
  const isVertexAnthropicStream = isVertexAnthropicEndpoint && /:streamRawPredict(?:$|[?#])/i.test(endpoint);
  const headers =
    mode === "anthropic"
      ? {
          accept: "application/json",
          "accept-encoding": "identity",
          "content-type": "application/json",
          ...(options.cacheControl ||
            isVertexAnthropicEndpoint ||
            explicitBearerAuth
            ? { authorization: `Bearer ${normalizedApiKey}` }
            : { "x-api-key": normalizedApiKey }),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": [
            "claude-code-20250219",
            "interleaved-thinking-2025-05-14",
            "context-management-2025-06-27",
            "prompt-caching-scope-2026-01-05",
            "effort-2025-11-24",
            options.anthropicBeta,
          ].filter(Boolean).join(","),
          "anthropic-dangerous-direct-browser-access": "true",
          "user-agent": "claude-cli/2.1.165 (external, cli)",
          "x-app": "cli",
          ...(usesOfficialClaudeProbeHeaders ? OFFICIAL_CLAUDE_PROBE_HEADERS : {}),
          ...(options.cacheControl
            ? {
                ...(cacheRequestProfile === "claude_code"
                  ? {
                      "x-claude-code-session-id": cacheSessionId,
                      "x-stainless-arch": "arm64",
                      "x-stainless-lang": "js",
                      "x-stainless-os": "MacOS",
                      "x-stainless-package-version": "0.81.0",
                      "x-stainless-retry-count": "0",
                      "x-stainless-runtime": "node",
                      "x-stainless-runtime-version": "v24.3.0",
                      "x-stainless-timeout": "600",
                    }
                  : {}),
              }
            : {}),
        }
      : mode === "google-generative"
        ? {
            accept: "application/json",
            "content-type": "application/json",
            ...(isVertexEndpoint || explicitBearerAuth
              ? { authorization: `Bearer ${normalizedApiKey}` }
              : { "x-goog-api-key": normalizedApiKey }),
          }
      : {
          accept: mode === "openai-chat" ? "text/event-stream" : "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${normalizedApiKey}`,
        };

  const cacheRunMarker = `[cache_test_run: ${options.cacheRunId || "local"}]`;
  const cacheSystem = options.cacheControl
    ? (Array.isArray(cacheTemplate.system)
      ? cacheTemplate.system.map((item, index, items) => index === items.length - 1 && item.type === "text"
        ? { ...item, text: `${item.text ?? ""}\n\n${CACHECHECK_SYSTEM_SUFFIX}\n\n${cacheRunMarker}`, cache_control: item.cache_control ?? { type: "ephemeral" } }
        : { ...item })
      : [{ type: "text" as const, text: `${cacheTemplate.system}\n\n${CACHECHECK_SYSTEM_SUFFIX}\n\n${cacheRunMarker}`, cache_control: { type: "ephemeral" as const } }])
    : null;
  const outputConfig = {
    ...(options.anthropicEffort
      ? { effort: options.anthropicEffort }
      : options.thinkingMode === "adaptive-summarized"
        ? { effort: "medium" }
        : {}),
    ...(options.jsonSchema
      ? { format: { type: "json_schema", schema: options.jsonSchema } }
      : {}),
  };
  const thinkingMode = options.cacheControl
    ? cacheRequestProfile === "claude_code" ? "adaptive" : "omit"
    : options.thinkingMode ?? "enabled";
  const anthropicSystem = options.cacheControl
    ? cacheSystem
    : [
        { type: "text" as const, text: CLAUDE_CODE_BILLING_HEADER },
        {
          type: "text" as const,
          text: OFFICIAL_CLAUDE_CODE_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" as const },
        },
      ];
  const anthropicTools = options.cacheControl
    ? cacheTemplate.tools.map((tool, index) => ({
        ...tool,
        description: `${typeof tool.description === "string" ? tool.description : ""}\n\n${cacheRunMarker}`,
        ...(index === cacheTemplate.tools.length - 1
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      }))
    : [];
  const body =
    mode === "anthropic"
      ? options.cacheControl
        ? {
            model: options.model,
            system: anthropicSystem,
            tools: anthropicTools,
            messages: anthropicMessages,
            ...(thinkingMode === "adaptive" ? { thinking: { type: "adaptive" } } : {}),
            metadata: { user_id: cacheMetadataUserId },
            max_tokens: 40960,
            stream: !isVertexAnthropicEndpoint || isVertexAnthropicStream,
            ...(isVertexAnthropicEndpoint ? { anthropic_version: "vertex-2023-10-16" } : {}),
          }
        : {
            model: options.model,
            messages: anthropicMessages,
            metadata: { user_id: baseMetadataUserId },
            ...(isVertexAnthropicEndpoint ? { anthropic_version: "vertex-2023-10-16" } : {}),
            system: anthropicSystem,
            max_tokens: PROBE_MAX_TOKENS,
            stream: !isVertexAnthropicEndpoint || isVertexAnthropicStream,
            tools: anthropicTools,
            ...(thinkingMode === "enabled"
              ? { thinking: { type: "enabled", budget_tokens: PROBE_THINKING_BUDGET } }
              : thinkingMode === "adaptive-summarized"
                ? { thinking: { type: "adaptive", display: "summarized" } }
                : thinkingMode === "adaptive-omitted"
                  ? { thinking: { type: "adaptive", display: "omitted" } }
                  : thinkingMode === "adaptive"
                ? { thinking: { type: "adaptive" } }
                : {}),
            // Do not force a sampling temperature on Anthropic-compatible
            // endpoints. Fable relays can reject the deprecated field outright.
            ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
          }
      : mode === "openai-images"
        ? {
            model: options.model,
            prompt: options.prompt,
            n: 1,
            size: "1024x1024",
          }
        : mode === "openai-responses"
        ? buildOpenAiResponsesProbeBody({
            model: options.model,
            messages: openAIMessages,
            maxOutputTokens: OPENAI_PROBE_MAX_OUTPUT_TOKENS,
          })
        : mode === "google-generative"
          ? {
              contents: openAIMessages.map((message) => ({
                role: message.role === "assistant" ? "model" : "user",
                parts: [{ text: message.content }],
              })),
              generationConfig: {
                ...GEMINI_GENERATION_CONFIG,
                ...(options.geminiThinkingLevel
                  ? { thinkingConfig: { thinkingLevel: options.geminiThinkingLevel } }
                  : {}),
                ...(options.geminiGenerationConfigOverrides ?? {}),
              },
            }
        : buildOpenAiChatProbeBody({
            model: options.model,
            messages: openAIMessages,
            maxOutputTokens: OPENAI_PROBE_MAX_OUTPUT_TOKENS,
          });

  let relayResponse: Response;
  try {
    relayResponse = await fetch("/__probe", {
      method: "POST",
      signal: options.signal,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stage: options.stage,
        mode,
        ...(options.cacheControl ? { preferredProtocolFlavor: "anthropic_direct", timeoutMs: options.timeoutMs ?? 10_000 } : {}),
        endpoint,
        method: "POST",
        headers,
        body,
      }),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = error instanceof Error && error.message ? error.message : options.messages.upstreamNoErrorDetail;
    if (options.allowUpstreamError) {
      return {
        ...createSkippedProbe(options.prompt),
        mode,
        finalUpstreamUrl: endpoint,
        errorMessage: detail,
      };
    }
    throw new UserVisibleError({
      title: options.messages.probeRequestFailedTitle,
      detail,
      source: "upstream",
      stage: options.stage,
      statusCode: 0,
    });
  }

  const relayPayload = await relayResponse.json().catch(() => ({}));
  const latencyMs = typeof relayPayload?.latencyMs === "number" ? relayPayload.latencyMs : 0;
  const firstTokenLatencyMs =
    typeof relayPayload?.firstChunkLatencyMs === "number" ? relayPayload.firstChunkLatencyMs : null;
  const rawText = typeof relayPayload?.bodyText === "string" ? relayPayload.bodyText : "";
  const relayUsage = relayPayload?.usage && typeof relayPayload.usage === "object" ? relayPayload.usage : {};
  const relayCacheHit = Boolean(relayPayload?.cacheHit);
  const relayCacheReadInputTokens =
    typeof relayPayload?.cacheReadInputTokens === "number" ? relayPayload.cacheReadInputTokens : 0;
  const relayCacheCreationInputTokens =
    typeof relayPayload?.cacheCreationInputTokens === "number" ? relayPayload.cacheCreationInputTokens : 0;
  const relayCacheEvidenceFields = Array.isArray(relayPayload?.cacheEvidenceFields)
    ? relayPayload.cacheEvidenceFields.filter((x: unknown): x is string => typeof x === "string")
    : [];
  const signatureDeltaTotalLength =
    typeof relayPayload?.signatureDeltaTotalLength === "number" ? relayPayload.signatureDeltaTotalLength : 0;
  const signatureDeltaCount =
    typeof relayPayload?.signatureDeltaCount === "number" ? relayPayload.signatureDeltaCount : 0;
  const signatureEmptyCount =
    typeof relayPayload?.signatureEmptyCount === "number" ? relayPayload.signatureEmptyCount : 0;
  const signatureIsValidBase64 =
    typeof relayPayload?.signatureIsValidBase64 === "boolean" ? relayPayload.signatureIsValidBase64 : null;
  const signatureVerdict =
    typeof relayPayload?.signatureVerdict === "string" &&
    ["PASS", "PARTIAL", "FAIL", "FORGED", "ERROR", "UNKNOWN"].includes(relayPayload.signatureVerdict.toUpperCase())
      ? relayPayload.signatureVerdict.toUpperCase() as ProbeResult["signatureVerdict"]
      : null;
  const signatureCompatibilityVerdict =
    typeof relayPayload?.signatureCompatibilityVerdict === "string" &&
    ["PASS", "PARTIAL", "FAIL", "FORGED", "ERROR", "UNKNOWN"].includes(relayPayload.signatureCompatibilityVerdict.toUpperCase())
      ? relayPayload.signatureCompatibilityVerdict.toUpperCase() as ProbeResult["signatureCompatibilityVerdict"]
      : null;
  const signatureCompatibilityReason =
    typeof relayPayload?.signatureCompatibilityReason === "string" && relayPayload.signatureCompatibilityReason.length > 0
      ? relayPayload.signatureCompatibilityReason
      : null;
  const signatureFormulaCompatible = relayPayload?.signatureFormulaCompatible === true;
  const sigModelName = typeof relayPayload?.sigModelName === "string" && relayPayload.sigModelName.length > 0
    ? relayPayload.sigModelName
    : null;
  const signatureEnvelopeModel =
    typeof relayPayload?.signatureEnvelopeModel === "string" && relayPayload.signatureEnvelopeModel.length > 0
      ? relayPayload.signatureEnvelopeModel
      : null;
  const signatureEnvelopeMatchesRequested = relayPayload?.signatureEnvelopeMatchesRequested === true;
  const signatureEnvelopeChannelPresent = relayPayload?.signatureEnvelopeChannelPresent === true;
  const signatureEnvelopeChannelValue =
    typeof relayPayload?.signatureEnvelopeChannelValue === "number" && Number.isSafeInteger(relayPayload.signatureEnvelopeChannelValue)
      ? relayPayload.signatureEnvelopeChannelValue
      : null;
  const signatureEnvelopeVersion = typeof relayPayload?.signatureEnvelopeVersion === "number" && Number.isSafeInteger(relayPayload.signatureEnvelopeVersion)
    ? relayPayload.signatureEnvelopeVersion
    : null;
  const signatureEnvelopeKeyVersion = typeof relayPayload?.signatureEnvelopeKeyVersion === "number" && Number.isSafeInteger(relayPayload.signatureEnvelopeKeyVersion)
    ? relayPayload.signatureEnvelopeKeyVersion
    : null;
  const signatureEnvelopeSchemaVersion = typeof relayPayload?.signatureEnvelopeSchemaVersion === "number" && Number.isSafeInteger(relayPayload.signatureEnvelopeSchemaVersion)
    ? relayPayload.signatureEnvelopeSchemaVersion
    : null;
  const signatureEnvelopeVariant = typeof relayPayload?.signatureEnvelopeVariant === "number" && Number.isSafeInteger(relayPayload.signatureEnvelopeVariant)
    ? relayPayload.signatureEnvelopeVariant
    : null;
  const signatureEnvelopePayloadType = typeof relayPayload?.signatureEnvelopePayloadType === "string"
    ? relayPayload.signatureEnvelopePayloadType
    : null;
  const signatureEnvelopeSessionId = typeof relayPayload?.signatureEnvelopeSessionId === "string"
    ? relayPayload.signatureEnvelopeSessionId
    : null;
  const signatureEnvelopeEncryptedPayloadBytes = typeof relayPayload?.signatureEnvelopeEncryptedPayloadBytes === "number" && Number.isSafeInteger(relayPayload.signatureEnvelopeEncryptedPayloadBytes)
    ? relayPayload.signatureEnvelopeEncryptedPayloadBytes
    : null;
  const signatureFormat = typeof relayPayload?.signatureFormat === "string" && relayPayload.signatureFormat.length > 0
    ? relayPayload.signatureFormat
    : null;
  const signatureStructureIssues = Array.isArray(relayPayload?.signatureStructureIssues)
    ? relayPayload.signatureStructureIssues.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const signatureReason = typeof relayPayload?.signatureReason === "string" ? relayPayload.signatureReason : null;
  const signatureStructurallyParsed = relayPayload?.signatureStructurallyParsed === true;
  const signatureCryptographicallyVerified = relayPayload?.signatureCryptographicallyVerified === true;
  const finalUpstreamUrl = typeof relayPayload?.finalUpstreamUrl === "string" && relayPayload.finalUpstreamUrl.length > 0
    ? relayPayload.finalUpstreamUrl
    : null;
  const upstreamRedirected = relayPayload?.upstreamRedirected === true;
  const responseHeaders: Record<string, string> = {};
  if (relayPayload?.responseHeaders && typeof relayPayload.responseHeaders === "object") {
    for (const [key, value] of Object.entries(relayPayload.responseHeaders)) {
      if (typeof value === "string") responseHeaders[key] = value;
    }
  }
  const messageId = typeof relayPayload?.messageId === "string" ? relayPayload.messageId : null;
  const streamMessageStartModel =
    typeof relayPayload?.streamMessageStartModel === "string" ? relayPayload.streamMessageStartModel : null;
  const streamMessageStartInputTokens =
    typeof relayPayload?.streamMessageStartInputTokens === "number" ? relayPayload.streamMessageStartInputTokens : null;
  const streamMessageDeltaInputTokensSamples = Array.isArray(relayPayload?.streamMessageDeltaInputTokensSamples)
    ? relayPayload.streamMessageDeltaInputTokensSamples.filter((x: unknown): x is number => typeof x === "number" && Number.isFinite(x))
    : [];
  const streamOutputTokensSamples = Array.isArray(relayPayload?.streamOutputTokensSamples)
    ? relayPayload.streamOutputTokensSamples.filter((x: unknown): x is number => typeof x === "number" && Number.isFinite(x))
    : [];
  const sseContentTypes = Array.isArray(relayPayload?.sseContentTypes)
    ? relayPayload.sseContentTypes.filter((x: unknown): x is string => typeof x === "string")
    : [];
  const requestCompatibilityFallbacks = Array.isArray(relayPayload?.requestCompatibilityFallbacks)
    ? relayPayload.requestCompatibilityFallbacks.filter((x: unknown): x is string => typeof x === "string")
    : [];

  if (!relayResponse.ok || relayPayload?.ok !== true) {
    // The relay's own limiter is distinct from an upstream model response.
    // Preserve it as an unavailable probe so a burst from this browser cannot
    // be rendered as a model mismatch or a generic crash.
    if (options.allowUpstreamError && (relayResponse.status === 429 || relayResponse.status >= 500)) {
      return {
        ...createSkippedProbe(options.prompt),
        mode,
        upstreamStatus: relayResponse.status,
        finalUpstreamUrl: endpoint,
        errorMessage: typeof relayPayload?.error === "string"
          ? relayPayload.error
          : relayResponse.status === 429
            ? "probe_rate_limited"
            : "probe_relay_failed",
      };
    }
    throw new UserVisibleError({
      title: options.messages.probeRequestFailedTitle,
      detail: options.messages.probeRequestFailedDetail,
      source: "system",
      stage: options.stage,
      statusCode: relayResponse.status,
      retryAfterMs: retryDelayMs(relayResponse.status, relayResponse.headers),
    });
  }

  const upstreamStatus = typeof relayPayload?.status === "number" ? relayPayload.status : 0;
  const upstreamErrorMessage = upstreamStatus >= 200 && upstreamStatus < 300
    ? null
    : extractUpstreamErrorDetail(rawText, options.messages.upstreamNoErrorDetail, options.apiKey);
  if ((upstreamStatus < 200 || upstreamStatus >= 300) && !options.allowUpstreamError) {
    throw new UserVisibleError({
      title: `${options.messages.probeRequestFailedTitle} (HTTP ${upstreamStatus})`,
      detail: upstreamErrorMessage || options.messages.upstreamNoErrorDetail,
      source: "upstream",
      stage: options.stage,
      statusCode: upstreamStatus,
      retryAfterMs: retryDelayMs(upstreamStatus, responseHeaders),
    });
  }

  let payload: any = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    if (options.allowUpstreamError) {
      return {
        prompt: options.prompt,
        responseText: "",
        payload: null,
        latencyMs,
        firstTokenLatencyMs,
        tps: 0,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cacheHit: false,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheEvidenceFields: [],
        signatureDeltaTotalLength,
        signatureDeltaCount,
        signatureEmptyCount,
        signatureIsValidBase64,
        signatureVerdict,
        signatureCompatibilityVerdict,
        signatureCompatibilityReason,
        signatureFormulaCompatible,
        sigModelName,
        signatureEnvelopeModel,
        signatureEnvelopeMatchesRequested,
        signatureEnvelopeChannelPresent,
        signatureEnvelopeChannelValue,
        signatureEnvelopeVersion,
        signatureEnvelopeKeyVersion,
        signatureEnvelopeSchemaVersion,
        signatureEnvelopeVariant,
        signatureEnvelopePayloadType,
        signatureEnvelopeSessionId,
        signatureEnvelopeEncryptedPayloadBytes,
        signatureFormat,
        signatureStructureIssues,
        signatureReason,
        signatureStructurallyParsed,
        signatureCryptographicallyVerified,
        payloadMessageId: null,
        messageId,
        streamMessageStartModel,
        sseEventTypes: Array.isArray(relayPayload?.sseEventTypes)
          ? relayPayload.sseEventTypes.filter((x: unknown): x is string => typeof x === "string")
          : [],
        rawSseEventCount: typeof relayPayload?.rawSseEventCount === "number" ? relayPayload.rawSseEventCount : 0,
        upstreamStatus,
        finalUpstreamUrl,
        upstreamRedirected,
        responseHeaders,
        requestCompatibilityFallbacks,
        errorMessage: upstreamErrorMessage,
        streamMessageStartInputTokens,
        streamMessageDeltaInputTokensSamples,
        streamOutputTokensSamples,
        contentTypes: [],
        jsonParseOk: false,
        parseOk: false,
        mode,
        reportedModel: streamMessageStartModel,
        protocolHints: {
          hasModel: Boolean(streamMessageStartModel),
          hasRole: false,
          hasContentArray: false,
          hasUsage: Object.keys(relayUsage).length > 0,
          hasStopReason: false,
        },
      };
    }
    throw new UserVisibleError({
      title: options.messages.probeInvalidResponseTitle,
      detail: extractUpstreamErrorDetail(rawText, options.messages.upstreamNoErrorDetail, options.apiKey),
      source: "upstream",
      stage: options.stage,
      statusCode: upstreamStatus,
    });
  }

  const responseText = extractResponseText(payload, mode);
  const payloadMessageId = typeof payload?.id === "string" ? payload.id : null;
  const providerErrorEnvelope = isProviderErrorEnvelope(payload);
  const semanticErrorMessage = providerErrorEnvelope
    ? extractUpstreamErrorDetail(rawText, options.messages.upstreamNoErrorDetail, options.apiKey)
    : null;
  const usage = payload && typeof payload === "object"
    ? payload.usage
      ?? payload.usageMetadata
      ?? payload?.candidates?.[0]?.usageMetadata
    : null;
  const cacheUsage = extractCacheUsage({ ...(relayUsage as Record<string, unknown>), ...(usage as Record<string, unknown> ?? {}) });
  const rawInputTokens =
    usage && typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : usage && typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : usage && typeof usage.promptTokenCount === "number"
          ? usage.promptTokenCount
        : typeof relayUsage.input_tokens === "number"
          ? relayUsage.input_tokens
          : typeof relayUsage.prompt_tokens === "number"
            ? relayUsage.prompt_tokens
            : typeof relayUsage.promptTokenCount === "number"
              ? relayUsage.promptTokenCount
              : null;
  const rawOutputTokens =
    usage && typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : usage && typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : usage && typeof usage.candidatesTokenCount === "number"
          ? usage.candidatesTokenCount
        : typeof relayUsage.output_tokens === "number"
          ? relayUsage.output_tokens
          : typeof relayUsage.completion_tokens === "number"
            ? relayUsage.completion_tokens
            : typeof relayUsage.candidatesTokenCount === "number"
              ? relayUsage.candidatesTokenCount
              : null;
  const openAiUsage = mode === "openai-chat" || mode === "openai-responses"
    ? normalizeOpenAiTokenUsage(
        usage,
        relayUsage,
        {
          cache_read_input_tokens: relayCacheReadInputTokens,
          cache_creation_input_tokens: relayCacheCreationInputTokens,
        },
      )
    : null;
  const inputTokens = openAiUsage ? openAiUsage.inputTokens : rawInputTokens;
  const outputTokens = openAiUsage ? openAiUsage.outputTokens : rawOutputTokens;
  const totalTokens = openAiUsage
    ? openAiUsage.totalTokens
    : usage && typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null;
  const cacheReadInputTokens = openAiUsage
    ? openAiUsage.cacheReadTokens
    : Math.max(relayCacheReadInputTokens, cacheUsage.cacheReadTokens);
  const cacheCreationInputTokens = openAiUsage
    ? openAiUsage.cacheWriteTokens
    : Math.max(relayCacheCreationInputTokens, cacheUsage.cacheCreationTokens);
  const tps = outputTokens && latencyMs > 0 ? Number((outputTokens / (latencyMs / 1000)).toFixed(1)) : 0;

  const contentTypes: string[] = [];
  if (mode === "anthropic") {
    const content = Array.isArray(payload?.content) ? payload.content : [];
    for (const item of content) {
      if (item && typeof item.type === "string") {
        contentTypes.push(item.type);
      }
    }
    for (const t of sseContentTypes) {
      if (!contentTypes.includes(t)) {
        contentTypes.push(t);
      }
    }
  } else if (mode === "openai-images") {
    contentTypes.push("image");
  } else if (mode === "openai-chat") {
    contentTypes.push("text");
    const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      contentTypes.push("tool_use");
    }
  } else if (mode === "google-generative") {
    contentTypes.push("text");
    if (payload?.candidates?.[0]?.content?.parts?.some((part: any) => part?.thought === true)) {
      contentTypes.push("thinking");
    }
  } else {
    contentTypes.push("text");
    const output = Array.isArray(payload?.output) ? payload.output : [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.type === "string" && item.type !== "message") {
        contentTypes.push(item.type === "reasoning" ? "thinking" : item.type);
      }
      if (Array.isArray(item.content)) {
        for (const contentItem of item.content) {
          if (contentItem && typeof contentItem.type === "string" && !contentTypes.includes(contentItem.type)) {
            contentTypes.push(contentItem.type);
          }
        }
      }
    }
  }

  return {
    prompt: options.prompt,
    responseText,
    payload,
    latencyMs,
    firstTokenLatencyMs,
    tps,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheHit: relayCacheHit || cacheReadInputTokens > 0,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheEvidenceFields: [...new Set([...relayCacheEvidenceFields, ...cacheUsage.evidenceFields])],
    signatureDeltaTotalLength,
    signatureDeltaCount,
    signatureEmptyCount,
    signatureIsValidBase64,
    signatureVerdict,
    signatureCompatibilityVerdict,
    signatureCompatibilityReason,
    signatureFormulaCompatible,
    sigModelName,
    signatureEnvelopeModel,
    signatureEnvelopeMatchesRequested,
    signatureEnvelopeChannelPresent,
    signatureEnvelopeChannelValue,
    signatureEnvelopeVersion,
    signatureEnvelopeKeyVersion,
    signatureEnvelopeSchemaVersion,
    signatureEnvelopeVariant,
    signatureEnvelopePayloadType,
    signatureEnvelopeSessionId,
    signatureEnvelopeEncryptedPayloadBytes,
    signatureFormat,
    signatureStructureIssues,
    signatureReason,
    signatureStructurallyParsed,
    signatureCryptographicallyVerified,
    payloadMessageId,
    messageId,
    streamMessageStartModel,
    sseEventTypes: Array.isArray(relayPayload?.sseEventTypes)
      ? relayPayload.sseEventTypes.filter((x: unknown): x is string => typeof x === "string")
      : [],
    rawSseEventCount: typeof relayPayload?.rawSseEventCount === "number" ? relayPayload.rawSseEventCount : 0,
    upstreamStatus,
    finalUpstreamUrl,
    upstreamRedirected,
    responseHeaders,
    requestCompatibilityFallbacks,
    errorMessage: upstreamErrorMessage ?? semanticErrorMessage,
    streamMessageStartInputTokens,
    streamMessageDeltaInputTokensSamples,
    streamOutputTokensSamples,
    contentTypes,
    jsonParseOk: Boolean(payload && typeof payload === "object" && !Array.isArray(payload)),
    // Keep payload parsing separate from protocol-shape scoring, matching the
    // public verifier. A valid JSON payload with missing protocol fields is
    // still evidence; the protocol hints then apply the appropriate penalty.
    parseOk: Boolean(payload && typeof payload === "object"),
    mode,
    reportedModel:
      typeof payload?.model === "string"
        ? payload.model
        : typeof payload?.modelVersion === "string"
          ? payload.modelVersion
          : streamMessageStartModel,
    protocolHints: {
      hasModel:
        mode === "google-generative"
          ? Array.isArray(payload?.candidates)
          : typeof payload?.model === "string",
      hasRole:
        mode === "openai-images"
          ? true
          : mode === "google-generative"
            ? Array.isArray(payload?.candidates)
          : mode === "anthropic"
            ? typeof payload?.role === "string"
            : typeof payload?.choices?.[0]?.message?.role === "string" ||
              (Array.isArray(payload?.output) && payload.output.some((item: any) =>
                item?.type === "message" && typeof item?.role === "string",
              )),
      hasContentArray:
        mode === "openai-images"
          ? Array.isArray(payload?.data)
          : mode === "google-generative"
            ? Array.isArray(payload?.candidates?.[0]?.content?.parts)
          : mode === "anthropic"
          ? Array.isArray(payload?.content)
          : Array.isArray(payload?.choices) || Array.isArray(payload?.output),
      hasUsage:
        mode === "google-generative"
          ? Boolean(payload?.usageMetadata && typeof payload.usageMetadata === "object")
          : Boolean(payload?.usage && typeof payload.usage === "object"),
      hasStopReason:
        mode === "openai-images"
          ? Array.isArray(payload?.data) && payload.data.length > 0
          : mode === "google-generative"
            ? typeof payload?.candidates?.[0]?.finishReason === "string"
          : mode === "anthropic"
            ? typeof payload?.stop_reason === "string" || payload?.stop_reason === null
            : typeof payload?.choices?.[0]?.finish_reason === "string" ||
              payload?.choices?.[0]?.finish_reason === null ||
              typeof payload?.status === "string",
    },
  };
}

function buildAbilityChecks(options: {
  stage1: ProbeResult;
  stage2: ProbeResult;
  requestedModel: string;
  profileModel: string;
  suite: EvaluationSuite;
  grades: EvaluationGrades;
  extraProbes?: ProbeResult[];
  messages: I18nMessages;
}): { checks: CheckItem[]; score: number; capabilityScore: number; authenticityScore: number; behavioralStatus: EvidenceSignalStatus } {
  const { stage1, stage2, requestedModel, profileModel, suite, grades, extraProbes = [], messages } = options;
  // Optional probes that never reached an upstream HTTP response are
  // diagnostic absences, not capability failures. Required stage 1/2 probes
  // are handled separately by the run-level availability gate.
  const scoreableExtraProbes = extraProbes.filter((probe) => probe.upstreamStatus > 0);
  const allProbes = [stage1, stage2, ...scoreableExtraProbes];

  const protocolScoreRaw = allProbes.flatMap((probe) => Object.values(probe.protocolHints)).filter(Boolean).length;
  const protocolScoreMax = allProbes.length * 5;
  const protocolRatio = protocolScoreMax > 0 ? protocolScoreRaw / protocolScoreMax : 0;

  const protocolStatus: CheckStatus = protocolRatio >= 0.8 ? "pass" : protocolRatio >= 0.5 ? "warning" : "fail";
  const responseStructureStatus: CheckStatus =
    stage1.parseOk &&
    stage2.parseOk &&
    stage1.protocolHints.hasContentArray &&
    stage2.protocolHints.hasContentArray
      ? "pass"
      : stage1.parseOk && stage2.parseOk
        ? "warning"
        : "fail";

  const usableProbes = allProbes.filter(isUsableEvidenceProbe);
  const reportedModels = reportedModelsFromUsableProbes(allProbes);
  const probesWithModel = usableProbes.filter((probe) => Boolean(probe.reportedModel || probe.streamMessageStartModel));
  const successfulProbeCount = usableProbes.length;
  const modelIdentityMatches =
    reportedModels.length > 0 &&
    reportedModels.every((model) => modelMatchesRequested(requestedModel, model, profileModel)) &&
    probesWithModel.length >= successfulProbeCount;
  const identityStatus: CheckStatus = modelIdentityMatches
    ? "pass"
    : reportedModels.length > 0
      ? reportedModels.some((model) => !modelMatchesRequested(requestedModel, model, profileModel)) ? "fail" : "warning"
      : "warning";

  const messageIdProbes = allProbes.filter((probe) => probe.mode !== "google-generative");
  const messageIdPairs = messageIdProbes
    .map((probe) => ({ probe, value: comparableMessageId(probe) }))
    .filter((pair): pair is { probe: ProbeResult; value: string } => Boolean(pair.value));
  const messageIdValues = messageIdPairs.map((pair) => pair.value);
  const messageIdStatus: CheckStatus = messageIdProbes.length === 0 || messageIdValues.length === 0
    ? "warning"
    : messageIdValues.length < messageIdProbes.length
      ? "warning"
      : messageIdPairs.every((pair) => messageIdMatches(pair.probe, pair.value))
      ? "pass"
      : "fail";

  const thinkingDetected = allProbes.some((probe) =>
    probe.contentTypes.includes("thinking") || /thinking/i.test(probe.responseText),
  );
  const thinkingApplicable =
    isClaudeLike(suite.profile.authenticityStrategy) &&
    suite.profile.authenticityStrategy !== "fable" &&
    stage1.mode === "anthropic";
  const thinkingStatus: CheckStatus = !thinkingApplicable ? "warning" : thinkingDetected ? "pass" : "fail";

  const signatureLength = allProbes.reduce((total, probe) => total + probe.signatureDeltaTotalLength, 0);
  const signatureApplicable =
    isClaudeLike(suite.profile.authenticityStrategy) &&
    suite.profile.authenticityStrategy !== "fable" &&
    stage1.mode === "anthropic";
  const signatureInvalid = allProbes.some((probe) =>
    probe.signatureVerdict === "FAIL" ||
    probe.signatureVerdict === "FORGED" ||
    probe.signatureVerdict === "ERROR" ||
    probe.signatureCompatibilityVerdict === "FAIL" ||
    probe.signatureCompatibilityVerdict === "FORGED" ||
    probe.signatureCompatibilityVerdict === "ERROR" ||
    probe.signatureIsValidBase64 === false ||
    probe.signatureEmptyCount > 0,
  );
  const signaturePartial = allProbes.some((probe) =>
    (probe.signatureCryptographicallyVerified && probe.signatureVerdict === "PARTIAL") ||
    (probe.signatureFormulaCompatible && probe.signatureCompatibilityVerdict === "PARTIAL"),
  );
  const signaturePassed = allProbes.some((probe) =>
    (probe.signatureCryptographicallyVerified && probe.signatureVerdict === "PASS") ||
    (probe.signatureFormulaCompatible && probe.signatureCompatibilityVerdict === "PASS"),
  );
  const signatureStatus: CheckStatus = !signatureApplicable
    ? "warning"
    : signatureInvalid
      ? "fail"
    : signaturePartial
      ? "warning"
    : signaturePassed && signatureLength >= 100
      ? "pass"
      : signatureLength > 0
        ? "warning"
        : "fail";
  const answerTrace = (dimension: keyof EvaluationGrades["actual"]) => safeTrace({
    tier: suite.tier,
    expected: suite.expected[dimension],
    actual: grades.actual[dimension] || "",
  });
  const abilityItem = (
    name: string,
    passed: boolean,
    trace: string,
  ): CheckItem => ({
    name,
    category: "ability",
    status: passed ? "pass" : "fail",
    detail: passed ? messages.checkAbilityPass : messages.checkAbilityFail,
    trace,
  });

  const knowledgeStatus: CheckStatus = grades.knowledge ? "pass" : "fail";
  const knowledgeBatchDetail = suite.knowledgeQuestions.length > 0
    ? ` · ${messages.checkKnowledgeBatch} ${suite.knowledgeBatchDate} · ${messages.checkKnowledgeSource} ${suite.profile.knowledgeSet}`
    : "";
  const authenticitySignals: AuthenticitySignals = {
    knowledge: knowledgeStatus,
    identity: identityStatus,
    protocol: protocolStatus,
    structure: responseStructureStatus,
    thinking: thinkingStatus,
    signature: signatureStatus,
  };
  const capabilityScore = calculateCapabilityScore(grades, suite.profile);
  const authenticity = calculateAuthenticityScore(suite.profile, authenticitySignals);

  const checks: CheckItem[] = [
    {
      name: messages.resultScoreCapability,
      category: "ability",
      status: capabilityScore >= suite.profile.capabilityPassScore ? "pass" : capabilityScore >= suite.profile.capabilityPassScore - 15 ? "warning" : "fail",
      detail: `${capabilityScore}% / ${suite.profile.capabilityPassScore}%`,
      trace: safeTrace({
        profile: suite.profile.id,
        tier: suite.tier,
        score: capabilityScore,
        pass_threshold: suite.profile.capabilityPassScore,
        weighting: suite.profile.capabilityWeights,
      }),
    },
    abilityItem(messages.checkReasoningName, grades.reasoning, answerTrace("reasoning")),
    abilityItem(messages.checkCodingName, grades.coding, answerTrace("coding")),
    abilityItem(messages.checkInstructionName, grades.instruction, answerTrace("instruction")),
    abilityItem(messages.checkChineseName, grades.chinese, answerTrace("chinese")),
    abilityItem(
      messages.checkMemoryName,
      grades.memory,
      safeTrace({ tier: suite.tier, expected: suite.memoryExpected, actual: grades.memoryActual }),
    ),
    {
      name: messages.checkKnowledgeCutoffName,
      category: "authenticity",
      status: knowledgeStatus,
      detail: `${grades.knowledgeCorrectCount}/${suite.knowledgeQuestions.length} · ${messages.checkKnowledgeRequired} ${grades.knowledgeRequired}${knowledgeBatchDetail}`,
      trace: safeTrace({
        profile: suite.profile.id,
        knowledge_set: suite.profile.knowledgeSet,
        knowledge_batch_id: suite.knowledgeBatchId,
        knowledge_batch_date: suite.knowledgeBatchDate,
        question_ids: suite.knowledgeQuestions.map((question) => question.id),
        correct: grades.knowledgeCorrectCount,
        required: grades.knowledgeRequired,
        results: grades.knowledgeResults,
      }),
    },
    {
      name: messages.checkProtocolName,
      category: "authenticity",
      status: protocolStatus,
      detail:
        protocolStatus === "pass"
          ? messages.checkProtocolStable
          : protocolStatus === "warning"
            ? messages.checkProtocolPartial
            : messages.checkProtocolWeak,
      trace: safeTrace({
        matched_hints: protocolScoreRaw,
        total_hints: protocolScoreMax,
        stage1: stage1.protocolHints,
        stage2: stage2.protocolHints,
        extra: extraProbes.map((probe) => probe.protocolHints),
      }),
    },
    {
      name: messages.checkResponseStructureName,
      category: "authenticity",
      status: responseStructureStatus,
      detail:
        responseStructureStatus === "pass"
          ? messages.checkResponseJsonValid
          : responseStructureStatus === "warning"
            ? messages.checkProtocolPartial
            : messages.checkResponseInvalid,
      trace: safeTrace({
        stage1_payload_parse_ok: stage1.parseOk,
        stage2_payload_parse_ok: stage2.parseOk,
        stage1_protocol_hints: stage1.protocolHints,
        stage2_protocol_hints: stage2.protocolHints,
        answer_json_instruction_followed: grades.jsonFormat,
      }),
    },
    {
      name: messages.checkIdentityName,
      category: "authenticity",
      status: identityStatus,
      detail: identityStatus === "pass"
        ? messages.checkIdentityConsistent
        : identityStatus === "warning"
          ? messages.checkIdentityUnavailable
          : messages.checkIdentityMismatch,
      trace: safeTrace({
        requested_model: requestedModel,
        profile_model: profileModel,
        reported_models: reportedModels,
      }),
    },
    {
      name: messages.checkMessageIdName,
      category: "authenticity",
      status: messageIdStatus,
      detail:
        messageIdStatus === "pass"
          ? messages.checkMessageIdFormat
          : messageIdStatus === "warning"
            ? messages.checkMessageIdMissing
            : messages.checkIdentityMismatch,
      trace: safeTrace({ message_ids: messageIdValues }),
    },
  ];

  if (isClaudeLike(suite.profile.authenticityStrategy)) {
    checks.push(
      {
        name: messages.checkThinkingChainName,
        category: "authenticity",
        status: thinkingStatus,
        detail: !thinkingApplicable
          ? messages.checkThinkingNotApplicable
          : thinkingStatus === "pass"
            ? messages.checkThinkingPresent
            : messages.checkThinkingNotFound,
        trace: safeTrace({
          stage1_content_types: stage1.contentTypes,
          stage2_content_types: stage2.contentTypes,
          extra_content_types: extraProbes.map((probe) => probe.contentTypes),
        }),
      },
      {
        name: messages.checkSignatureName,
        category: "authenticity",
        status: signatureStatus,
        detail: !signatureApplicable
          ? messages.checkSignatureNotApplicable
          : signatureStatus === "pass"
            ? messages.checkSignatureLengthOk
            : signatureStatus === "warning"
              ? signaturePartial ? messages.checkSignaturePartial : messages.checkSignatureShort
              : messages.checkSignatureMissing,
        trace: safeTrace({
          signature_length: signatureLength,
          signature_delta_count: stage1.signatureDeltaCount + stage2.signatureDeltaCount,
          stage1_signature_length: stage1.signatureDeltaTotalLength,
          stage2_signature_length: stage2.signatureDeltaTotalLength,
          extra_signature_lengths: extraProbes.map((probe) => probe.signatureDeltaTotalLength),
          signature_verdicts: allProbes.map((probe) => probe.signatureVerdict),
          signature_compatibility_verdicts: allProbes.map((probe) => probe.signatureCompatibilityVerdict),
          signature_formula_compatible: allProbes.map((probe) => probe.signatureFormulaCompatible),
          signature_base64_validity: allProbes.map((probe) => probe.signatureIsValidBase64),
          signature_envelope_models: allProbes.map((probe) => probe.signatureEnvelopeModel),
          signature_envelope_matches_requested: allProbes.map((probe) => probe.signatureEnvelopeMatchesRequested),
          signature_envelope_channels: allProbes.map((probe) => probe.signatureEnvelopeChannelValue),
          evidence_only: true,
          cryptographically_verified: allProbes.some((probe) => probe.signatureCryptographicallyVerified),
          threshold: 100,
        }),
      },
    );
  }

  const extraProbePasses: boolean[] = [];
  for (const [index, extra] of extraProbes.entries()) {
    const plan = suite.extraProbes[index];
    if (!plan || extra.upstreamStatus <= 0) continue;
    const normalized = extra.responseText.trim();
    const stopReason = extra.payload && typeof extra.payload === "object"
      ? (extra.payload as Record<string, unknown>).stop_reason
      : null;
    const matched =
      extra.upstreamStatus >= 200 &&
      extra.upstreamStatus < 300 &&
      extra.parseOk &&
      (plan.acceptedPatterns.some((pattern) => pattern.test(normalized)) ||
        (plan.id === "refusal" && stopReason === "refusal"));
    extraProbePasses.push(matched);
    checks.push({
      name:
        plan.id === "dynamic"
          ? messages.checkDynamicProbeName
          : plan.id === "refusal"
            ? messages.checkRefusalProbeName
            : messages.checkExactProbeName,
      category: "authenticity",
      status: matched ? "pass" : "fail",
      detail: matched ? messages.checkAbilityPass : messages.checkAbilityFail,
      trace: safeTrace({
        probe_id: plan.id,
        probe_family: suite.probeFamily,
        response: normalized.slice(0, 500),
        upstream_status: extra.upstreamStatus,
        stop_reason: stopReason,
        reported_model: extra.reportedModel,
      }),
    });
  }

  const capabilityPassed = capabilityScore >= suite.profile.capabilityPassScore;
  const behavioralStatus: EvidenceSignalStatus = capabilityPassed && protocolStatus !== "fail" && responseStructureStatus !== "fail" && extraProbePasses.every(Boolean)
    ? "pass"
    : capabilityScore >= suite.profile.capabilityPassScore - 15 && protocolStatus !== "fail"
      ? "warning"
      : "fail";

  return {
    checks,
    capabilityScore,
    authenticityScore: authenticity.score,
    // Quality-only profiles publish task capability as their one primary
    // score. Protocol/identity diagnostics remain visible, but must not create
    // a second browser-only formula that disagrees with the detection API.
    score: capabilityScore,
    behavioralStatus,
  };
}

function isExactOk(text: string): boolean {
  return /^ok$/i.test(text.trim());
}

function isGeminiMinimalUnsupported(probe: ProbeResult | undefined): boolean {
  if (!probe || probe.upstreamStatus !== 400) return false;
  const message = (probe.errorMessage ?? "").toLowerCase();
  return message.includes("minimal") && /thinking.?level|thinking_level|thinkingconfig\.thinkinglevel/.test(message);
}

function createSkippedProbe(prompt: string): ProbeResult {
  return {
    prompt,
    responseText: "",
    payload: null,
    latencyMs: 0,
    firstTokenLatencyMs: null,
    tps: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheHit: false,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheEvidenceFields: [],
    signatureDeltaTotalLength: 0,
    signatureDeltaCount: 0,
    signatureEmptyCount: 0,
    signatureIsValidBase64: null,
    signatureVerdict: null,
    signatureCompatibilityVerdict: null,
    signatureCompatibilityReason: null,
    signatureFormulaCompatible: false,
    sigModelName: null,
    signatureEnvelopeModel: null,
    signatureEnvelopeMatchesRequested: false,
    signatureEnvelopeChannelPresent: false,
    signatureEnvelopeChannelValue: null,
    signatureEnvelopeVersion: null,
    signatureEnvelopeKeyVersion: null,
    signatureEnvelopeSchemaVersion: null,
    signatureEnvelopeVariant: null,
    signatureEnvelopePayloadType: null,
    signatureEnvelopeSessionId: null,
    signatureEnvelopeEncryptedPayloadBytes: null,
    signatureFormat: null,
    signatureStructureIssues: [],
    signatureReason: null,
    signatureStructurallyParsed: false,
    signatureCryptographicallyVerified: false,
    payloadMessageId: null,
    messageId: null,
    streamMessageStartModel: null,
    sseEventTypes: [],
    rawSseEventCount: 0,
    upstreamStatus: 0,
    finalUpstreamUrl: null,
    upstreamRedirected: false,
    responseHeaders: {},
    requestCompatibilityFallbacks: [],
    errorMessage: null,
    streamMessageStartInputTokens: null,
    streamMessageDeltaInputTokensSamples: [],
    streamOutputTokensSamples: [],
    contentTypes: [],
    jsonParseOk: false,
    parseOk: false,
    mode: "openai-chat",
    reportedModel: null,
    protocolHints: {
      hasModel: false,
      hasRole: false,
      hasContentArray: false,
      hasUsage: false,
      hasStopReason: false,
    },
  };
}

function getIdentityStatus(
  probes: ProbeResult[],
  requestedModel: string,
  profileModel?: string | null,
): EvidenceSignalStatus {
  const usableProbes = probes.filter(isUsableEvidenceProbe);
  const reportedModels = reportedModelsFromUsableProbes(probes);
  if (reportedModels.length === 0) return "warning";
  const successfulProbeCount = usableProbes.length;
  const probesWithModel = usableProbes.filter((probe) => Boolean(probe.reportedModel || probe.streamMessageStartModel)).length;
  if (reportedModels.some((model) => !modelMatchesRequested(requestedModel, model, profileModel))) return "fail";
  return probesWithModel >= successfulProbeCount ? "pass" : "warning";
}

function isUnclassifiedCustomModelEcho(requestedModel: string, reportedModel: string | null | undefined): boolean {
  if (!reportedModel || resolveModelProfileId(requestedModel)) return false;
  return requestedModel.trim().toLowerCase() === reportedModel.trim().toLowerCase();
}

function summarizeSignatureEvidence(probes: ProbeResult[]): SignatureEvidence {
  const usableProbes = probes.filter(isUsableEvidenceProbe);
  const hardFailure = usableProbes.find((probe) =>
    probe.signatureVerdict === "FAIL" ||
    probe.signatureVerdict === "FORGED" ||
    probe.signatureVerdict === "ERROR" ||
    probe.signatureCompatibilityVerdict === "FAIL" ||
    probe.signatureCompatibilityVerdict === "FORGED" ||
    probe.signatureCompatibilityVerdict === "ERROR",
  );
  const cryptographic = usableProbes.find((probe) =>
    probe.signatureCryptographicallyVerified &&
    (probe.signatureVerdict === "PASS" || probe.signatureVerdict === "PARTIAL"),
  );
  const formulaCompatible = usableProbes.find((probe) =>
    probe.signatureFormulaCompatible &&
    (probe.signatureCompatibilityVerdict === "PASS" || probe.signatureCompatibilityVerdict === "PARTIAL"),
  );
  const observed = usableProbes.find((probe) =>
    probe.signatureVerdict && probe.signatureVerdict !== "UNKNOWN",
  );

  const hardFailureVerdict = hardFailure
    ? ["FAIL", "FORGED", "ERROR"].includes(String(hardFailure.signatureVerdict))
      ? hardFailure.signatureVerdict
      : hardFailure.signatureCompatibilityVerdict
    : null;

  return {
    // A complete protobuf envelope can reproduce the public formula's
    // PASS/PARTIAL classification without claiming provider-key verification.
    verdict: hardFailureVerdict ?? cryptographic?.signatureVerdict ?? formulaCompatible?.signatureCompatibilityVerdict ?? (observed ? "UNKNOWN" : null),
    modelName: cryptographic?.sigModelName ?? formulaCompatible?.signatureEnvelopeModel ?? null,
    cryptographicallyVerified: Boolean(cryptographic),
    formulaCompatible: Boolean(cryptographic || formulaCompatible),
    directEnvelope: Boolean(
      formulaCompatible &&
      formulaCompatible.signatureCompatibilityVerdict === "PASS" &&
      !formulaCompatible.signatureEnvelopeChannelPresent,
    ),
    wireFormatPresent: usableProbes.some((probe) => probe.signatureDeltaTotalLength > 0),
  };
}

function scoreStatus(score: number, passThreshold: number): EvidenceSignalStatus {
  if (score >= passThreshold) return "pass";
  if (score >= Math.max(0, passThreshold - 15)) return "warning";
  return "fail";
}

function upstreamKindLabel(kind: UpstreamAvailabilityKind, messages: I18nMessages): string {
  if (kind === "rate-limited") return messages.upstreamRateLimited;
  if (kind === "authentication-error") return messages.upstreamAuthenticationError;
  if (kind === "service-error") return messages.upstreamServiceError;
  if (kind === "network-error") return messages.upstreamNetworkError;
  if (kind === "invalid-response") return messages.upstreamRequestRejected;
  return messages.upstreamUnavailable;
}

function upstreamUnavailableDetail(summary: UpstreamAvailabilitySummary, messages: I18nMessages): string {
  const status = summary.statusCodes.length > 0
    ? `HTTP ${summary.statusCodes.join(", ")}`
    : messages.upstreamNoValidResponse;
  return `${messages.upstreamProbeSkipped} · ${upstreamKindLabel(summary.failureKind ?? summary.kind, messages)} · ${status}`;
}

function markChecksUpstreamUnavailable(
  checks: CheckItem[],
  summary: UpstreamAvailabilitySummary,
  messages: I18nMessages,
): CheckItem[] {
  const detail = upstreamUnavailableDetail(summary, messages);
  return [{
    name: messages.upstreamUnavailable,
    status: "warning",
    detail,
    category: "operational",
    trace: safeTrace({
      http_status: summary.statusCodes,
      upstream_messages: summary.messages,
      skipped_checks: checks.map((item) => item.name),
    }),
  }];
}

function classifyClaudeSignatureFamily(value: string | null): string | null {
  return classifyClaudeFamily(value);
}

function expectedClaudeSignatureFamily(modelId: string): string | null {
  return expectedClaudeFamily(modelId);
}

function shouldSuppressUnstableFrontierSignatureCap(signature: SignatureEvidence, expectedFamily: string | null): boolean {
  return signature.directEnvelope === true &&
    String(signature.verdict ?? "").toUpperCase() === "PASS" &&
    Boolean(expectedFamily) &&
    classifyClaudeSignatureFamily(signature.modelName) === expectedFamily;
}

function officialSignatureCheckStatus(options: {
  expectedFamily: string | null;
  signature: SignatureEvidence;
  fable: boolean;
}): CheckStatus {
  const verdict = String(options.signature.verdict ?? "").toUpperCase();
  const signatureFamily = classifyClaudeSignatureFamily(options.signature.modelName);
  const unknownSignature = !signatureFamily;
  const matches = !unknownSignature && Boolean(options.expectedFamily) && signatureFamily === options.expectedFamily;
  if (["FAIL", "FORGED", "ERROR"].includes(verdict)) return "fail";
  if (!options.signature.cryptographicallyVerified && !options.signature.formulaCompatible) {
    // Missing private verification (including an absent signature_delta) is an
    // evidence gap, not an objective signature conflict. The conservative
    // score still withholds the formula points and the detail explains why.
    return "warning";
  }
  if (verdict === "PASS" && matches) return "pass";
  if (verdict === "PASS" && unknownSignature) return "warning";
  if (verdict === "PARTIAL" && (matches || unknownSignature || signatureFamily === "unknown-claude-internal")) return "warning";
  if ((verdict === "UNKNOWN" || !verdict) && options.signature.wireFormatPresent) return "warning";
  if (options.fable && unknownSignature) return "warning";
  return "fail";
}

function signatureCheckDetail(options: {
  messages: I18nMessages;
  expectedFamily: string | null;
  signature: SignatureEvidence;
  status: CheckStatus;
}): { detail: string; conservativePenalty: number } {
  const { messages, expectedFamily, signature, status } = options;
  const base = status === "fail"
    ? messages.checkFail
    : signature.verdict === "PARTIAL"
      ? `${messages.checkSignaturePartial} · ${messages.checkSignatureEvidenceOnly}`
      : signature.wireFormatPresent
        ? messages.checkSignatureEvidenceOnly
        : `${messages.checkSignatureMissing} · ${messages.checkSignatureEvidenceOnly}`;
  if (signature.cryptographicallyVerified || signature.formulaCompatible || status === "fail") {
    return { detail: base, conservativePenalty: 0 };
  }
  const conservativePenalty = claudeSignaturePenalty({
    verdict: signature.verdict,
    sigModelName: signature.modelName,
    expectedFamily,
  });
  return {
    detail: `${base} · ${messages.checkSignaturePrivatePenalty.replace("{points}", String(conservativePenalty))}`,
    conservativePenalty,
  };
}

type OfficialClaudeScoreOptions = {
  probes: readonly ProbeResult[];
  expectedFamily: string | null;
  upstreamModelId: string | null;
  signature: SignatureEvidence;
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
  thinkingApplicable?: boolean;
  includeIdentityEvidence?: boolean;
};

function officialClaudeScoreResult(options: OfficialClaudeScoreOptions) {
  return scoreClaudeCompatibility({
    variant: options.thinkingApplicable === false ? "frontier" : "standard",
    probes: options.probes.map((probe) => ({
      protocolHints: probe.protocolHints,
      parseOk: probe.parseOk,
      upstreamMessageId: comparableMessageId(probe),
      inputTokens: probe.inputTokens,
      outputTokens: probe.outputTokens,
      cacheReadTokens: probe.cacheReadInputTokens,
      cacheWriteTokens: probe.cacheCreationInputTokens,
      rawSseEventCount: probe.rawSseEventCount,
      sseEventTypes: probe.sseEventTypes,
      streamMessageStartModel: probe.streamMessageStartModel,
      streamMessageStartInputTokens: probe.streamMessageStartInputTokens,
      streamMessageDeltaInputTokensSamples: probe.streamMessageDeltaInputTokensSamples,
      streamOutputTokensSamples: probe.streamOutputTokensSamples,
      emptySignatureDeltaCount: probe.signatureEmptyCount,
      contentTypes: probe.contentTypes,
      responseText: probe.responseText,
    })),
    expectedFamily: options.expectedFamily,
    upstreamModelId: options.upstreamModelId,
    signature: { verdict: options.signature.verdict, sigModelName: options.signature.modelName },
    knowledgePassed: options.knowledgePassed,
    pdfExecuted: options.pdfExecuted,
    pdfPass: options.pdfPass,
    calcExecuted: options.calcExecuted,
    calcJsonLegal: options.calcJsonLegal,
    calcResultCorrect: options.calcResultCorrect,
    rightQuoteCount: options.rightQuoteCount,
    mainStageSignatureDeltaSum: options.mainStageSignatureDeltaSum,
    suppressStageSignatureCap: options.suppressStageSignatureCap,
    modelFeaturePass: options.modelFeaturePass,
    includeIdentityEvidence: options.includeIdentityEvidence,
  });
}

function officialClaudeScore(options: OfficialClaudeScoreOptions): number {
  return officialClaudeScoreResult(options).score;
}

function claudeScoreWithoutPenalty(
  result: ReturnType<typeof scoreClaudeCompatibility>,
  penaltyName: string,
): number {
  const penalty = result.penalties[penaltyName] ?? 0;
  if (!penalty) return result.score;
  const adjustedTotalPenalty = result.totalPenalty - penalty;
  const uncapped = Math.max(0, Math.min(100, Math.round(100 - adjustedTotalPenalty)));
  return result.familyConflict || result.stageConflict ? Math.min(uncapped, 34) : uncapped;
}

function officialClaudeScoreBreakdown(
  options: OfficialClaudeScoreOptions,
  privateSignatureProbeExecuted: boolean,
): { score: number; familyConflict: boolean; breakdown: PrivateSignatureScoreBreakdown } {
  const result = officialClaudeScoreResult(options);
  const verdict = String(options.signature.verdict ?? "").toUpperCase();
  const objectiveFailure = ["FAIL", "FORGED", "ERROR"].includes(verdict);
  const privateVerdictUnavailable = !options.signature.cryptographicallyVerified && !options.signature.formulaCompatible && !objectiveFailure;
  const publicObservableScore = privateVerdictUnavailable
    ? claudeScoreWithoutPenalty(result, "signature")
    : result.score;
  const score = privateVerdictUnavailable && !privateSignatureProbeExecuted
    ? publicObservableScore
    : result.score;
  return {
    score,
    familyConflict: result.familyConflict,
    breakdown: {
      publicObservableScore,
      privateSignatureAdjustment: score - publicObservableScore,
      privateSignatureStatus: options.signature.cryptographicallyVerified
        ? "verified"
        : options.signature.formulaCompatible
          ? "envelope_compatible"
        : privateSignatureProbeExecuted
          ? "unavailable"
          : "not_observed",
    },
  };
}

function isGeminiChallenge(text: string): boolean {
  const value = text.trim();
  if (!value || /[A-Za-z0-9]/.test(value) || /[的了]/.test(value)) return false;
  const words = value.split(/\s+/).map((word) => word.replace(/^[\s，。！？、；：“”"'（）()《》〈〉【】,.!?;:]+|[\s，。！？、；：“”"'（）()《》〈〉【】,.!?;:]+$/gu, "")).filter(Boolean);
  const chineseCount = (word: string) => (word.match(/[\u3400-\u9FFF]/g) ?? []).length;
  return words.length === 5 && words.every((word) => /^[\u3400-\u9FFF]+$/u.test(word)) && chineseCount(words[2]) === 3 && words.reduce((sum, word) => sum + chineseCount(word), 0) === 13 && /夕阳|落日|晚霞|残阳|斜阳|暮阳|夕照/.test(value);
}

function parseStructuredProbe(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next common provider format.
    }
  }
  return null;
}

function parseNumberedAnswers(text: string): Map<number, string> {
  const answers = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s*[|.:：)\]-]\s*(.+)$/);
    const index = Number(match?.[1]);
    if (match && Number.isInteger(index) && index >= 1 && !answers.has(index)) {
      answers.set(index, match[2].trim());
    }
  }
  if (answers.size > 0) return answers;

  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string") answers.set(index + 1, item.trim());
      });
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const index = Number(key);
        if (Number.isInteger(index) && index >= 1 && typeof item === "string") {
          answers.set(index, item.trim());
        }
      }
    }
  } catch {
    // Numbered lines are the primary wire format; invalid JSON stays empty.
  }
  return answers;
}

function normalizeProbeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.,!?;:()[\]{}'"`·‘’]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isKnowledgeAbstention(value: string): boolean {
  const normalized = normalizeProbeAnswer(value);
  return /^(?:i do not know|i don t know|unknown|不知道|不清楚|无法确定|无法回答|无法获知)$/.test(normalized);
}

function parseNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildFamilyChecks(
  family: "gemini" | "liveness" | "fable" | "claude-frontier" | "claude-standard",
  probes: ProbeResult[],
  suite: EvaluationSuite,
  requestedModel: string,
  profileModel: string,
  messages: I18nMessages,
): FamilyCheckAssessment {
  if (family === "liveness") {
    const probe = probes[0];
    const passed = Boolean(probe?.parseOk && isExactOk(probe.responseText));
    return {
      checks: [{
        name: messages.checkExactProbeName,
        category: "operational",
        status: passed ? "pass" : "fail",
        detail: passed ? messages.checkAbilityPass : messages.checkAbilityFail,
        trace: safeTrace({ response: probe?.responseText ?? "", mode: probe?.mode ?? null }),
      }],
      score: passed ? 100 : 0,
      capabilityScore: passed ? 100 : 0,
      authenticityScore: passed ? 100 : 0,
      behavioralStatus: passed ? "pass" : "fail",
      familyConflict: false,
      stageIdentityOnlyConflict: false,
      customProfileEchoConflict: false,
    };
  }

  if (family === "fable" || family === "claude-frontier") {
    const isFableFamily = family === "fable";
    const byId = (id: string) => probes.find((probe) => {
      if (id === "knowledge") return probe.prompt.startsWith("请回答下面的近期知识题");
      if (id === "pdf") return probe.prompt.startsWith("What text does this PDF");
      if (id === "calc") return probe.prompt.startsWith("Calculate ") || probe.prompt.startsWith("计算 ");
      if (id === "model-feature") return probe.prompt.startsWith("AAA");
      if (id === "signature") return /sha256 3次/.test(probe.prompt);
      return false;
    });
    const knowledge = byId("knowledge");
    const pdf = byId("pdf");
    const calc = byId("calc");
    const feature = byId("model-feature");
    const knowledgeAnswers = parseNumberedAnswers(knowledge?.responseText ?? "");
    const knowledgeResults = suite.knowledgeQuestions.map((question, index) => {
      const actual = knowledgeAnswers.get(index + 1) ?? "";
      const normalized = normalizeProbeAnswer(actual);
      const abstained = isKnowledgeAbstention(actual);
      const passed = Boolean(normalized) && !abstained && knowledgeAnswerMatches(question, actual);
      return { id: question.id, expected: question.answer, actual, passed, abstained };
    });
    const knowledgeCorrectCount = knowledgeResults.filter((result) => result.passed).length;
    const knowledgeAbstainedCount = knowledgeResults.filter((result) => result.abstained).length;
    const knowledgePass = knowledgeCorrectCount >= suite.profile.knowledgeRequired;
    const knowledgeStatus: CheckStatus = knowledgePass ? "pass" : "fail";
    const knowledgeBatchDetail = suite.knowledgeQuestions.length > 0
      ? ` · ${messages.checkKnowledgeBatch} ${suite.knowledgeBatchDate} · ${messages.checkKnowledgeSource} ${suite.profile.knowledgeSet}`
      : "";
    const pdfPlan = suite.extraProbes.find((probe) => probe.id === "pdf");
    const pdfPass = Boolean(
      pdf &&
      pdf.upstreamStatus >= 200 &&
      pdf.upstreamStatus < 300 &&
      pdf.parseOk &&
      pdfPlan?.acceptedPatterns.some((pattern) => pattern.test(pdf.responseText)),
    );
    const calcPlan = suite.extraProbes.find((probe) => probe.id === "calc");
    const calcValue = parseStructuredProbe(calc?.responseText ?? "");
    const calcResult = parseNumber(calcValue?.result);
    const actualExpression = typeof calcValue?.expression === "string"
      ? calcValue.expression.replace(/\s+/g, "")
      : "";
    const expectedExpression = (calcPlan?.expectedExpression ?? "").replace(/\s+/g, "");
    const calcExpressionCorrect = Boolean(expectedExpression && actualExpression === expectedExpression);
    // The public verifier only requires a JSON object with a numeric result.
    // Expression text is retained as a diagnostic, not a scoring condition.
    const calcJsonLegal = Boolean(
      calcValue &&
      typeof calcValue.result === "number" &&
      Number.isFinite(calcValue.result),
    );
    const calcPass = Boolean(
      calc &&
      calc.upstreamStatus >= 200 &&
      calc.upstreamStatus < 300 &&
      calc.parseOk &&
      calcJsonLegal &&
      Math.round(calcResult ?? Number.NaN) === calcPlan?.expectedResult,
    );
    const pdfAvailable = Boolean(pdf && pdf.upstreamStatus > 0);
    const calcAvailable = Boolean(calc && calc.upstreamStatus > 0);
    const featurePass = !isFableFamily || Boolean(
        feature &&
        feature.upstreamStatus >= 200 &&
        feature.upstreamStatus < 300 &&
        feature.parseOk &&
        feature.payload &&
        typeof feature.payload === "object" &&
        (feature.payload as Record<string, unknown>).stop_reason === "refusal",
      );
    // The public Fable formula scores knowledge/PDF/calculation and evaluates
    // the refusal probe separately. Other frontier profiles score all four.
    // The public verifier omits optional probes when the request failed before
    // an upstream HTTP response. Keep real 4xx/5xx responses in the score, but
    // do not turn a transport timeout into a capability failure.
    const hasUpstreamResponse = (probe: ProbeResult | undefined): probe is ProbeResult =>
      Boolean(probe && probe.upstreamStatus > 0);
    const scoringProbes = (isFableFamily ? probes.filter((probe) => probe !== feature) : probes)
      .filter((probe) => probe === knowledge || hasUpstreamResponse(probe));
    const protocolHits = scoringProbes.flatMap((probe) => Object.values(probe.protocolHints)).filter(Boolean).length;
    const protocolRatio = scoringProbes.length > 0 ? protocolHits / (scoringProbes.length * 5) : 0;
    const protocolStatus: CheckStatus = protocolRatio >= 0.8 ? "pass" : protocolRatio >= 0.4 ? "warning" : "fail";
    // The public Claude verifier takes the model identity from the primary
    // knowledge response. PDF/calculation responses can be generated by a
    // compatibility wrapper and must not turn an otherwise consistent run
    // into an identity conflict.
    const identityModel = knowledge?.reportedModel || knowledge?.streamMessageStartModel || null;
    const customModelEcho = isUnclassifiedCustomModelEcho(requestedModel, identityModel);
    const identityStatus: CheckStatus = !identityModel
      ? "warning"
      : customModelEcho
        ? "warning"
        : modelMatchesRequested(requestedModel, identityModel, profileModel)
          ? "pass"
          : "fail";
    const reportedModels = identityModel ? [identityModel] : [];
    const structureStatus: CheckStatus = scoringProbes.length > 0 && scoringProbes.every((probe) => probe.parseOk)
      ? "pass"
      : scoringProbes.some((probe) => probe.parseOk) ? "warning" : "fail";
    const messageIdPairs = scoringProbes
      .map((probe) => ({ probe, value: comparableMessageId(probe) }))
      .filter((pair): pair is { probe: ProbeResult; value: string } => Boolean(pair.value));
    const messageIds = messageIdPairs.map((pair) => pair.value);
    const messageIdStatus: CheckStatus = messageIds.length === 0
      ? "warning"
      : messageIdPairs.every((pair) => messageIdMatches(pair.probe, pair.value)) ? "pass" : "fail";
    const responseParseFailures = scoringProbes.filter((probe) =>
      !probe.parseOk || probe.upstreamStatus < 200 || probe.upstreamStatus >= 300,
    ).length;
    const integrityStatus: CheckStatus = responseParseFailures === 0
      ? "pass"
      : responseParseFailures === 1 ? "warning" : "fail";
    const signatureProbe = byId("signature");
    const fableSignatureProbe = [calc, knowledge].find((probe) =>
      probe && (probe.signatureDeltaTotalLength > 0 ||
        Boolean(probe.signatureEnvelopeModel) ||
        (probe.signatureVerdict !== null && probe.signatureVerdict !== "UNKNOWN")),
    );
    const signatureProbes = (isFableFamily ? [fableSignatureProbe] : [signatureProbe]).filter(
      (probe): probe is ProbeResult => Boolean(probe),
    );
    const signatureLength = signatureProbes.reduce((sum, probe) => sum + probe.signatureDeltaTotalLength, 0);
    const signatureEvidence = summarizeSignatureEvidence(signatureProbes);
    const customSignatureEcho = isUnclassifiedCustomModelEcho(requestedModel, signatureEvidence.modelName);
    const scoringSignatureEvidence = signatureEvidence;
    const expectedSignatureFamily = expectedClaudeSignatureFamily(profileModel);
    const signatureStatus = officialSignatureCheckStatus({
      expectedFamily: expectedSignatureFamily,
      signature: scoringSignatureEvidence,
      fable: isFableFamily,
    });
    const signatureDetail = signatureCheckDetail({
      messages,
      expectedFamily: expectedSignatureFamily,
      signature: scoringSignatureEvidence,
      status: signatureStatus,
    });
    const upstreamModelId = knowledge?.reportedModel ?? knowledge?.streamMessageStartModel ?? null;
    const knowledgeModelEcho = isUnclassifiedCustomModelEcho(requestedModel, upstreamModelId);
    const scoringUpstreamModelId = upstreamModelId;
    const mainStageSignatureDeltaSum = [knowledge, pdf, calc]
      .filter((probe): probe is ProbeResult => Boolean(probe && (probe === knowledge || probe.upstreamStatus > 0)))
      .reduce((sum, probe) => sum + probe.signatureDeltaTotalLength, 0);
    const suppressStageSignatureCap = !isFableFamily &&
      shouldSuppressUnstableFrontierSignatureCap(scoringSignatureEvidence, expectedSignatureFamily);
    const stageIdentityConflict = !isFableFamily && mainStageSignatureDeltaSum >= 1 && !suppressStageSignatureCap;
    const checks: CheckItem[] = [
      { name: messages.checkKnowledgeCutoffName, category: "ability", status: knowledgeStatus, detail: `${knowledgeCorrectCount}/${suite.knowledgeQuestions.length} · ${messages.checkKnowledgeRequired} ${suite.profile.knowledgeRequired}${knowledgeBatchDetail}${knowledgePass ? "" : ` · ${messages.checkFail}`}`, trace: safeTrace({ knowledge_batch_id: suite.knowledgeBatchId, knowledge_batch_date: suite.knowledgeBatchDate, knowledge_set: suite.profile.knowledgeSet, question_ids: suite.knowledgeQuestions.map((question) => question.id), results: knowledgeResults, correct: knowledgeCorrectCount, abstained: knowledgeAbstainedCount, required: suite.profile.knowledgeRequired }) },
      { name: messages.checkPdfProbeName, category: "ability", status: !pdfAvailable ? "warning" : pdfPass ? "pass" : "fail", detail: !pdfAvailable ? messages.checkProtocolPartial : pdfPass ? messages.checkPass : messages.checkFail, trace: safeTrace({ probe: "pdf", response: pdf?.responseText ?? "", status: pdf?.upstreamStatus ?? null, counted_in_score: pdfAvailable }) },
      { name: messages.checkStructuredOutputProbeName, category: "ability", status: !calcAvailable ? "warning" : calcPass ? "pass" : calcJsonLegal ? "warning" : "fail", detail: !calcAvailable ? messages.checkProtocolPartial : calcPass ? messages.checkPass : calcJsonLegal ? messages.checkProtocolPartial : messages.checkFail, trace: safeTrace({ probe: "calc", expected_expression: calcPlan?.expectedExpression ?? null, expected_result: calcPlan?.expectedResult ?? null, json_legal: calcJsonLegal, expression_correct: calcExpressionCorrect, expression: typeof calcValue?.expression === "string" ? calcValue.expression : null, result: calcResult, counted_in_score: calcAvailable }) },
      { name: messages.checkIdentityName, category: "authenticity", status: stageIdentityConflict ? "fail" : "pass", detail: stageIdentityConflict ? messages.checkIdentityMismatch : messages.checkIdentityConsistent, trace: safeTrace({ main_stage_signature_delta_sum: mainStageSignatureDeltaSum, public_score_cap: stageIdentityConflict ? 34 : null, stage_cap_suppressed_by_direct_envelope: suppressStageSignatureCap, adaptive_thinking_can_change_this_signal: !isFableFamily }) },
      ...(isFableFamily ? [{ name: messages.checkRefusalProbeName, category: "authenticity" as const, status: featurePass ? "pass" as const : "fail" as const, detail: featurePass ? messages.checkPass : messages.checkFail, trace: safeTrace({ expected_stop_reason: "refusal", actual_stop_reason: feature?.payload && typeof feature.payload === "object" ? (feature.payload as Record<string, unknown>).stop_reason ?? null : null }) }] : []),
      { name: messages.checkModelConsistencyName, category: "authenticity", status: identityStatus, detail: identityStatus === "pass" ? messages.checkIdentityConsistent : identityStatus === "warning" ? messages.checkIdentityUnavailable : messages.checkIdentityMismatch, trace: safeTrace({ requested_model: requestedModel, profile_model: profileModel, reported_models: reportedModels, custom_model_echo: knowledgeModelEcho }) },
      { name: messages.checkProtocolName, category: "authenticity", status: protocolStatus, detail: protocolStatus === "pass" ? messages.checkProtocolStable : protocolStatus === "warning" ? messages.checkProtocolPartial : messages.checkProtocolWeak },
      { name: messages.checkResponseStructureName, category: "authenticity", status: structureStatus, detail: structureStatus === "pass" ? messages.checkResponseJsonValid : structureStatus === "warning" ? messages.checkProtocolPartial : messages.checkResponseInvalid, trace: safeTrace({ probes: scoringProbes.map((probe) => ({ json_parse_ok: probe.jsonParseOk, response_shape_ok: probe.parseOk, protocol_hints: probe.protocolHints })) }) },
      { name: messages.checkResponseIntegrityName, category: "authenticity", status: integrityStatus, detail: integrityStatus === "pass" ? messages.checkPass : integrityStatus === "warning" ? messages.checkProtocolPartial : messages.checkFail, trace: safeTrace({ statuses: scoringProbes.map((probe) => probe.upstreamStatus), parse_ok: scoringProbes.map((probe) => probe.parseOk), json_parse_ok: scoringProbes.map((probe) => probe.jsonParseOk) }) },
      { name: messages.checkMessageIdName, category: "authenticity", status: messageIdStatus, detail: messageIdStatus === "pass" ? messages.checkMessageIdFormat : messageIdStatus === "warning" ? messages.checkMessageIdMissing : messages.checkIdentityMismatch, trace: safeTrace({ payload_message_ids: messageIds, transport_message_ids: probes.map((probe) => probe.messageId) }) },
      { name: messages.checkSignatureName, category: "authenticity", status: signatureStatus, detail: signatureStatus === "pass" ? `${messages.checkSignatureLengthOk} · ${messages.checkSignatureEvidenceOnly}` : signatureDetail.detail, trace: safeTrace({ evidence_only: !scoringSignatureEvidence.cryptographicallyVerified, cryptographically_verified: scoringSignatureEvidence.cryptographicallyVerified, formula_compatible: scoringSignatureEvidence.formulaCompatible === true, conservative_score_penalty: signatureDetail.conservativePenalty, signature_length: signatureLength, custom_model_echo: customSignatureEcho, probes: signatureProbes.map((probe) => ({ verdict: probe.signatureVerdict, compatibility_verdict: probe.signatureCompatibilityVerdict, compatibility_reason: probe.signatureCompatibilityReason, formula_compatible: probe.signatureFormulaCompatible, valid_base64: probe.signatureIsValidBase64, sig_model_name: probe.sigModelName, envelope_model: probe.signatureEnvelopeModel, envelope_model_family: classifyClaudeSignatureFamily(probe.signatureEnvelopeModel), envelope_matches_profile_family: classifyClaudeSignatureFamily(probe.signatureEnvelopeModel) === expectedClaudeSignatureFamily(profileModel), envelope_matches_requested_exactly: probe.signatureEnvelopeMatchesRequested, envelope_channel_present: probe.signatureEnvelopeChannelPresent, envelope_channel_value: probe.signatureEnvelopeChannelValue, envelope_version: probe.signatureEnvelopeVersion, envelope_key_version: probe.signatureEnvelopeKeyVersion, envelope_schema_version: probe.signatureEnvelopeSchemaVersion, envelope_variant: probe.signatureEnvelopeVariant, envelope_payload_type: probe.signatureEnvelopePayloadType, envelope_session_id: probe.signatureEnvelopeSessionId, envelope_encrypted_payload_bytes: probe.signatureEnvelopeEncryptedPayloadBytes, envelope_format: probe.signatureFormat, envelope_reason: probe.signatureReason, envelope_structurally_parsed: probe.signatureStructurallyParsed, structure_issues: probe.signatureStructureIssues })) }) },
    ];
    // Quality is based on task correctness and protocol validity. Identity,
    // model labels, and unverified signature strings are reported separately
    // and must not make a known-good upstream look like a lower-capability
    // model.
    const scoreOptions = {
      probes: scoringProbes,
      expectedFamily: expectedSignatureFamily,
      upstreamModelId: scoringUpstreamModelId,
      signature: scoringSignatureEvidence,
      knowledgePassed: knowledgePass,
      pdfExecuted: hasUpstreamResponse(pdf),
      pdfPass,
      calcExecuted: hasUpstreamResponse(calc),
      calcJsonLegal,
      calcResultCorrect: calcPass,
      modelFeaturePass: isFableFamily ? featurePass : undefined,
      mainStageSignatureDeltaSum,
      suppressStageSignatureCap,
      thinkingApplicable: false,
    } satisfies Omit<Parameters<typeof officialClaudeScore>[0], "includeIdentityEvidence">;
    const qualityScore = officialClaudeScore({ ...scoreOptions, includeIdentityEvidence: false });
    const behavior = officialClaudeScoreBreakdown(
      { ...scoreOptions, includeIdentityEvidence: true },
      isFableFamily ? hasUpstreamResponse(fableSignatureProbe) : hasUpstreamResponse(signatureProbe),
    );
    const behaviorScore = behavior.score;
    const stageIdentityOnlyConflict = stageIdentityConflict && qualityScore === 100 &&
      identityStatus !== "fail" && signatureStatus !== "fail" && protocolStatus !== "fail" &&
      structureStatus !== "fail" && integrityStatus !== "fail" && messageIdStatus !== "fail";
    const customProfileEchoConflict = !stageIdentityConflict && behaviorScore < qualityScore && qualityScore === 100 &&
      (knowledgeModelEcho || customSignatureEcho) && identityStatus !== "fail" &&
      (signatureStatus !== "fail" || customSignatureEcho) && protocolStatus !== "fail" &&
      structureStatus !== "fail" && integrityStatus !== "fail" && messageIdStatus !== "fail";
    return {
      checks,
      score: behaviorScore,
      capabilityScore: qualityScore,
      authenticityScore: behaviorScore,
      behavioralStatus: scoreStatus(behaviorScore, 60),
      signatureEvidence: scoringSignatureEvidence,
      familyConflict: behavior.familyConflict,
      stageIdentityOnlyConflict,
      customProfileEchoConflict,
      scoreBreakdown: behavior.breakdown,
    };
  }

  if (family === "claude-standard") {
    const stage1 = probes[0];
    const knowledge = probes[1];
    const pdf = probes.find((probe) => probe.prompt.startsWith("What text does this PDF"));
    const calc = probes.find((probe) => probe.prompt.startsWith("计算 "));
    // This mirrors the archived standard-Claude reference verifier: the probe is
    // an anti-echo signal, so emitting the requested quote is a conflict.
    const rightQuotePass = profileModel === "claude-sonnet-5" || !stage1?.responseText.includes("”");
    const answers = parseNumberedAnswers(knowledge?.responseText ?? "");
    const knowledgeResults = suite.knowledgeQuestions.map((question, index) => {
      const actual = answers.get(index + 1) ?? "";
      return { id: question.id, expected: question.answer, actual, passed: knowledgeAnswerMatches(question, actual) };
    });
    const knowledgeCorrectCount = knowledgeResults.filter((result) => result.passed).length;
    const knowledgePass = knowledgeCorrectCount >= suite.profile.knowledgeRequired;
    const knowledgeBatchDetail = suite.knowledgeQuestions.length > 0
      ? ` · ${messages.checkKnowledgeBatch} ${suite.knowledgeBatchDate} · ${messages.checkKnowledgeSource} ${suite.profile.knowledgeSet}`
      : "";
    const pdfPlan = suite.extraProbes.find((probe) => probe.id === "pdf");
    const pdfPass = Boolean(
      pdf &&
      pdf.upstreamStatus >= 200 &&
      pdf.upstreamStatus < 300 &&
      pdf.parseOk &&
      pdfPlan?.acceptedPatterns.some((pattern) => pattern.test(pdf.responseText)),
    );
    const calcPlan = suite.extraProbes.find((probe) => probe.id === "calc");
    const calcValue = parseStructuredProbe(calc?.responseText ?? "");
    const calcResult = parseNumber(calcValue?.result);
    const actualExpression = typeof calcValue?.expression === "string"
      ? calcValue.expression.replace(/\s+/g, "")
      : "";
    const expectedExpression = (calcPlan?.expectedExpression ?? "").replace(/\s+/g, "");
    const calcExpressionCorrect = Boolean(expectedExpression && actualExpression === expectedExpression);
    // Match the public verifier: JSON legality is based on a numeric result;
    // expression text is diagnostic only.
    const calcJsonLegal = Boolean(
      calcValue &&
      typeof calcValue.result === "number" &&
      Number.isFinite(calcValue.result),
    );
    const calcPass = Boolean(
      calc &&
      calc.upstreamStatus >= 200 &&
      calc.upstreamStatus < 300 &&
      calc.parseOk &&
      calcJsonLegal &&
      Math.round(calcResult ?? Number.NaN) === calcPlan?.expectedResult,
    );
    const pdfAvailable = Boolean(pdf && pdf.upstreamStatus > 0);
    const calcAvailable = Boolean(calc && calc.upstreamStatus > 0);
    const scoringProbes = probes.filter((probe, index) => index < 2 || probe.upstreamStatus > 0);
    const identityStatus = getIdentityStatus(probes, requestedModel, profileModel);
    const protocolHits = scoringProbes.flatMap((probe) => Object.values(probe.protocolHints)).filter(Boolean).length;
    const protocolRatio = scoringProbes.length > 0 ? protocolHits / (scoringProbes.length * 5) : 0;
    const protocolStatus: CheckStatus = protocolRatio >= 0.8 ? "pass" : protocolRatio >= 0.4 ? "warning" : "fail";
    const responseParseFailures = scoringProbes.filter((probe) =>
      !probe.parseOk || probe.upstreamStatus < 200 || probe.upstreamStatus >= 300,
    ).length;
    const integrityStatus: CheckStatus = responseParseFailures === 0
      ? "pass"
      : responseParseFailures === 1 ? "warning" : "fail";
    const hasThinkingBlock = scoringProbes.some((probe) => probe.contentTypes.includes("thinking"));
    const hasThinkingText = scoringProbes.some((probe) => typeof probe.responseText === "string" && /thinking/i.test(probe.responseText));
    const thinkingStatus: CheckStatus = hasThinkingBlock ? "pass" : hasThinkingText ? "warning" : "fail";
    const signatureProbe = profileModel === "claude-sonnet-5"
      ? probes.find((probe) =>
        probe.signatureFormulaCompatible ||
        Boolean(probe.signatureEnvelopeModel) ||
        (probe.signatureVerdict !== null && probe.signatureVerdict !== "UNKNOWN"),
      ) ?? knowledge
      : knowledge;
    const signature = summarizeSignatureEvidence([signatureProbe].filter((probe): probe is ProbeResult => Boolean(probe)));
    const standardUpstreamModelId = stage1?.reportedModel ?? stage1?.streamMessageStartModel ??
      knowledge?.reportedModel ?? knowledge?.streamMessageStartModel ?? null;
    const customModelEcho = isUnclassifiedCustomModelEcho(requestedModel, standardUpstreamModelId);
    const customSignatureEcho = isUnclassifiedCustomModelEcho(requestedModel, signature.modelName);
    const signatureStatus = officialSignatureCheckStatus({
      expectedFamily: expectedClaudeSignatureFamily(profileModel),
      signature,
      fable: false,
    });
    const signatureDetail = signatureCheckDetail({
      messages,
      expectedFamily: expectedClaudeSignatureFamily(profileModel),
      signature,
      status: signatureStatus,
    });
    const messageIdPairs = scoringProbes
      .map((probe) => ({ probe, value: comparableMessageId(probe) }))
      .filter((pair): pair is { probe: ProbeResult; value: string } => Boolean(pair.value));
    const messageIds = messageIdPairs.map((pair) => pair.value);
    const messageIdStatus: CheckStatus = messageIds.length === 0
      ? "warning"
      : messageIdPairs.every((pair) => messageIdMatches(pair.probe, pair.value)) ? "pass" : "fail";
    const scoreOptions = {
      probes: scoringProbes,
      expectedFamily: expectedClaudeSignatureFamily(profileModel),
      upstreamModelId: standardUpstreamModelId,
      signature,
      knowledgePassed: knowledgePass,
      pdfExecuted: Boolean(pdf && pdf.upstreamStatus > 0),
      pdfPass,
      calcExecuted: Boolean(calc && calc.upstreamStatus > 0),
      calcJsonLegal,
      calcResultCorrect: calcPass,
      rightQuoteCount: stage1?.responseText.match(/”/g)?.length ?? 0,
    } satisfies Omit<Parameters<typeof officialClaudeScore>[0], "includeIdentityEvidence">;
    const score = officialClaudeScore({ ...scoreOptions, thinkingApplicable: true, includeIdentityEvidence: false });
    const checks: CheckItem[] = [
      { name: messages.checkKnowledgeCutoffName, category: "ability", status: knowledgePass ? "pass" : "fail", detail: `${knowledgeCorrectCount}/${suite.knowledgeQuestions.length} · ${messages.checkKnowledgeRequired} ${suite.profile.knowledgeRequired}${knowledgeBatchDetail}${knowledgePass ? "" : ` · ${messages.checkFail}`}`, trace: safeTrace({ knowledge_batch_id: suite.knowledgeBatchId, knowledge_batch_date: suite.knowledgeBatchDate, knowledge_set: suite.profile.knowledgeSet, question_ids: suite.knowledgeQuestions.map((question) => question.id), results: knowledgeResults }) },
      { name: messages.checkPdfProbeName, category: "ability", status: !pdfAvailable ? "warning" : pdfPass ? "pass" : "fail", detail: !pdfAvailable ? messages.checkProtocolPartial : pdfPass ? messages.checkPass : messages.checkFail, trace: safeTrace({ probe: "pdf", response: pdf?.responseText ?? "", status: pdf?.upstreamStatus ?? null, counted_in_score: pdfAvailable }) },
      { name: messages.checkStructuredOutputProbeName, category: "ability", status: !calcAvailable ? "warning" : calcPass ? "pass" : calcJsonLegal ? "warning" : "fail", detail: !calcAvailable ? messages.checkProtocolPartial : calcPass ? messages.checkPass : calcJsonLegal ? messages.checkProtocolPartial : messages.checkFail, trace: safeTrace({ probe: "calc", expected_expression: calcPlan?.expectedExpression ?? null, expected: calcPlan?.expectedResult ?? null, actual_expression: actualExpression, expression_correct: calcExpressionCorrect, actual: calcResult, counted_in_score: calcAvailable }) },
      { name: messages.checkIdentityName, category: "authenticity", status: rightQuotePass ? "pass" : "fail", detail: rightQuotePass ? messages.checkPass : messages.checkFail, trace: safeTrace({ right_quote_count: stage1?.responseText.match(/”/g)?.length ?? 0 }) },
      { name: messages.checkModelConsistencyName, category: "authenticity", status: identityStatus, detail: identityStatus === "pass" ? messages.checkIdentityConsistent : identityStatus === "warning" ? messages.checkIdentityUnavailable : messages.checkIdentityMismatch },
      { name: messages.checkMessageIdName, category: "authenticity", status: messageIdStatus, detail: messageIdStatus === "pass" ? messages.checkMessageIdFormat : messageIdStatus === "warning" ? messages.checkMessageIdMissing : messages.checkIdentityMismatch, trace: safeTrace({ payload_message_ids: probes.map((probe) => probe.payloadMessageId), transport_message_ids: probes.map((probe) => probe.messageId) }) },
      { name: messages.checkSignatureName, category: "authenticity", status: signatureStatus, detail: signatureDetail.detail, trace: safeTrace({ ...signature, evidence_only: true, conservative_score_penalty: signatureDetail.conservativePenalty }) },
      { name: messages.checkThinkingChainName, category: "authenticity", status: thinkingStatus, detail: thinkingStatus === "pass" ? messages.checkThinkingPresent : messages.checkThinkingNotFound, trace: safeTrace({ content_types: probes.map((probe) => probe.contentTypes) }) },
      { name: messages.checkProtocolName, category: "authenticity", status: protocolStatus, detail: protocolStatus === "pass" ? messages.checkProtocolStable : protocolStatus === "warning" ? messages.checkProtocolPartial : messages.checkProtocolWeak },
      { name: messages.checkResponseIntegrityName, category: "authenticity", status: integrityStatus, detail: integrityStatus === "pass" ? messages.checkPass : integrityStatus === "warning" ? messages.checkProtocolPartial : messages.checkFail, trace: safeTrace({ statuses: probes.map((probe) => probe.upstreamStatus), parse_ok: probes.map((probe) => probe.parseOk), json_parse_ok: probes.map((probe) => probe.jsonParseOk) }) },
    ];
    const behavior = officialClaudeScoreBreakdown(
      { ...scoreOptions, includeIdentityEvidence: true },
      Boolean(signatureProbe && signatureProbe.upstreamStatus > 0),
    );
    const behaviorScore = behavior.score;
    const stageIdentityOnlyConflict = !rightQuotePass && score === 100 &&
      identityStatus !== "fail" && signatureStatus !== "fail" && protocolStatus !== "fail" &&
      integrityStatus !== "fail" && messageIdStatus !== "fail";
    const customProfileEchoConflict = rightQuotePass && behaviorScore < score && score === 100 &&
      (customModelEcho || customSignatureEcho) && identityStatus !== "fail" &&
      (signatureStatus !== "fail" || customSignatureEcho) && protocolStatus !== "fail" &&
      integrityStatus !== "fail" && messageIdStatus !== "fail";
    return {
      checks,
      score: behaviorScore,
      capabilityScore: score,
      authenticityScore: behaviorScore,
      behavioralStatus: scoreStatus(behaviorScore, 60),
      signatureEvidence: signature,
      familyConflict: behavior.familyConflict,
      stageIdentityOnlyConflict,
      customProfileEchoConflict,
      scoreBreakdown: behavior.breakdown,
    };
  }

  const medium = probes[0];
  const minimal = probes[1];
  const challenge = probes[2];
  const mediumPass = Boolean(medium?.upstreamStatus >= 200 && medium.upstreamStatus < 300 && medium.parseOk && isExactOk(medium.responseText));
  const minimalExpectedError = isGeminiMinimalUnsupported(minimal);
  const minimal2xx = Boolean(minimal && minimal.upstreamStatus >= 200 && minimal.upstreamStatus < 300 && minimal.parseOk);
  const challengePass = Boolean(challenge?.parseOk && isGeminiChallenge(challenge.responseText));
  const variantPass = minimalExpectedError || (minimal2xx && challengePass);
  const protocolPass = probes.length > 0 && probes.every((probe) => probe.mode === "google-generative");
  const successfulProbes = probes.filter((probe) => probe.upstreamStatus >= 200 && probe.upstreamStatus < 300);
  const mediumProtocolHits = medium
    ? [medium.protocolHints.hasContentArray, medium.protocolHints.hasUsage, medium.protocolHints.hasStopReason].filter(Boolean).length
    : 0;
  const structurePass = Boolean(
    medium?.parseOk &&
    mediumProtocolHits >= 2 &&
    successfulProbes.every((probe) => probe.parseOk),
  );
  const structureStatus: CheckStatus = structurePass ? "pass" : medium?.parseOk ? "warning" : "fail";
  const score = scoreGeminiCompatibility({
    mediumStatus: mediumPass ? "pass" : "fail",
    variantStatus: variantPass ? "pass" : "fail",
    protocolStatus: protocolPass ? "pass" : "fail",
    responseStructureStatus: structureStatus,
    usedFallbackChallenge: Boolean(challenge),
    fallbackTokenCount: challenge?.totalTokens ?? 0,
    fallbackLatencyMs: challenge?.latencyMs ?? 0,
  });
  const status = (passed: boolean): CheckStatus => passed ? "pass" : "fail";
  return {
    checks: [
      { name: "Gemini medium thinking", category: "authenticity", status: status(mediumPass), detail: mediumPass ? messages.checkAbilityPass : messages.checkAbilityFail, trace: safeTrace({ response: medium?.responseText ?? "" }) },
      { name: "Gemini model variant", category: "authenticity", status: status(variantPass), detail: variantPass ? messages.checkAbilityPass : messages.checkAbilityFail, trace: safeTrace({ minimal_status: minimal?.upstreamStatus ?? null, minimal_error: minimal?.errorMessage ?? null, challenge_response: challenge?.responseText ?? null }) },
      { name: messages.checkProtocolName, category: "authenticity", status: status(protocolPass), detail: protocolPass ? messages.checkProtocolStable : messages.checkProtocolWeak },
      { name: messages.checkResponseStructureName, category: "authenticity", status: structureStatus, detail: structurePass ? messages.checkResponseJsonValid : messages.checkResponseInvalid },
    ],
    score,
    capabilityScore: score,
    authenticityScore: score,
    behavioralStatus: scoreStatus(score, officialPassThreshold(profileModel)),
    familyConflict: false,
    stageIdentityOnlyConflict: false,
    customProfileEchoConflict: false,
  };
}

function buildGptQuizChecks(
  probe: ProbeResult,
  suite: EvaluationSuite,
  requestedModel: string,
  profileModel: string,
  messages: I18nMessages,
): { checks: CheckItem[]; score: number; capabilityScore: number; authenticityScore: number; behavioralStatus: EvidenceSignalStatus; customProfileEchoConflict: boolean } {
  const answers = parseNumberedAnswers(probe.responseText);
  const unknown = /^(?:i\s*(?:do not|don't)\s*know|unknown|不知道|不清楚|无法确定)$/i;
  const results = suite.knowledgeQuestions.map((question, index) => {
    const actual = answers.get(index + 1) ?? "";
    const normalized = normalizeProbeAnswer(actual);
    return {
      id: question.id,
      actual,
      passed: Boolean(normalized) && !unknown.test(normalized) && knowledgeAnswerMatches(question, actual),
    };
  });
  const correct = results.filter((result) => result.passed).length;
  const knowledgeStatus: CheckStatus = correct >= suite.profile.knowledgeRequired ? "pass" : "fail";
  const reportedModel = probe.reportedModel || probe.streamMessageStartModel;
  const customModelEcho = isUnclassifiedCustomModelEcho(requestedModel, reportedModel);
  const scoringReportedModel = reportedModel;
  const capabilityScore = suite.knowledgeQuestions.length > 0
    ? Math.round((correct / suite.knowledgeQuestions.length) * 100)
    : 0;
  const visibleIdentityStatus: CheckStatus = !reportedModel
    ? "warning"
    : modelMatchesRequested(requestedModel, reportedModel, profileModel) ? "pass" : "fail";
  // Match the official GPT verifier: protocol means the OpenAI wire mode,
  // while response structure is scored from parse success plus at least two
  // of role/usage/stop_reason hints.
  const structureHints = [
    probe.protocolHints.hasRole,
    probe.protocolHints.hasUsage,
    probe.protocolHints.hasStopReason,
  ].filter(Boolean).length;
  const structureStatus: CheckStatus = probe.parseOk && structureHints >= 2
    ? "pass"
    : probe.parseOk
      ? "warning"
      : "fail";
  const preliminaryProtocolStatus: CheckStatus = probe.mode === "openai-chat" || probe.mode === "openai-responses"
    ? "pass"
    : "warning";
  const preliminaryAssessment = scoreGptCompatibility({
    algorithmModel: profileModel,
    reportedModel: scoringReportedModel,
    quizStatus: knowledgeStatus,
    protocolStatus: preliminaryProtocolStatus,
    responseStructureStatus: structureStatus,
    tokenUsage: {
      inputTokens: probe.inputTokens,
      outputTokens: probe.outputTokens,
      cacheReadTokens: probe.cacheReadInputTokens,
      cacheWriteTokens: probe.cacheCreationInputTokens,
    },
  });
  const officialAssessment = preliminaryAssessment.mismatch === true
    ? scoreGptCompatibility({
        algorithmModel: profileModel,
        reportedModel: scoringReportedModel,
        quizStatus: knowledgeStatus,
        protocolStatus: "fail",
        responseStructureStatus: structureStatus,
        tokenUsage: {
          inputTokens: probe.inputTokens,
          outputTokens: probe.outputTokens,
          cacheReadTokens: probe.cacheReadInputTokens,
          cacheWriteTokens: probe.cacheCreationInputTokens,
        },
      })
    : preliminaryAssessment;
  const protocolStatus: CheckStatus = officialAssessment.mismatch === true ? "fail" : preliminaryProtocolStatus;
  const score = officialAssessment.supported ? officialAssessment.score ?? 0 : capabilityScore;
  const authenticityScore = officialAssessment.supported ? score : 0;
  const identityStatus: CheckStatus = officialAssessment.mismatch === true && !customModelEcho ? "fail" : visibleIdentityStatus;
  const customProfileEchoConflict = customModelEcho && officialAssessment.mismatch === true &&
    knowledgeStatus === "pass" && preliminaryProtocolStatus === "pass" && structureStatus !== "fail";
  return {
    checks: [
      {
        name: messages.checkKnowledgeCutoffName,
        category: "ability",
        status: knowledgeStatus,
        detail: `${correct}/${suite.knowledgeQuestions.length}${suite.knowledgeQuestions.length > 0 ? ` · ${messages.checkKnowledgeBatch} ${suite.knowledgeBatchDate} · ${messages.checkKnowledgeSource} ${suite.profile.knowledgeSet}` : ""}${knowledgeStatus === "pass" ? "" : ` · ${messages.checkFail}`}`,
        trace: safeTrace({ knowledge_batch_id: suite.knowledgeBatchId, knowledge_batch_date: suite.knowledgeBatchDate, knowledge_set: suite.profile.knowledgeSet, question_ids: suite.knowledgeQuestions.map((question) => question.id), results }),
      },
      {
        name: messages.checkIdentityName,
        category: "authenticity",
        status: identityStatus,
        detail: identityStatus === "pass" ? messages.checkIdentityConsistent : identityStatus === "warning" ? messages.checkIdentityUnavailable : messages.checkIdentityMismatch,
        trace: safeTrace({ requested_model: requestedModel, profile_model: profileModel, reported_model: reportedModel, scoring_reported_model: scoringReportedModel, custom_model_echo: customModelEcho }),
      },
      {
        name: messages.checkProtocolName,
        category: "authenticity",
        status: protocolStatus,
        detail: protocolStatus === "pass" ? messages.checkProtocolStable : protocolStatus === "warning" ? messages.checkProtocolPartial : messages.checkProtocolWeak,
      },
      {
        name: messages.checkResponseStructureName,
        category: "authenticity",
        status: structureStatus,
        detail: structureStatus === "pass" ? messages.checkResponseJsonValid : messages.checkResponseInvalid,
      },
      ...(officialAssessment.tokenPenalty?.applicable ? [{
        name: messages.checkGptTokenName,
        category: "authenticity" as const,
        status: officialAssessment.tokenPenalty.total > 0 ? "warning" as const : "pass" as const,
        detail: officialAssessment.tokenPenalty.total > 0
          ? messages.checkGptTokenPenalty.replace("{points}", String(officialAssessment.tokenPenalty.total))
          : messages.checkGptTokenWithinThreshold,
        trace: safeTrace({
          thresholds: { input: 2000, output: 2000, cache_read: 1000, cache_write: 1000 },
          penalty: officialAssessment.tokenPenalty,
        }),
      }] : []),
    ],
    score,
    capabilityScore,
    authenticityScore,
    behavioralStatus: officialAssessment.supported
      ? knowledgeStatus === "pass" && officialAssessment.variantStatus === "pass" && score >= officialPassThreshold(profileModel) ? "pass" : "fail"
      : "warning",
    customProfileEchoConflict,
  };
}

async function runClaudeCacheCheckSingle(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  profileModel: string;
  protocol: ApiProtocol;
  metadataUserId: string;
  signal?: AbortSignal;
  messages: I18nMessages;
}): Promise<CacheReport> {
  type CacheObservationRun = { rounds: CacheRound[]; requestAttempts: number };
  const annotateReport = (report: CacheReport, requestProfile: CacheRequestProfile): CacheReport => {
    const baseline = getCacheBaselineInfo(options.profileModel, requestProfile);
    const templateComparable = true;
    const comparable = templateComparable && hasOfficialComparableCacheBaseline(options.profileModel) &&
      baseline.source === "official-canonical" && Boolean(baseline.rounds) && report.rounds.length === 5;
    return {
      ...report,
      observationModel: options.profileModel,
      baselineModel: baseline.model,
      baselineSource: baseline.source,
      baselineAvailable: Boolean(baseline.rounds),
      baselineComparison: comparable ? "compared" : baseline.rounds ? "reference-only" : "none",
      requestTemplateVersion: requestProfile === "claude_code"
        ? CLAUDE_CODE_CACHE_TEMPLATE_VERSION
        : CACHE_PROBE_TEMPLATE_VERSION,
      requestTemplateComparable: templateComparable,
    };
  };
  const endpointMode = resolveEndpoint(options.baseUrl, options.model, options.protocol).mode;
  if (!canRunCacheObservation(options.profileModel)) {
    return annotateReport({
      ...summarizeCacheRounds([], false),
      reason: "model_not_supported",
    }, "custom");
  }
  if (endpointMode !== "anthropic") {
    return annotateReport({
      ...summarizeCacheRounds([], false),
      reason: "protocol_not_supported",
    }, "custom");
  }

  const runRounds = async (requestProfile: CacheRequestProfile): Promise<CacheObservationRun> => {
    // The public runner stamps each request profile independently. A 4xx
    // custom-to-Claude-Code fallback therefore starts a fresh cache run.
    const cacheRunId = createCacheRunId();
    const cacheSessionId = requestProfile === "claude_code" ? createUuid() : "";
    const rounds: CacheRound[] = [];
    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    let requestAttempts = 0;
    try {
      for (let round = 1; round <= 5; round += 1) {
        throwIfAborted(options.signal);
        const prompt = `[cachecheck round ${round - 1}] Do not call any tools. Reply with one short sentence only.`;
        const stage = cacheProbeStage(round - 1);
        const sendCacheProbe = () => sendProbe({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          model: options.model,
          protocol: options.protocol,
          stage,
          prompt,
          history,
          cacheControl: true,
          cacheRunId,
          cacheRequestProfile: requestProfile,
          cacheSessionId,
          timeoutMs: DEFAULT_CACHE_REQUEST_TIMEOUT_MS,
          metadataUserId: options.metadataUserId,
          signal: options.signal,
          messages: options.messages,
        });
        let probe: ProbeResult | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            requestAttempts += 1;
            const candidate = await sendCacheProbe();
            if (candidate.upstreamStatus < 200 || candidate.upstreamStatus >= 300 || !candidate.parseOk ||
              isProviderErrorEnvelope(candidate.payload) || !hasProtocolResponseShape(candidate.payload, candidate.mode)) {
              throw new UserVisibleError({
                title: options.messages.probeInvalidResponseTitle,
                detail: candidate.errorMessage || options.messages.upstreamInvalidResponse,
                source: "upstream",
                stage,
                statusCode: candidate.upstreamStatus,
              });
            }
            probe = candidate;
            break;
          } catch (error) {
            const statusCode = error instanceof UserVisibleError ? error.info.statusCode : null;
            const retryable = statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500 && statusCode < 600);
            const terminalClientError = typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
            if (terminalClientError || attempt === 1) throw error;
            if (attempt === 0) {
              const waitMs = retryable && error instanceof UserVisibleError && error.info.retryAfterMs
                ? error.info.retryAfterMs
                : DEFAULT_CACHE_ROUND_DELAY_MS;
              await abortableDelay(waitMs, options.signal);
              continue;
            }
          }
        }
        if (!probe) throw new Error("cache_probe_missing");
        const snapshot = extractCacheUsage({
          input_tokens: probe.inputTokens ?? 0,
          output_tokens: probe.outputTokens ?? 0,
          cache_read_input_tokens: probe.cacheReadInputTokens,
          cache_creation_input_tokens: probe.cacheCreationInputTokens,
        });
        rounds.push({
          round,
          latencyMs: probe.latencyMs,
          inputTokens: snapshot.inputTokens,
          outputTokens: snapshot.outputTokens,
          cacheReadTokens: snapshot.cacheReadTokens,
          cacheCreationTokens: snapshot.cacheCreationTokens,
          hitRate: probe.cacheEvidenceFields.length > 0 ? calculateCacheHitRate(snapshot) : null,
          evidence: probe.cacheEvidenceFields.length > 0,
          evidenceFields: probe.cacheEvidenceFields,
          inputTokensIncludeCache: snapshot.inputTokensIncludeCache,
          usageObserved: probe.inputTokens !== null || probe.outputTokens !== null || probe.cacheEvidenceFields.length > 0,
          usageComplete: probe.inputTokens !== null && probe.outputTokens !== null,
        });
        history.push({ role: "user", text: prompt });
        history.push({ role: "assistant", text: probe.responseText || "(empty)" });
        if (round < 5) await abortableDelay(DEFAULT_CACHE_ROUND_DELAY_MS, options.signal);
      }
    } catch (error) {
      if (error && typeof error === "object") {
        (error as { cacheRounds?: CacheRound[] }).cacheRounds = rounds;
        (error as { cacheRequestAttempts?: number }).cacheRequestAttempts = requestAttempts;
      }
      throw error;
    }
    return { rounds, requestAttempts };
  };
  const createReport = (
    rounds: CacheRound[],
    requestProfile: CacheRequestProfile,
    requestAttempts: number,
    requestProfilesUsed: CacheRequestProfile[] = [requestProfile],
  ): CacheReport => {
    const baseline = getCacheBaselineInfo(options.profileModel, requestProfile);
    const comparison = compareCacheBaseline(
      rounds,
      baseline.source === "official-canonical" && rounds.length === 5
        ? baseline.rounds
        : null,
    );
    const summary = summarizeCacheRounds(comparison.rounds, true);
    const measuredComparison = summary.meteringComplete
      ? comparison
      : {
          ...comparison,
          baselineMultiplier: null,
          comparisonHitRate: null,
          comparisonAssumption: null,
          compatibilityScore: null,
          measuredCostIndex: undefined,
        };
    return annotateReport({
      ...summary,
      ...measuredComparison,
      requestProfile,
      completedRounds: rounds.length,
      logicalRounds: 5,
      requestAttempts,
      requestProfilesUsed,
    }, requestProfile);
  };
  const failureDetail = (error: unknown): string =>
    error instanceof UserVisibleError
      ? compactErrorText(error.info.detail, 260, options.apiKey)
      : error instanceof Error && error.message
        ? compactErrorText(error.message, 260, options.apiKey)
        : "cache_probe_failed";
  const failureStatus = (error: unknown): number | null =>
    error instanceof UserVisibleError && typeof error.info.statusCode === "number"
      ? error.info.statusCode
      : null;
  const roundsFromError = (error: unknown): CacheRound[] =>
    error && typeof error === "object" && Array.isArray((error as { cacheRounds?: unknown }).cacheRounds)
      ? (error as { cacheRounds: CacheRound[] }).cacheRounds
      : [];
  const requestAttemptsFromError = (error: unknown): number =>
    error && typeof error === "object" && typeof (error as { cacheRequestAttempts?: unknown }).cacheRequestAttempts === "number"
      ? Math.max(0, (error as { cacheRequestAttempts: number }).cacheRequestAttempts)
      : roundsFromError(error).length;
  const upstreamUnavailableReport = (
    error: unknown,
    requestProfile: CacheRequestProfile,
    requestAttempts = requestAttemptsFromError(error),
    requestProfilesUsed: CacheRequestProfile[] = [requestProfile],
  ): CacheReport | null => {
    const detail = failureDetail(error);
    if (!isUpstreamUnavailable(failureStatus(error), detail)) return null;
    const partialRounds = roundsFromError(error);
    const report = summarizeCacheRounds(partialRounds, true);
    const comparison = compareCacheBaseline(partialRounds, null);
    return annotateReport({
      // Preserve completed rounds when the cache endpoint fails mid-run. The
      // report remains failed, but showing `2/5` is more truthful than
      // resetting the run to `0/5` and losing the available token evidence.
      ...report,
      ...comparison,
      status: report.status === "partial" ? "partial" : "failed",
      reason: "upstream_unavailable",
      requestProfile,
      completedRounds: partialRounds.length,
      logicalRounds: 5,
      requestAttempts,
      requestProfilesUsed,
      failureDetail: detail,
    }, requestProfile);
  };
  const shouldRetryWithClaudeCode = (error: unknown): boolean => {
    if (!(error instanceof UserVisibleError)) return false;
    const statusCode = error.info.statusCode;
    if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500 || statusCode === 429) return false;
    if (!isCacheProbeStage(error.info.stage)) return false;
    // Match the public verifier: any non-rate-limit 4xx from the custom cache
    // profile is treated as a request-shape incompatibility and retried once
    // with the Claude Code profile. A 429 remains a hard rate-limit signal.
    return true;
  };

  let customRun: CacheObservationRun | null = null;
  try {
    customRun = await runRounds("custom");
    return createReport(customRun.rounds, "custom", customRun.requestAttempts);
  } catch (customError) {
    if (isAbortError(customError)) throw customError;
    if (shouldRetryWithClaudeCode(customError)) {
      try {
        const claudeCodeRun = await runRounds("claude_code");
        const customAttempts = requestAttemptsFromError(customError);
        return createReport(
          claudeCodeRun.rounds,
          "claude_code",
          customAttempts + claudeCodeRun.requestAttempts,
          ["custom", "claude_code"],
        );
      } catch (claudeCodeError) {
        if (isAbortError(claudeCodeError)) throw claudeCodeError;
        const customAttempts = requestAttemptsFromError(customError);
        const unavailable = upstreamUnavailableReport(
          claudeCodeError,
          "claude_code",
          customAttempts + requestAttemptsFromError(claudeCodeError),
          ["custom", "claude_code"],
        );
        if (unavailable) return unavailable;
        const partialRounds = roundsFromError(claudeCodeError);
        const report = summarizeCacheRounds(partialRounds, true);
        return annotateReport({
          ...report,
          ...compareCacheBaseline(partialRounds, null),
          status: report.status === "partial" ? "partial" : "failed",
          requestProfile: "claude_code",
          completedRounds: partialRounds.length,
          logicalRounds: 5,
          requestAttempts: customAttempts + requestAttemptsFromError(claudeCodeError),
          requestProfilesUsed: ["custom", "claude_code"],
          failureDetail: failureDetail(claudeCodeError),
        }, "claude_code");
      }
    }
    const unavailable = upstreamUnavailableReport(customError, "custom");
    if (unavailable) return unavailable;
    const partialRounds = customRun?.rounds.length ? customRun.rounds : roundsFromError(customError);
    const report = summarizeCacheRounds(partialRounds, true);
    return annotateReport({
      ...report,
      ...compareCacheBaseline(partialRounds, null),
      status: report.status === "partial" ? "partial" : "failed",
      requestProfile: "custom",
      completedRounds: partialRounds.length,
      logicalRounds: 5,
      requestAttempts: customRun?.requestAttempts ?? requestAttemptsFromError(customError),
      requestProfilesUsed: ["custom"],
      failureDetail: failureDetail(customError),
    }, "custom");
  }
}

/**
 * Run one or more independent official-style cache validation groups.
 *
 * A group is always five logical rounds (one cache write followed by four
 * warm reads). Independent groups use fresh cache run IDs, so their results
 * are not accidentally treated as one long ten/fifteen-round sequence.
 */
async function runClaudeCacheCheck(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  profileModel: string;
  protocol: ApiProtocol;
  metadataUserId: string;
  signal?: AbortSignal;
  messages: I18nMessages;
  cacheRuns?: number;
}): Promise<CacheReport> {
  const requestedRuns = Math.min(3, Math.max(1, Math.trunc(options.cacheRuns ?? 1)));
  const reports: CacheReport[] = [];
  const isComplete = (report: CacheReport): boolean =>
    report.applicable &&
    (report.completedRounds ?? report.rounds.length) >= (report.logicalRounds ?? 5) &&
    report.status !== "failed" &&
    report.status !== "partial" &&
    report.status !== "incomplete";
  for (let index = 0; index < requestedRuns; index += 1) {
    throwIfAborted(options.signal);
    const report = await runClaudeCacheCheckSingle(options);
    reports.push(report);
    // A failed or partial group is not a stable observation. Stop rather
    // than amplifying an upstream error with more billable requests.
    if (!isComplete(report)) break;
    if (index < requestedRuns - 1) await abortableDelay(DEFAULT_CACHE_ROUND_DELAY_MS, options.signal);
  }
  const completeReports = reports.filter(isComplete);
  const stripNestedRuns = (report: CacheReport): CacheRunReport => {
    const { runs: _runs, requestedRuns: _requested, completedRuns: _completed, aggregation: _aggregation, ...single } = report;
    return single;
  };
  const median = (values: Array<number | null | undefined>): number | null => {
    const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
    if (finite.length === 0) return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 === 1 ? finite[middle] : Number(((finite[middle - 1] + finite[middle]) / 2).toFixed(3));
  };

  // Keep one complete group as the visible round table. Numeric summary
  // values are replaced with medians only when every requested group finished.
  const representative = completeReports[0] ?? reports[0] ?? await runClaudeCacheCheckSingle(options);
  if (requestedRuns === 1) {
    return {
      ...representative,
      requestedRuns: 1,
      completedRuns: completeReports.length,
      aggregation: "single",
      meteringComplete: representative.meteringComplete === true,
    };
  }

  const allGroupsComplete = reports.length === requestedRuns && completeReports.length === requestedRuns;
  const runs = reports.map(stripNestedRuns);
  const requestAttempts = reports.reduce(
    (sum, report) => sum + (report.requestAttempts ?? report.rounds.length),
    0,
  );
  const requestProfilesUsed = [...new Set(reports.flatMap((report) => report.requestProfilesUsed ?? []))];
  const evidenceFields = [...new Set(reports.flatMap((report) => report.evidenceFields))];
  const aggregateReason = reports.find((report) => report.reason === "upstream_unavailable")?.reason ?? representative.reason;
  if (!allGroupsComplete) {
    return {
      ...representative,
      status: "incomplete",
      compatibilityScore: null,
      baselineMultiplier: null,
      comparisonHitRate: null,
      hitRate: null,
      warmHitRate: null,
      requestedRuns,
      completedRuns: completeReports.length,
      aggregation: "median",
      runs,
      requestAttempts,
      requestProfilesUsed,
      evidenceFields,
      meteringObserved: reports.some((report) => report.meteringObserved),
      meteringComplete: false,
      reason: aggregateReason,
      failureDetail: options.messages.cacheMultiRunIncomplete,
    };
  }

  const allConfirmed = completeReports.every((report) => report.status === "confirmed");
  const allUnobserved = completeReports.every((report) => report.status === "unobserved");
  const aggregateStatus: CacheReport["status"] = allConfirmed
    ? "confirmed"
    : allUnobserved
      ? "unobserved"
      : "unconfirmed";
  const comparisonAssumption = completeReports.some(
    (report) => report.comparisonAssumption === "missing_usage_treated_as_zero",
  )
    ? "missing_usage_treated_as_zero" as const
    : null;
  const meteringComplete = completeReports.every((report) => report.meteringComplete === true);

  return {
    ...representative,
    status: aggregateStatus,
    compatibilityScore: meteringComplete ? median(completeReports.map((report) => report.compatibilityScore)) : null,
    baselineMultiplier: meteringComplete ? median(completeReports.map((report) => report.baselineMultiplier)) : null,
    baselineHitRate: median(completeReports.map((report) => report.baselineHitRate)),
    comparisonHitRate: meteringComplete ? median(completeReports.map((report) => report.comparisonHitRate)) : null,
    hitRate: meteringComplete ? median(completeReports.map((report) => report.hitRate)) : null,
    warmHitRate: meteringComplete ? median(completeReports.map((report) => report.warmHitRate)) : null,
    measuredCostIndex: meteringComplete
      ? median(completeReports.map((report) => report.measuredCostIndex)) ?? representative.measuredCostIndex
      : undefined,
    baselineCostIndex: median(completeReports.map((report) => report.baselineCostIndex)),
    cacheReadTokens: median(completeReports.map((report) => report.cacheReadTokens)) ?? representative.cacheReadTokens,
    cacheCreationTokens: median(completeReports.map((report) => report.cacheCreationTokens)) ?? representative.cacheCreationTokens,
    evidenceFields,
    meteringObserved: reports.some((report) => report.meteringObserved),
    meteringComplete,
    comparisonAssumption,
    evidenceSufficient: allConfirmed,
    requestedRuns,
    completedRuns: completeReports.length,
    aggregation: "median",
    runs,
    requestAttempts,
    requestProfilesUsed,
  };
}

function inspectImageProbe(probe: ProbeResult): ImageProbeResult {
  const payload = probe.payload as { data?: unknown } | null;
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const first = data[0] && typeof data[0] === "object" ? data[0] as Record<string, unknown> : null;
  const base64 = typeof first?.b64_json === "string" ? first.b64_json.trim() : "";
  const imageUrl = typeof first?.url === "string" ? first.url.trim() : "";
  const imageValue = base64 || imageUrl;
  const knownBase64Header = /^(?:iVBOR|\/9j\/|UklGR|R0lGOD)/.test(base64);
  const validImageUrl = /^https?:\/\//i.test(imageUrl);
  const validDataUrl = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(imageValue);

  return {
    hasDataArray: Array.isArray(payload?.data),
    hasImage: Boolean(imageValue),
    imageValueLength: imageValue.length,
    imageFormatValid: knownBase64Header || validImageUrl || validDataUrl,
    revisedPrompt: typeof first?.revised_prompt === "string" ? first.revised_prompt : null,
  };
}

function buildImageChecks(probe: ProbeResult, messages: I18nMessages): { checks: CheckItem[]; score: number } {
  const image = inspectImageProbe(probe);
  const payloadStatus: CheckStatus = probe.parseOk && image.hasDataArray ? "pass" : "fail";
  const contentStatus: CheckStatus = image.hasImage ? "pass" : "fail";
  const formatStatus: CheckStatus = image.imageFormatValid ? "pass" : image.hasImage ? "warning" : "fail";
  const sizeStatus: CheckStatus = image.imageValueLength >= 1024
    ? "pass"
    : image.imageValueLength > 0
      ? "warning"
      : "fail";
  const checks: CheckItem[] = [
    {
      name: messages.checkImagePayloadName,
      category: "operational",
      status: payloadStatus,
      detail: payloadStatus === "pass" ? messages.checkImagePayloadValid : messages.checkImagePayloadInvalid,
      trace: safeTrace({ has_data_array: image.hasDataArray, parse_ok: probe.parseOk }),
    },
    {
      name: messages.checkImageContentName,
      category: "operational",
      status: contentStatus,
      detail: contentStatus === "pass" ? messages.checkImageContentPresent : messages.checkImageContentMissing,
      trace: safeTrace({ revised_prompt: image.revisedPrompt }),
    },
    {
      name: messages.checkImageFormatName,
      category: "operational",
      status: formatStatus,
      detail: formatStatus === "pass" ? messages.checkImageFormatValid : messages.checkImageFormatUnknown,
    },
    {
      name: messages.checkImageSizeName,
      category: "operational",
      status: sizeStatus,
      detail: sizeStatus === "pass" ? messages.checkImageSizeValid : messages.checkImageSizeUnknown,
      trace: safeTrace({ image_value_length: image.imageValueLength, threshold: 1024 }),
    },
  ];

  const score =
    statusToScore(payloadStatus, 25) +
    statusToScore(contentStatus, 35) +
    statusToScore(formatStatus, 20) +
    statusToScore(sizeStatus, 20);
  return { checks, score };
}

function formatHistoryTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function sanitizeHistoryEndpoint(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(candidate);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Keep malformed input useful for diagnostics while removing the only
    // place a pasted key can commonly hide: the query or fragment.
    return value.replace(/[?#].*$/, "");
  }
}

function isCheckStatus(value: unknown): value is CheckItem["status"] {
  return value === "pass" || value === "fail" || value === "warning";
}

function isAuthenticityVerdict(value: unknown): value is AuthenticityVerdict {
  return value === "verified" || value === "consistent" || value === "suspicious" || value === "unverifiable";
}

function isAuthenticityEvidenceLevel(value: unknown): value is AuthenticityEvidenceLevel {
  return value === "provider-transport" || value === "cryptographic" || value === "behavioral" || value === "conflict" || value === "insufficient";
}

function isAuthenticityReason(value: unknown): value is AuthenticityReason {
  return value === "official-direct" || value === "signature-verified" || value === "signature-partial" ||
    value === "signature-conflict" || value === "identity-mismatch" || value === "stage-fingerprint-conflict" ||
    value === "custom-profile-echo" || value === "dedicated-match" ||
    value === "dedicated-fail" || value === "local-signature-only" || value === "image-only" ||
    value === "unsupported-model" || value === "upstream-unavailable" || value === "insufficient-evidence";
}

function isVerifierScope(value: unknown): value is VerifierScope {
  return value === "dedicated" || value === "quality-only";
}

function sanitizeHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== "object") return null;

  const entry = value as Record<string, unknown>;
  const checks = Array.isArray(entry.checks)
    ? entry.checks
        .map((item): CheckItem | null => {
          if (!item || typeof item !== "object") return null;
          const check = item as Record<string, unknown>;
          if (
            typeof check.name !== "string" ||
            !isCheckStatus(check.status) ||
            typeof check.detail !== "string"
          ) {
            return null;
          }

          return {
            name: check.name,
            status: check.status,
            detail: check.detail,
            category:
              check.category === "ability" || check.category === "authenticity" || check.category === "operational"
                ? check.category
                : undefined,
          };
        })
        .filter((item): item is CheckItem => item !== null)
    : undefined;

  if (
    typeof entry.id !== "string" ||
    typeof entry.timestamp !== "string" ||
    typeof entry.model !== "string" ||
    typeof entry.endpoint !== "string" ||
    (typeof entry.score !== "number" && entry.score !== null) ||
    (!isAuthenticityVerdict(entry.status) && entry.status !== "pass" && entry.status !== "fail")
  ) {
    return null;
  }
  const hasUsableMetrics = typeof entry.score === "number";

  return {
    storageId: typeof entry.storageId === "string" ? entry.storageId : undefined,
    id: entry.id,
    source: entry.source === "api" || entry.source === "retest" || entry.source === "web" ? entry.source : undefined,
    timestamp: entry.timestamp,
    model: entry.model,
    endpoint: sanitizeHistoryEndpoint(entry.endpoint),
    apiKey: "",
    score: entry.score as number | null,
    capabilityScore: typeof entry.capabilityScore === "number" ? entry.capabilityScore : undefined,
    authenticityScore: typeof entry.authenticityScore === "number" ? entry.authenticityScore : undefined,
    resultKind: entry.resultKind === "image" ? "image" : "text",
    profileId: typeof entry.profileId === "string" ? entry.profileId : undefined,
    // Old score-derived pass/fail history had no independent identity proof.
    status: isAuthenticityVerdict(entry.status) ? entry.status : "unverifiable",
    evidenceLevel: isAuthenticityEvidenceLevel(entry.evidenceLevel) ? entry.evidenceLevel : "insufficient",
    verdictReason: isAuthenticityReason(entry.verdictReason) ? entry.verdictReason : "insufficient-evidence",
    verifierScope: isVerifierScope(entry.verifierScope) ? entry.verifierScope : "quality-only",
    checks,
    latency: hasUsableMetrics && typeof entry.latency === "number" ? entry.latency : undefined,
    tps: hasUsableMetrics && typeof entry.tps === "number" ? entry.tps : undefined,
    inputTokens: hasUsableMetrics && typeof entry.inputTokens === "number" ? entry.inputTokens : undefined,
    outputTokens: hasUsableMetrics && typeof entry.outputTokens === "number" ? entry.outputTokens : undefined,
    canRetest: entry.canRetest === true,
    attachments: Array.isArray(entry.attachments)
      ? entry.attachments
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : "",
            original_name: typeof item.original_name === "string" ? item.original_name : undefined,
            name: typeof item.name === "string" ? item.name : undefined,
            url: typeof item.url === "string" ? item.url : undefined,
            size_bytes: typeof item.size_bytes === "number" ? item.size_bytes : undefined,
          }))
          .filter((item) => Boolean(item.id))
      : undefined,
    attachmentAnalysis: entry.attachmentAnalysis && typeof entry.attachmentAnalysis === "object"
      ? entry.attachmentAnalysis as unknown as AttachmentAnalysisReport
      : null,
  };
}

function loadHistoryFromStorage(): HistoryEntry[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => sanitizeHistoryEntry(entry))
      .filter((entry): entry is HistoryEntry => entry !== null)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistoryToStorage(entries: HistoryEntry[]) {
  if (typeof window === "undefined") return;

  const sanitized = entries
    .map((entry) => sanitizeHistoryEntry(entry))
    .filter((entry): entry is HistoryEntry => entry !== null)
    .slice(0, HISTORY_LIMIT);

  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Private browsing and storage quotas must not break a completed report.
  }
}

function clearHistoryStorage() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Storage may be disabled by the browser; the in-memory history still clears.
  }
}

function upsertMetaTag(selector: string, attributes: Record<string, string>) {
  if (typeof document === "undefined") return;

  let element = document.head.querySelector(selector) as HTMLMetaElement | null;
  if (!element) {
    element = document.createElement("meta");
    document.head.appendChild(element);
  }

  Object.entries(attributes).forEach(([key, value]) => {
    element?.setAttribute(key, value);
  });
}

function upsertLinkTag(selector: string, attributes: Record<string, string>) {
  if (typeof document === "undefined") return;

  let element = document.head.querySelector(selector) as HTMLLinkElement | null;
  if (!element) {
    element = document.createElement("link");
    document.head.appendChild(element);
  }

  Object.entries(attributes).forEach(([key, value]) => {
    element?.setAttribute(key, value);
  });
}

const Index = () => {
  const { messages, t } = useI18n();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<ApiProtocol>("auto");
  const [selectedModel, setSelectedModel] = useState<string | null>("gpt-5.5");
  const [customModelId, setCustomModelId] = useState("");
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheRuns, setCacheRuns] = useState(1);
  const [liveKnowledgeEnabled, setLiveKnowledgeEnabled] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [showTurnstileModal, setShowTurnstileModal] = useState(false);
  const [turnstileVerified, setTurnstileVerified] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [publicError, setPublicError] = useState<PublicErrorInfo | null>(null);
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraft[]>([]);
  const [retestingHistoryId, setRetestingHistoryId] = useState<string | null>(null);
  const cacheModelObservationSupported = selectedModel ? canRunCacheObservation(selectedModel) : false;
  const cacheProtocolSupported = selectedModel
    ? resolveEndpoint(url || "https://cache-probe.invalid", selectedModel, protocol).mode === "anthropic"
    : false;
  const cacheObservationSupported = cacheModelObservationSupported && cacheProtocolSupported;
  const cacheBaselineComparable = selectedModel ? hasOfficialComparableCacheBaseline(selectedModel) : false;
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<string | number | null>(null);
  const detectionAbortRef = useRef<AbortController | null>(null);

  const refreshHistory = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/v1/web/history", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !Array.isArray(payload.items)) return false;
      setHistory(payload.items
        .map((entry: unknown) => sanitizeHistoryEntry(entry))
        .filter((entry: HistoryEntry | null): entry is HistoryEntry => entry !== null));
      return true;
    } catch {
      return false;
    }
  }, []);

  const resetTurnstile = useCallback(() => {
    setTurnstileVerified(false);
    setTurnstileToken(null);
    if (window.turnstile && turnstileWidgetIdRef.current !== null) {
      if (typeof window.turnstile.remove === "function") {
        window.turnstile.remove(turnstileWidgetIdRef.current);
      } else {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      }
    }
    turnstileWidgetIdRef.current = null;
    if (turnstileContainerRef.current) {
      turnstileContainerRef.current.innerHTML = "";
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refreshHistory().then((loaded) => {
      if (!active) return;
      if (!loaded) setHistory(loadHistoryFromStorage());
      setHistoryReady(true);
    });
    return () => {
      active = false;
    };
  }, [refreshHistory]);

  useEffect(() => () => detectionAbortRef.current?.abort(), []);

  useEffect(() => {
    if (cacheEnabled && !cacheObservationSupported) setCacheEnabled(false);
  }, [cacheEnabled, cacheObservationSupported]);

  useEffect(() => {
    if (!historyReady) return;
    saveHistoryToStorage(history);
  }, [history, historyReady]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    document.title = messages.seoTitle;
    upsertMetaTag('meta[name="description"]', { name: "description", content: messages.seoDescription });
    upsertMetaTag('meta[property="og:title"]', { property: "og:title", content: messages.seoOgTitle });
    upsertMetaTag('meta[property="og:description"]', { property: "og:description", content: messages.seoOgDescription });
    upsertMetaTag('meta[property="og:type"]', { property: "og:type", content: "website" });
    upsertMetaTag('meta[property="og:url"]', { property: "og:url", content: SITE_URL });
    upsertMetaTag('meta[property="og:image"]', { property: "og:image", content: OG_IMAGE_URL });
    upsertMetaTag('meta[name="twitter:card"]', { name: "twitter:card", content: "summary_large_image" });
    upsertMetaTag('meta[name="twitter:title"]', { name: "twitter:title", content: messages.seoOgTitle });
    upsertMetaTag('meta[name="twitter:description"]', { name: "twitter:description", content: messages.seoOgDescription });
    upsertMetaTag('meta[name="twitter:image"]', { name: "twitter:image", content: OG_IMAGE_URL });
    upsertLinkTag('link[rel="canonical"]', { rel: "canonical", href: SITE_URL });
  }, [messages]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    if (!showTurnstileModal) return;

    const mountWidget = () => {
      if (!window.turnstile || !turnstileContainerRef.current) return;
      if (turnstileWidgetIdRef.current !== null) return;

      const isMobile = window.matchMedia("(max-width: 640px)").matches;
      turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action: "start_detection",
        theme: "auto",
        size: isMobile ? "flexible" : "normal",
        callback: (token: string) => {
          setTurnstileToken(token);
          setTurnstileVerified(true);
        },
        "expired-callback": () => {
          setTurnstileToken(null);
          setTurnstileVerified(false);
        },
        "error-callback": () => {
          setTurnstileToken(null);
          setTurnstileVerified(false);
        },
      });
    };

    mountWidget();
    const timer = window.setInterval(mountWidget, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [showTurnstileModal]);

  const validateInputs = useCallback((): boolean => {
    if (!url) { toast.error(t("validationEndpointRequired")); return false; }
    try {
      const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("invalid_endpoint");
      }
    } catch {
      toast.error(t("validationEndpointInvalid"));
      return false;
    }
    if (!apiKey.trim()) { toast.error(t("validationApiKeyRequired")); return false; }
    if (!selectedModel) { toast.error(t("validationModelRequired")); return false; }
    if (attachmentDrafts.some((item) => item.mode === "verify" && !item.expectedIntent.trim())) {
      toast.error(t("attachmentExpectedPlaceholder"));
      return false;
    }
    return true;
  }, [url, apiKey, selectedModel, attachmentDrafts, t]);

  const deleteUploadedAttachments = useCallback(async (attachmentIds: string[]) => {
    const outcomes = await Promise.allSettled(attachmentIds.map(async (attachmentId) => {
      const response = await fetch(`/api/v1/web/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
      return { attachmentId, removed: response.ok || response.status === 404 };
    }));
    return new Set(outcomes.flatMap((outcome) => (
      outcome.status === "fulfilled" && outcome.value.removed ? [outcome.value.attachmentId] : []
    )));
  }, []);

  const runDetection = useCallback(async () => {
    if (!LOCAL_DETECTION_MODE && (!turnstileVerified || !turnstileToken)) {
      toast.error(t("turnstileCompleteFirst"));
      return;
    }
    if (!selectedModel) {
      toast.error(t("validationModelRequired"));
      return;
    }
    detectionAbortRef.current?.abort();
    const detectionController = new AbortController();
    detectionAbortRef.current = detectionController;
    const { signal } = detectionController;
    let uploadedThisRun: UploadedAttachment[] = [];
    let attachmentSpecs: AttachmentRequestSpec[] = [];
    let uploadedAttachmentsPersisted = false;
    const requestModel = customModelId.trim() || selectedModel;
    const metadataUserId = selectedModel.startsWith("claude-")
      ? OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID
      : createAnonymousClaudeUserId();

    // Close verification modal immediately once user confirms,
    // while keeping detection running in background.
    setShowTurnstileModal(false);
    setIsScanning(true);
    setResult(null);
    setPublicError(null);

    try {
      if (!LOCAL_DETECTION_MODE) {
        const verifyResp = await fetch("/__turnstile/verify", {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: turnstileToken }),
        });
        const verifyData = await verifyResp.json();
        if (!verifyResp.ok || !verifyData?.success) {
          resetTurnstile();
          throw new UserVisibleError({
            title: t("humanVerificationFailed"),
            detail: t("humanVerificationFailedDetail"),
            source: "system",
          });
        }
      }

      const endpointMode = resolveEndpoint(url, requestModel, protocol, selectedModel).mode;
      const requestProtocol: ApiProtocol = protocol === "auto" ? endpointMode : protocol;
      let kind: DetectionResult["kind"] = "text";
      let profileId = "";
      let checks: CheckItem[] = [];
      let score: number | null = 0;
      let capabilityScore: number | null = null;
      let authenticityScore: number | null = null;
      let avgLatency = 0;
      let avgTps = 0;
      let inputTokenSum = 0;
      let outputTokenSum = 0;
      let totalTokenSum = 0;
      let cacheReport: CacheReport | undefined;
      let evidenceProbes: ProbeResult[] = [];
      let requiredEvidenceProbes: ProbeResult[] = [];
      let requiredProbeIncomplete = false;
      let profileProbeIncomplete = false;
      let behavioralStatus: EvidenceSignalStatus = "warning";
      let profileSignatureEvidence: SignatureEvidence | null = null;
      let signatureFamilyConflict = false;
      let stageIdentityOnlyConflict = false;
      let customProfileEchoConflict = false;
      let liveKnowledgeReport: LiveKnowledgeReport | undefined;
      let cacheCheckRequested = false;
      let upstreamAvailability: UpstreamAvailabilitySummary | undefined;
      let scoreBreakdown: PrivateSignatureScoreBreakdown | undefined;
      let attachmentAnalysisReport: AttachmentAnalysisReport | undefined;

      if (endpointMode === "openai-images") {
        kind = "image";
        profileId = `${selectedModel}-image-operational`;
        const imageProbe = await sendProbe({
          baseUrl: url,
          signal,
          apiKey,
          model: requestModel,
          protocol: requestProtocol,
          stage: "image",
          prompt: IMAGE_PROBE_PROMPT,
          metadataUserId,
          allowUpstreamError: true,
          messages,
        });
        const imageAssessment = buildImageChecks(imageProbe, messages);
        checks = imageAssessment.checks;
        score = imageAssessment.score;
        behavioralStatus = scoreStatus(score, 70);
        evidenceProbes = [imageProbe];
        requiredEvidenceProbes = [imageProbe];
        avgLatency = imageProbe.latencyMs;
        avgTps = imageProbe.tps;
        inputTokenSum = imageProbe.inputTokens ?? 0;
        outputTokenSum = imageProbe.outputTokens ?? 0;
        totalTokenSum = imageProbe.totalTokens ?? 0;
      } else {
        const familyHint = endpointMode === "anthropic"
          ? "claude-modern"
          : endpointMode === "google-generative"
            ? "gemini"
            : endpointMode === "openai-chat" || endpointMode === "openai-responses"
              ? "openai-compatible"
              : undefined;
        // The selected card is the evaluation profile; requestModel is kept
        // unchanged for the upstream request. Known aliases auto-select their
        // canonical profile when entered in the configuration field.
        const suite = createEvaluationSuite(
          selectedModel,
          hasDedicatedVerifier(selectedModel)
            ? Math.floor(Math.random() * 0x1_0000_0000)
            : createEvaluationSeed(selectedModel, new Date()),
          familyHint,
          new Date(),
          "official-random",
        );
        cacheCheckRequested = cacheEnabled;
        profileId = suite.profile.id;
        const usesAdaptiveOmittedProfile = selectedModel === "claude-fable-5" || selectedModel === "claude-sonnet-5";
        const baseThinkingMode = usesAdaptiveOmittedProfile
          ? "adaptive-omitted"
          : suite.probeFamily === "claude-modern" || suite.probeFamily === "claude-frontier"
            ? "adaptive"
            : "enabled";
        const baseAnthropicEffort = usesAdaptiveOmittedProfile ? "xhigh" : undefined;
        const stage1 = suite.probeFamily === "gpt" || suite.probeFamily === "gemini"
          || suite.probeFamily === "fable" || suite.probeFamily === "claude-frontier"
          ? createSkippedProbe(suite.stage1Prompt)
          : await sendProbe({
              baseUrl: url,
              signal,
              apiKey,
              model: requestModel,
              protocol: requestProtocol,
              stage: suite.probeFamily === "liveness" ? "liveness" : "stage1",
              prompt: suite.probeFamily === "liveness" ? createLivenessPrompt() : suite.stage1Prompt,
              thinkingMode: baseThinkingMode,
              anthropicEffort: baseAnthropicEffort,
              metadataUserId,
              allowUpstreamError: true,
              messages,
            });

        const stage2 = suite.probeFamily === "gpt" || suite.probeFamily === "gemini"
          || suite.probeFamily === "fable" || suite.probeFamily === "claude-frontier"
          ? createSkippedProbe(suite.stage2Prompt)
          : suite.probeFamily === "liveness"
            ? stage1
          : shouldStopRequiredProbe(stage1)
            ? createSkippedProbe(suite.stage2Prompt)
          : await sendProbe({
              baseUrl: url,
              signal,
              apiKey,
              model: requestModel,
              protocol: requestProtocol,
              stage: "stage2",
              prompt: suite.stage2Prompt,
              previousUserPrompt: suite.probeFamily === "claude-standard" ? undefined : suite.stage1Prompt,
              previousAssistantText: suite.probeFamily === "claude-standard" ? undefined : stage1.responseText,
              thinkingMode: baseThinkingMode,
              anthropicEffort: baseAnthropicEffort,
              metadataUserId,
              allowUpstreamError: true,
              messages,
            });
        const extraProbes: ProbeResult[] = [];
        const sendExtraProbe = (
          extra: EvaluationSuite["extraProbes"][number],
          stage: NonNullable<PublicErrorInfo["stage"]>,
        ) => sendProbe({
            baseUrl: url,
            signal,
            apiKey,
            model: requestModel,
            protocol: requestProtocol,
            stage,
            prompt: extra.prompt,
            pdfText: extra.attachmentText,
            anthropicBeta: extra.requestBeta,
            thinkingMode: extra.thinkingMode,
            anthropicEffort: extra.anthropicEffort,
            jsonSchema: extra.jsonSchema,
            geminiThinkingLevel: extra.thinkingLevel,
            geminiGenerationConfigOverrides: extra.generationConfigOverrides,
            metadataUserId,
            allowUpstreamError: extra.allowUpstreamError,
            messages,
          });
        if (suite.probeFamily === "fable" || suite.probeFamily === "claude-frontier") {
          for (const [index, extra] of suite.extraProbes.entries()) {
            const stage = extra.id === "knowledge"
              ? "opus47-knowledge"
              : extra.id === "pdf"
                ? "opus47-pdf-dynamic"
                : extra.id === "calc"
                  ? "opus47-calc"
                  : extra.id === "signature"
                    ? "opus47-sig"
                    : "fable5-model-feature";
            const probe = await sendExtraProbe(extra, stage);
            extraProbes.push(probe);
            if (index === 0 && shouldStopRequiredProbe(probe)) break;
          }
        } else if (suite.probeFamily === "gemini") {
          const [mediumPlan, minimalPlan, challengePlan] = suite.extraProbes;
          if (!mediumPlan || !minimalPlan || !challengePlan) throw new Error("Invalid Gemini probe plan");

          const medium = await sendExtraProbe(mediumPlan, "gemini-medium");
          extraProbes.push(medium);
          if (medium.upstreamStatus >= 200 && medium.upstreamStatus < 300 && medium.parseOk && isExactOk(medium.responseText)) {
            const minimal = await sendExtraProbe(minimalPlan, "gemini-minimal");
            extraProbes.push(minimal);
            if (!isGeminiMinimalUnsupported(minimal)) {
              if (minimal.upstreamStatus < 200 || minimal.upstreamStatus >= 300) {
                // The medium probe succeeded, so an unexpected optional
                // variant error is an incomplete suite, not a page-level
                // exception or a low model score.
                profileProbeIncomplete = true;
              } else {
                const challenge = await sendExtraProbe(challengePlan, "gemini-challenge");
                extraProbes.push(challenge);
                if (challenge.upstreamStatus <= 0) profileProbeIncomplete = true;
              }
            }
          }
        } else if (suite.probeFamily === "claude-standard") {
          for (const extra of suite.extraProbes) {
            if (shouldStopRequiredProbe(stage1) || shouldStopRequiredProbe(stage2)) break;
            const probe = await sendExtraProbe(extra, extra.id === "pdf" ? "stage3" : "stage5-calc");
            extraProbes.push(probe);
          }
        } else {
          for (const extra of suite.extraProbes) {
            if (shouldStopRequiredProbe(stage1)) break;
            const probe = await sendExtraProbe(extra, "extra");
            extraProbes.push(probe);
          }
        }
        const probes = [stage1, stage2, ...extraProbes];
        const updateMetrics = (metricProbes: ProbeResult[]) => {
          const actualProbes = metricProbes.length > 0 ? metricProbes : [createSkippedProbe("")];
          avgLatency = Math.round(actualProbes.reduce((sum, probe) => sum + probe.latencyMs, 0) / actualProbes.length);
          avgTps = Number((actualProbes.reduce((sum, probe) => sum + probe.tps, 0) / actualProbes.length).toFixed(1));
          inputTokenSum = actualProbes.reduce((sum, probe) => sum + (probe.inputTokens ?? 0), 0);
          outputTokenSum = actualProbes.reduce((sum, probe) => sum + (probe.outputTokens ?? 0), 0);
          totalTokenSum = actualProbes.reduce((sum, probe) => sum + (probe.totalTokens ?? 0), 0);
        };

        if (suite.probeFamily === "gpt") {
          const quizProbe = await sendProbe({
            baseUrl: url,
            signal,
            apiKey,
            model: requestModel,
            protocol: requestProtocol,
            stage: "gpt-quiz",
            prompt: createGptQuizPrompt(suite.knowledgeQuestions),
            metadataUserId,
            allowUpstreamError: true,
            messages,
          });
          const quizAssessment = buildGptQuizChecks(quizProbe, suite, requestModel, selectedModel, messages);
          checks = quizAssessment.checks;
          score = quizAssessment.score;
          capabilityScore = quizAssessment.capabilityScore;
          authenticityScore = quizAssessment.authenticityScore;
          behavioralStatus = quizAssessment.behavioralStatus;
          customProfileEchoConflict = quizAssessment.customProfileEchoConflict;
          evidenceProbes = [quizProbe];
          requiredEvidenceProbes = [quizProbe];
          updateMetrics([quizProbe]);
        } else if (suite.probeFamily === "fable" || suite.probeFamily === "claude-frontier") {
          const familyAssessment = buildFamilyChecks(suite.probeFamily, extraProbes, suite, requestModel, selectedModel, messages);
          checks = familyAssessment.checks;
          score = familyAssessment.score;
          capabilityScore = familyAssessment.capabilityScore;
          authenticityScore = familyAssessment.authenticityScore;
          behavioralStatus = familyAssessment.behavioralStatus;
          profileSignatureEvidence = familyAssessment.signatureEvidence ?? null;
          signatureFamilyConflict = familyAssessment.familyConflict;
          stageIdentityOnlyConflict = familyAssessment.stageIdentityOnlyConflict;
          customProfileEchoConflict = familyAssessment.customProfileEchoConflict;
          scoreBreakdown = familyAssessment.scoreBreakdown;
          evidenceProbes = extraProbes;
          requiredEvidenceProbes = extraProbes.length > 0 ? [extraProbes[0]] : [];
          updateMetrics(extraProbes);
        } else if (suite.probeFamily === "claude-standard") {
          const familyAssessment = buildFamilyChecks("claude-standard", probes, suite, requestModel, selectedModel, messages);
          checks = familyAssessment.checks;
          score = familyAssessment.score;
          capabilityScore = familyAssessment.capabilityScore;
          authenticityScore = familyAssessment.authenticityScore;
          behavioralStatus = familyAssessment.behavioralStatus;
          profileSignatureEvidence = familyAssessment.signatureEvidence ?? null;
          signatureFamilyConflict = familyAssessment.familyConflict;
          stageIdentityOnlyConflict = familyAssessment.stageIdentityOnlyConflict;
          customProfileEchoConflict = familyAssessment.customProfileEchoConflict;
          scoreBreakdown = familyAssessment.scoreBreakdown;
          evidenceProbes = probes;
          requiredEvidenceProbes = [stage1, stage2];
          updateMetrics(probes);
        } else if (suite.probeFamily === "gemini" || suite.probeFamily === "liveness") {
          const familyProbes = suite.probeFamily === "gemini" ? extraProbes : [stage1];
          const familyAssessment = buildFamilyChecks(suite.probeFamily, familyProbes, suite, requestModel, selectedModel, messages);
          checks = familyAssessment.checks;
          score = familyAssessment.score;
          capabilityScore = familyAssessment.capabilityScore;
          authenticityScore = familyAssessment.authenticityScore;
          behavioralStatus = familyAssessment.behavioralStatus;
          profileSignatureEvidence = familyAssessment.signatureEvidence ?? null;
          signatureFamilyConflict = familyAssessment.familyConflict;
          stageIdentityOnlyConflict = familyAssessment.stageIdentityOnlyConflict;
          customProfileEchoConflict = familyAssessment.customProfileEchoConflict;
          evidenceProbes = familyProbes;
          requiredEvidenceProbes = familyProbes.length > 0 ? [familyProbes[0]] : [];
          updateMetrics(familyProbes);
        } else {
          updateMetrics(probes);
          const grades = gradeEvaluation(stage1.responseText, stage2.responseText, suite);
          const assessment = buildAbilityChecks({
            stage1,
            stage2,
            requestedModel: requestModel,
            profileModel: selectedModel,
            suite,
            grades,
            extraProbes,
            messages,
          });
          checks = assessment.checks;
          score = assessment.score;
          capabilityScore = assessment.capabilityScore;
          authenticityScore = assessment.authenticityScore;
          behavioralStatus = assessment.behavioralStatus;
          evidenceProbes = probes;
          requiredEvidenceProbes = [stage1, stage2];
        }

        // A complete rate-limit/service outage is not model evidence. Keep the
        // result visible for diagnostics, but remove every failed-probe score
        // and downgrade the checks to warnings so an outage cannot look like a
        // model substitution.
        upstreamAvailability = summarizeUpstreamAvailability(evidenceProbes.map((probe) => ({
          ...probe,
          evidenceUsable: isUsableEvidenceProbe(probe),
        })));
        requiredProbeIncomplete = profileProbeIncomplete || requiredEvidenceProbes.length === 0 || requiredEvidenceProbes.some(
          (probe) => !isUsableEvidenceProbe(probe),
        );
        if (upstreamAvailability.allUnavailable || requiredProbeIncomplete) {
          checks = markChecksUpstreamUnavailable(checks, upstreamAvailability, messages);
          score = null;
          capabilityScore = null;
          authenticityScore = null;
          scoreBreakdown = undefined;
          behavioralStatus = "warning";
        }
      }

      if (!upstreamAvailability && evidenceProbes.length > 0) {
        upstreamAvailability = summarizeUpstreamAvailability(evidenceProbes.map((probe) => ({
          ...probe,
          evidenceUsable: isUsableEvidenceProbe(probe),
        })));
        requiredProbeIncomplete = profileProbeIncomplete || requiredEvidenceProbes.length === 0 || requiredEvidenceProbes.some(
          (probe) => !isUsableEvidenceProbe(probe),
        );
        if (upstreamAvailability.allUnavailable || requiredProbeIncomplete) {
          checks = markChecksUpstreamUnavailable(checks, upstreamAvailability, messages);
          score = null;
          capabilityScore = null;
          authenticityScore = null;
          behavioralStatus = "warning";
        }
      }

      const requestCompatibilityFallbacks = [...new Set(
        evidenceProbes.flatMap((probe) => probe.requestCompatibilityFallbacks),
      )];
      if (requestCompatibilityFallbacks.length > 0) {
        checks = [...checks, {
          name: messages.checkRequestCompatibilityName,
          category: "operational",
          status: "warning",
          detail: messages.checkRequestCompatibilityFallback,
          trace: safeTrace({ fallbacks: requestCompatibilityFallbacks }),
        }];
      }

      // The public site treats prompt-cache probing as an independent,
      // explicit diagnostic. Once the user enables it, a failed or partial
      // main probe must not suppress the five cache requests; those requests
      // are useful for distinguishing a model failure from a cache/relay
      // failure. Unsupported profiles and protocols are handled by the cache
      // runner itself without affecting the quality score.
      if (cacheCheckRequested && !cacheReport && canRunCacheObservation(selectedModel)) {
        if (requestProtocol === "anthropic") {
          await abortableDelay(DEFAULT_DETECTION_PHASE_DELAY_MS, signal);
        }
        cacheReport = await runClaudeCacheCheck({
          baseUrl: url,
          apiKey,
          model: requestModel,
          profileModel: selectedModel,
          protocol: requestProtocol,
          metadataUserId,
          signal,
          messages,
          cacheRuns,
        });
      }

      if (liveKnowledgeEnabled && endpointMode !== "openai-images") {
        if (upstreamAvailability?.allUnavailable) {
          liveKnowledgeReport = {
            status: "skipped",
            snapshot: null,
            grade: null,
            reason: "core_unavailable",
          };
        } else {
          try {
            await abortableDelay(DEFAULT_DETECTION_PHASE_DELAY_MS, signal);
            const snapshot = await fetchLiveKnowledgeSnapshot(signal);
            const liveProbe = await sendProbe({
              baseUrl: url,
              signal,
              apiKey,
              model: requestModel,
              protocol: requestProtocol,
              stage: "live-knowledge",
              prompt: createLiveKnowledgePrompt(snapshot),
              metadataUserId,
              thinkingMode: endpointMode === "anthropic" ? "omit" : undefined,
              allowUpstreamError: true,
              messages,
            });
            const grade = isUsableEvidenceProbe(liveProbe)
              ? gradeLiveKnowledge(snapshot, liveProbe.responseText)
              : null;
            const liveUpstreamUnavailable = isUpstreamUnavailable(liveProbe.upstreamStatus, liveProbe.errorMessage);
            const noLiveAccess = Boolean(grade && grade.total > 0 && grade.abstained === grade.total);
            liveKnowledgeReport = {
              status: liveUpstreamUnavailable
                ? "upstream-unavailable"
                : noLiveAccess
                  ? "no-live-access"
                  : grade && liveKnowledgeGradePasses(snapshot, grade)
                    ? "passed"
                    : "failed",
              snapshot,
              grade,
              upstreamStatus: liveProbe.upstreamStatus,
              error: grade ? undefined : liveProbe.errorMessage || `HTTP ${liveProbe.upstreamStatus}`,
            };
          } catch (error) {
            if (isAbortError(error)) throw error;
            liveKnowledgeReport = {
              status: "unavailable",
              snapshot: null,
              grade: null,
              error: error instanceof Error ? error.message : "live_knowledge_unavailable",
            };
          }
        }
      }

      if (attachmentDrafts.length > 0) {
        try {
          const form = new FormData();
          form.append("request", JSON.stringify({
            base_url: url,
            upstream_api_key: apiKey,
            model: requestModel,
            profile_model: selectedModel,
            protocol: requestProtocol,
            rounds: 1,
            checks: { cache: false, cache_runs: 1, live_knowledge: false },
            attachments: attachmentDrafts.map((item) => ({
              mode: item.mode,
              ...(item.instruction.trim() ? { instruction: item.instruction.trim() } : {}),
              ...(item.mode === "verify" && item.expectedIntent.trim()
                ? { expected_intent: item.expectedIntent.trim() }
                : {}),
            })),
          }));
          for (const draft of attachmentDrafts) form.append("files", draft.file, draft.file.name);
          const response = await fetch("/api/v1/web/attachment-analysis", {
            method: "POST",
            signal,
            body: form,
          });
          const payload = await response.json().catch(() => null);
          if (response.ok && payload?.ok && payload.attachment_analysis) {
            const returnedAttachments = Array.isArray(payload.attachments)
              ? payload.attachments.filter((item: unknown): item is UploadedAttachment => Boolean(
                  item && typeof item === "object" &&
                  typeof (item as UploadedAttachment).id === "string" &&
                  typeof (item as UploadedAttachment).name === "string",
                ))
              : [];
            uploadedThisRun = returnedAttachments;
            if (returnedAttachments.length !== attachmentDrafts.length) {
              throw new Error("attachment_upload_count_mismatch");
            }
            const uploadedByLocalId = new Map(
              attachmentDrafts.map((draft, index) => [draft.localId, returnedAttachments[index]]),
            );
            setAttachmentDrafts((current) => current.map((draft) => {
              const uploaded = uploadedByLocalId.get(draft.localId);
              return uploaded ? { ...draft, uploaded } : draft;
            }));
            attachmentSpecs = uploadedThisRun.map((item, index) => ({
              id: item.id,
              mode: attachmentDrafts[index]?.mode || "understand",
              ...(attachmentDrafts[index]?.instruction.trim() ? { instruction: attachmentDrafts[index].instruction.trim() } : {}),
              ...(attachmentDrafts[index]?.mode === "verify" && attachmentDrafts[index]?.expectedIntent.trim()
                ? { expected_intent: attachmentDrafts[index].expectedIntent.trim() }
                : {}),
            }));
            attachmentAnalysisReport = payload.attachment_analysis as AttachmentAnalysisReport;
          } else {
            throw new Error(typeof payload?.error?.code === "string" ? payload.error.code : "attachment_analysis_failed");
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          attachmentAnalysisReport = {
            requested: true,
            status: "failed",
            recognition_status: "not-recognized",
            recognition_total: attachmentDrafts.length,
            recognized_count: 0,
            scored: false,
            affects_primary_score: false,
            completed: 0,
            total: attachmentDrafts.length,
            items: attachmentDrafts.map((item) => ({
              attachment_id: item.file.name,
              name: item.file.name,
              status: "failed",
              error: error instanceof Error ? error.message : "attachment_analysis_failed",
            })),
          };
        }
      }

      const channelEvidence = detectChannelEvidence({
        requestedUrl: url,
        mode: endpointMode,
        finalUrls: evidenceProbes.map((probe) => probe.finalUpstreamUrl),
        statuses: evidenceProbes.map((probe) => probe.upstreamStatus),
        parseOk: evidenceProbes.map((probe) => isUsableEvidenceProbe(probe)),
        responseHeaders: evidenceProbes.map((probe) => probe.responseHeaders),
        payloads: evidenceProbes.map((probe) => probe.payload),
        messageIds: evidenceProbes.map((probe) => probe.messageId ?? probe.payloadMessageId),
        signatureChannelMarkers: evidenceProbes.map((probe) => ({
          present: probe.signatureEnvelopeChannelPresent,
          value: probe.signatureEnvelopeChannelValue,
          structurallyParsed: probe.signatureStructurallyParsed,
        })),
      });

      if (!upstreamAvailability) {
        upstreamAvailability = summarizeUpstreamAvailability(evidenceProbes.map((probe) => ({
          ...probe,
          evidenceUsable: isUsableEvidenceProbe(probe),
        })));
      }

      // Dedicated Claude scoring intentionally derives model identity from its
      // primary identity/knowledge response. Optional PDF or structured-output
      // probes may pass through a compatibility wrapper with a different model
      // field, so reuse the identity status already produced by the profile
      // instead of reclassifying every auxiliary response here.
      const profileIdentityStatus = checks.find((check) =>
        check.category === "authenticity" && check.name === messages.checkModelConsistencyName,
      )?.status;

      const authenticity = deriveAuthenticityAssessment({
        modelId: requestModel,
        expectedModelId: selectedModel,
        resultKind: kind,
        identityStatus: profileIdentityStatus ?? getIdentityStatus(evidenceProbes, requestModel, selectedModel),
        behavioralStatus,
        officialTransportVerified: hasVerifiedOfficialTransport(
          url,
          endpointMode,
          evidenceProbes.map((probe) => ({
            upstreamStatus: probe.upstreamStatus,
            finalUpstreamUrl: probe.finalUpstreamUrl,
            upstreamRedirected: probe.upstreamRedirected,
            mode: probe.mode,
          })),
        ),
        signature: profileSignatureEvidence ?? summarizeSignatureEvidence(evidenceProbes),
        signatureFamilyConflict,
        stageIdentityOnlyConflict,
        customProfileEchoConflict,
        upstreamUnavailable: Boolean(upstreamAvailability?.allUnavailable),
        upstreamPartiallyUnavailable: requiredProbeIncomplete || Boolean(upstreamAvailability?.hasUnavailable && !upstreamAvailability?.allUnavailable),
      });

      const id = `#${createUuid().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
      const newResult: DetectionResult = {
        id,
        score,
        kind,
        profileId,
        capabilityScore,
        authenticityScore,
        authenticity,
        checks,
        latency: avgLatency,
        tps: avgTps,
        inputTokens: inputTokenSum,
        outputTokens: outputTokenSum,
        totalTokens: totalTokenSum,
        cacheReport,
        channelEvidence,
        liveKnowledge: liveKnowledgeReport,
        upstreamAvailability,
        scoreBreakdown,
        attachmentAnalysis: attachmentAnalysisReport,
      };
      setResult(newResult);

      const modelName = customModelId.trim() || getModelDisplayName(selectedModel);
      const now = new Date();
      const timestamp = formatHistoryTimestamp(now);
      const historyMetricsAvailable = score !== null && !requiredProbeIncomplete && !upstreamAvailability?.hasUnavailable;

      const localHistoryEntry: HistoryEntry = {
        id,
        source: "web",
        timestamp,
        model: modelName,
        endpoint: sanitizeHistoryEndpoint(url),
        apiKey: "",
        score,
        capabilityScore: capabilityScore ?? undefined,
        authenticityScore: authenticityScore ?? undefined,
        resultKind: kind,
        profileId,
        status: authenticity.verdict,
        evidenceLevel: authenticity.evidenceLevel,
        verdictReason: authenticity.reason,
        verifierScope: authenticity.verifierScope,
        checks,
        latency: historyMetricsAvailable ? avgLatency : undefined,
        tps: historyMetricsAvailable ? avgTps : undefined,
        inputTokens: historyMetricsAvailable ? inputTokenSum : undefined,
        outputTokens: historyMetricsAvailable ? outputTokenSum : undefined,
        attachments: uploadedThisRun.map((item) => ({
          id: item.id,
          name: item.name,
          url: item.url,
          size_bytes: item.size_bytes,
        })),
        attachmentAnalysis: attachmentAnalysisReport ?? null,
      };
      setHistory((prev) => [localHistoryEntry, ...prev].slice(0, HISTORY_LIMIT));

      try {
        const historyResponse = await fetch("/api/v1/web/history", {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request: {
              base_url: url,
              upstream_api_key: apiKey,
              model: requestModel,
              profile_model: selectedModel,
              protocol: requestProtocol,
              question_mode: "official-random",
              rounds: 1,
              checks: { cache: cacheEnabled, cache_runs: cacheRuns, live_knowledge: liveKnowledgeEnabled },
              attachments: attachmentSpecs,
            },
            result: newResult,
          }),
        });
        if (historyResponse.ok) {
          uploadedAttachmentsPersisted = true;
          await refreshHistory();
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        // The completed report remains visible even when local persistence is unavailable.
      }

      setPublicError(null);
      // The compact unavailable result is the actionable feedback for a run
      // that never reached a usable model response. Do not overlay it with a
      // misleading success toast.
      if (!upstreamAvailability?.allUnavailable) {
        toast.success(t("detectionComplete"));
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      if (error instanceof UserVisibleError) {
        setPublicError(error.info);
        toast.error(error.info.title);
      } else {
        const fallbackInfo: PublicErrorInfo = {
          title: t("detectionFailed"),
          detail: t("detectionFailedDetail"),
          source: "system",
        };
        setPublicError(fallbackInfo);
        toast.error(fallbackInfo.title);
      }
    } finally {
      if (uploadedThisRun.length > 0 && !uploadedAttachmentsPersisted) {
        const uploadedIds = new Set(uploadedThisRun.map((item) => item.id));
        const removedIds = await deleteUploadedAttachments([...uploadedIds]);
        setAttachmentDrafts((current) => current.map((item) => (
          item.uploaded && removedIds.has(item.uploaded.id) ? { ...item, uploaded: undefined } : item
        )));
      }
      if (detectionAbortRef.current === detectionController) {
        detectionAbortRef.current = null;
        setIsScanning(false);
        setShowTurnstileModal(false);
        resetTurnstile();
      }
    }
  }, [url, apiKey, protocol, selectedModel, customModelId, cacheEnabled, cacheRuns, liveKnowledgeEnabled, turnstileVerified, turnstileToken, resetTurnstile, messages, t, attachmentDrafts, refreshHistory, deleteUploadedAttachments]);

  const updateAttachmentDrafts = useCallback((next: AttachmentDraft[]) => {
    const remainingIds = new Set(next.map((item) => item.localId));
    const removedAttachmentIds = attachmentDrafts
      .filter((item) => !remainingIds.has(item.localId) && item.uploaded)
      .map((item) => item.uploaded?.id)
      .filter((id): id is string => Boolean(id));
    setAttachmentDrafts(next);
    if (removedAttachmentIds.length > 0) void deleteUploadedAttachments(removedAttachmentIds);
  }, [attachmentDrafts, deleteUploadedAttachments]);

  const cancelDetection = useCallback(() => {
    const active = detectionAbortRef.current;
    if (!active || active.signal.aborted) return;
    active.abort();
    setIsScanning(false);
    toast.info(t("detectionCancelled"));
  }, [t]);

  const openTurnstileModal = useCallback(() => {
    if (!validateInputs()) return;
    if (LOCAL_DETECTION_MODE) {
      void runDetection();
      return;
    }
    setPublicError(null);
    resetTurnstile();
    setShowTurnstileModal(true);
  }, [validateInputs, resetTurnstile, runDetection]);

  const closeTurnstileModal = useCallback(() => {
    setShowTurnstileModal(false);
    resetTurnstile();
  }, [resetTurnstile]);

  const clearHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/web/history", { method: "DELETE" });
      if (!response.ok) throw new Error("history_clear_failed");
      clearHistoryStorage();
      setHistory([]);
      toast.success(t("toastHistoryCleared"));
    } catch {
      toast.error(t("detectionFailed"));
    }
  }, [t]);

  const retestHistory = useCallback(async (entry: HistoryEntry) => {
    if (!entry.storageId || retestingHistoryId) return;
    setRetestingHistoryId(entry.storageId);
    try {
      const response = await fetch(`/api/v1/web/history/${encodeURIComponent(entry.storageId)}/retry`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "retest_failed");
      await refreshHistory();
      toast.success(t("detectionComplete"));
    } catch {
      toast.error(t("detectionFailed"));
    } finally {
      setRetestingHistoryId(null);
    }
  }, [refreshHistory, retestingHistoryId, t]);

  const getVerdictMeta = (verdict: AuthenticityVerdict, reason?: AuthenticityReason) => {
    if (reason === "upstream-unavailable") return { Icon: CircleHelp, label: t("upstreamUnavailable"), className: "text-warning", panelClass: "border-warning/30 bg-warning/5" };
    if (reason === "stage-fingerprint-conflict") return { Icon: AlertTriangle, label: t("authVerdictStageFingerprint"), className: "text-warning", panelClass: "border-warning/30 bg-warning/5" };
    if (reason === "custom-profile-echo") return { Icon: CircleHelp, label: t("authVerdictCustomProfileEcho"), className: "text-warning", panelClass: "border-warning/30 bg-warning/5" };
    if (verdict === "verified") return { Icon: CheckCircle2, label: t("authVerdictVerified"), className: "text-success", panelClass: "border-success/30 bg-success/5" };
    if (verdict === "consistent") return { Icon: ShieldCheck, label: t("authVerdictConsistent"), className: "text-primary", panelClass: "border-primary/30 bg-primary/5" };
    if (verdict === "suspicious") return { Icon: AlertTriangle, label: t("authVerdictSuspicious"), className: "text-error", panelClass: "border-error/30 bg-error/5" };
    return { Icon: CircleHelp, label: t("authVerdictUnverifiable"), className: "text-warning", panelClass: "border-warning/30 bg-warning/5" };
  };
  const getEvidenceLabel = (level: AuthenticityEvidenceLevel) => {
    if (level === "provider-transport") return t("evidenceProviderTransport");
    if (level === "cryptographic") return t("evidenceCryptographic");
    if (level === "behavioral") return t("evidenceBehavioral");
    if (level === "conflict") return t("evidenceConflict");
    return t("evidenceInsufficient");
  };
  const getReasonText = (reason: AuthenticityReason) => {
    if (reason === "official-direct") return t("authReasonOfficialDirect");
    if (reason === "signature-verified") return t("authReasonSignatureVerified");
    if (reason === "signature-partial") return t("authReasonSignaturePartial");
    if (reason === "signature-conflict") return t("authReasonSignatureConflict");
    if (reason === "identity-mismatch") return t("authReasonIdentityMismatch");
    if (reason === "stage-fingerprint-conflict") return t("authReasonStageFingerprintConflict");
    if (reason === "custom-profile-echo") return t("authReasonCustomProfileEcho");
    if (reason === "dedicated-match") return t("authReasonDedicatedMatch");
    if (reason === "dedicated-fail") return t("authReasonDedicatedFail");
    if (reason === "local-signature-only") return t("authReasonLocalSignatureOnly");
    if (reason === "image-only") return t("authReasonImageOnly");
    if (reason === "unsupported-model") return t("authReasonUnsupportedModel");
    if (reason === "upstream-unavailable") return t("authReasonUpstreamUnavailable");
    return t("authReasonInsufficientEvidence");
  };
  const getChannelLabel = (kind: ChannelEvidence["kind"]) => {
    if (kind === "anthropic-direct") return t("channelKindAnthropic");
    if (kind === "openai-direct") return t("channelKindOpenAI");
    if (kind === "google-ai-studio") return t("channelKindGoogleAIStudio");
    if (kind === "aws-bedrock") return t("channelKindBedrock");
    if (kind === "google-vertex") return t("channelKindVertex");
    if (kind === "google-unknown") return t("channelKindGoogleUnknown");
    if (kind === "vertex-or-bedrock-proxy") return t("channelKindVertexOrBedrockProxy");
    if (kind === "kiro-like") return t("channelKindKiro");
    return t("channelKindUnknown");
  };
  const getChannelConfidence = (confidence: ChannelEvidence["confidence"]) => {
    if (confidence === "high") return t("channelConfidenceHigh");
    if (confidence === "medium") return t("channelConfidenceMedium");
    if (confidence === "low") return t("channelConfidenceLow");
    return t("channelConfidenceNone");
  };
  const getChannelSignal = (signal: string) => {
    if (signal === "requested host is not an official provider hostname") return t("channelSignalNonOfficialHost");
    if (signal.includes("standard Anthropic-compatible response does not reveal") || signal.includes("custom or relay endpoint does not expose")) {
      return t("channelSignalHiddenUpstream");
    }
    if (signal.includes("mixed or non-official hosts")) return t("channelSignalMixedHosts");
    if (signal.includes("Claude protobuf channel=1")) return t("channelSignalVertexOrBedrockProxy");
    return signal;
  };
  const isOfficialChannel = (evidence: ChannelEvidence) =>
    evidence.direct && [
      "anthropic-direct",
      "openai-direct",
      "google-ai-studio",
      "aws-bedrock",
      "google-vertex",
    ].includes(evidence.kind);
  const getOfficialChannelStatus = (evidence: ChannelEvidence) => {
    if (isOfficialChannel(evidence)) return t("channelOfficialConfirmed");
    if (evidence.requestedHost && evidence.kind === "relay-or-unknown") return t("channelOfficialNotConfirmed");
    return t("channelOfficialUnknown");
  };
  const renderLiveKnowledgeReport = (currentResult: DetectionResult) => {
    const liveKnowledge = currentResult.liveKnowledge;
    if (!liveKnowledge) return null;

    return (
      <div
        data-testid="live-knowledge-report"
        className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-3 py-3 text-xs leading-relaxed"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-foreground">{t("liveKnowledgeTitle")}</span>
          {liveKnowledge.grade && (
            <span className="font-mono text-foreground">
              {liveKnowledge.grade.correct}/{liveKnowledge.grade.total}
              {liveKnowledge.status !== "no-live-access" && ` (${liveKnowledge.grade.score}%)`}
            </span>
          )}
          {liveKnowledge.status === "no-live-access" && (
            <span className="text-warning">{t("liveKnowledgeNoAccess")}</span>
          )}
          {liveKnowledge.status === "upstream-unavailable" && (
            <span className="text-warning">{t("liveKnowledgeUpstreamUnavailable")}</span>
          )}
          {liveKnowledge.status === "skipped" && (
            <span className="text-warning">{t("liveKnowledgeSkipped")}</span>
          )}
        </div>
        {liveKnowledge.status === "skipped" ? null : liveKnowledge.snapshot ? (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            <span>{t("liveKnowledgeSourceDate")}: {liveKnowledge.snapshot.sourceDate}</span>
            <span>{t("liveKnowledgeCache")}: {liveKnowledge.snapshot.cache.status}</span>
            <a
              href={liveKnowledge.snapshot.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-primary/40 underline-offset-2 hover:text-foreground"
            >
              {t("liveKnowledgeSource")}
            </a>
          </div>
        ) : (
          <div className="mt-1 text-warning">{t("liveKnowledgeUnavailable")}</div>
        )}
        {liveKnowledge.snapshot && liveKnowledge.status === "no-live-access" && (
          <div className="mt-2 text-muted-foreground">{t("liveKnowledgeSourceNotSent")}</div>
        )}
        <div className="mt-2 text-muted-foreground">{t("liveKnowledgeBoundary")}</div>
      </div>
    );
  };
  const renderUpstreamUnavailable = (currentResult: DetectionResult) => {
    const summary = currentResult.upstreamAvailability;
    if (!summary) return null;
    const failureKind = summary.failureKind ?? summary.kind;
    const requestRejected = failureKind === "invalid-response";
    const messages = summary.messages.length > 0 ? summary.messages : [t("upstreamNoValidResponse")];

    return (
      <>
        <section
          data-testid="authenticity-verdict"
          data-verdict={currentResult.authenticity.verdict}
          data-upstream-state="unavailable"
          className={`rounded-lg border px-4 py-4 ${requestRejected ? "border-error/30 bg-error/5" : "border-warning/30 bg-warning/5"}`}
        >
        <div className="flex items-start gap-3">
          <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${requestRejected ? "text-error" : "text-warning"}`} />
          <div className="min-w-0">
            <p className={`text-base font-semibold ${requestRejected ? "text-error" : "text-warning"}`}>
              {requestRejected ? t("upstreamRequestRejected") : t("upstreamUnavailable")}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("upstreamNoScore")}</p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-5 gap-y-2 border-y border-black/5 py-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("channelRequestedHost")}</dt>
            <dd className="mt-0.5 break-all font-mono text-foreground">{currentResult.channelEvidence.requestedHost || "-"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("channelStatusCodes")}</dt>
            <dd className="mt-0.5 font-mono text-foreground">{summary.statusCodes.length > 0 ? summary.statusCodes.join(", ") : "-"}</dd>
          </div>
        </dl>

        <div className="mt-3 space-y-1 text-xs leading-relaxed text-muted-foreground">
          {messages.map((message, index) => (
            <p key={`${message}-${index}`} className="break-words">{message}</p>
          ))}
        </div>

        <details className="mt-3 border-t border-black/5 pt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t("upstreamDetails")}</summary>
          <div data-testid="channel-evidence" className="mt-3 space-y-2 text-muted-foreground">
            <p>
              {t("channelEvidenceLabel")}: <span className="font-medium text-foreground">{getChannelLabel(currentResult.channelEvidence.kind)}</span>
              <span className="ml-1">({getChannelConfidence(currentResult.channelEvidence.confidence)})</span>
            </p>
            <p>{t("channelOfficialStatus")}: {getOfficialChannelStatus(currentResult.channelEvidence)}</p>
            {currentResult.channelEvidence.signals.length > 0 && (
              <div className="space-y-1">
                {currentResult.channelEvidence.signals.map((signal, index) => (
                  <p key={`${signal}-${index}`}>{getChannelSignal(signal)}</p>
                ))}
              </div>
            )}
            <p>{t("channelFinalHosts")}: {currentResult.channelEvidence.finalHosts.length > 0 ? currentResult.channelEvidence.finalHosts.join(", ") : "-"}</p>
            <p>{t("resultProfileLabel")}: {currentResult.profileId}</p>
          </div>
        </details>
        </section>
        {renderLiveKnowledgeReport(currentResult)}
      </>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main className="max-w-5xl mx-auto px-3 sm:px-6 lg:px-8 py-6 sm:py-8">

        {/* Security Notice */}
        <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3.5 sm:px-4 py-3 mb-4">
          <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
            {t("securityNotice")}
          </p>
        </div>

        {/* Config Section */}
        <div className="p-1 sm:p-0 mb-4">
          <div className="flex items-center gap-2 mb-5">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {t("configSectionTitle")}
            </h2>
          </div>

          <ApiConfig
            url={url}
            apiKey={apiKey}
            onUrlChange={setUrl}
            onApiKeyChange={setApiKey}
            modelId={customModelId}
            profileModelId={selectedModel}
            onModelIdChange={(modelId) => {
              setCustomModelId(modelId);
              const resolvedProfileId = resolveModelProfileId(modelId);
              if (resolvedProfileId) {
                setSelectedModel(resolvedProfileId);
                if (!canRunCacheObservation(resolvedProfileId)) setCacheEnabled(false);
              }
            }}
            protocol={protocol}
            onProtocolChange={setProtocol}
          />
          <ModelSelector
            selected={selectedModel}
            onSelect={(modelId) => {
              setSelectedModel(modelId);
              if (!canRunCacheObservation(modelId)) setCacheEnabled(false);
            }}
          />
          <AttachmentUpload
            value={attachmentDrafts}
            onChange={updateAttachmentDrafts}
            disabled={isScanning}
          />
        </div>

        {/* Action Row */}
        <div className="flex items-end justify-between gap-4 mb-5 sm:mb-6 flex-wrap">
          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label={t("cacheToggle")}
                checked={cacheEnabled}
                disabled={!cacheObservationSupported}
                onChange={(event) => setCacheEnabled(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span className="leading-relaxed">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{t("cacheToggle")}</span>
                  {cacheObservationSupported && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-muted-foreground">{t("cacheValidationRuns")}:</span>
                      <select
                        aria-label={t("cacheValidationRuns")}
                        value={cacheRuns}
                        disabled={isScanning}
                        onChange={(event) => setCacheRuns(Math.min(3, Math.max(1, Number(event.target.value) || 1)))}
                        className="h-7 rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {[1, 2, 3].map((count) => (
                          <option key={count} value={count}>
                            {t("cacheValidationRunOption").replace("{count}", String(count))}
                          </option>
                        ))}
                      </select>
                    </span>
                  )}
                </span>
                <span className="block">
                  {!cacheObservationSupported
                    ? cacheModelObservationSupported
                      ? t("cacheProtocolNotSupported")
                      : t("cacheToggleUnsupportedDescription")
                    : cacheBaselineComparable
                      ? t("cacheToggleDescription")
                      : t("cacheToggleObservationOnlyDescription")}
                </span>
                {cacheObservationSupported && (
                  <span className="mt-1 block text-[11px] text-muted-foreground/80">
                    {t("cacheValidationRunsDescription")}
                  </span>
                )}
              </span>
            </label>
            <label className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={liveKnowledgeEnabled}
                onChange={(event) => setLiveKnowledgeEnabled(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span className="leading-relaxed">
                <span className="font-medium text-foreground">{t("liveKnowledgeToggle")}</span>
                <span className="block">{t("liveKnowledgeToggleDescription")}</span>
              </span>
            </label>
          </div>
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={isScanning ? cancelDetection : openTurnstileModal}
            className={`w-full sm:w-auto justify-center flex items-center gap-2 px-6 sm:px-8 py-2.5 sm:py-3 rounded-xl font-medium text-sm transition-all ${isScanning ? "border border-error/40 bg-error/10 text-error hover:bg-error/15" : "bg-primary hover:bg-primary-hover text-primary-foreground"}`}
          >
            {isScanning
              ? <><Square className="h-4 w-4 fill-current" />{t("actionCancelDetection")}</>
              : t("actionStartDetection")}
          </motion.button>
        </div>

        {publicError && (
          <div className="rounded-xl border border-error/35 bg-error/5 p-4 mb-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-error mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {publicError.title}
                </p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed break-words">
                  {publicError.source === "upstream"
                    ? `${t("upstreamPrefix")} `
                    : `${t("systemPrefix")} `}
                  {publicError.detail}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Results Section */}
        <AnimatePresence>
          {(isScanning || result) && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
              className="relative p-1 sm:p-0 mb-4"
            >
              <ScanningOverlay isScanning={isScanning} />

              {result && (
                <>
	                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-primary" />
                      <h3 className="text-lg font-semibold tracking-tight text-foreground">
                        {t("resultTitle")}
                      </h3>
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">{t("reportIdPrefix")}: {result.id}</span>
	                  </div>

                  {result.upstreamAvailability?.allUnavailable
                    ? renderUpstreamUnavailable(result)
                    : (
                      <>
                  {(() => {
                    const meta = getVerdictMeta(result.authenticity.verdict, result.authenticity.reason);
                    const VerdictIcon = meta.Icon;
                    return (
                      <div
                        data-testid="authenticity-verdict"
                        data-verdict={result.authenticity.verdict}
                        className={`mb-4 rounded-lg border px-3 py-3 sm:px-4 ${meta.panelClass}`}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex min-w-0 items-start gap-2.5">
                            <VerdictIcon className={`mt-0.5 h-5 w-5 shrink-0 ${meta.className}`} />
                            <div className="min-w-0">
                              <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{t("resultAuthenticityVerdict")}</div>
                              <div className={`mt-0.5 text-base font-semibold ${meta.className}`}>{meta.label}</div>
                            </div>
                          </div>
                          <div className="grid shrink-0 grid-cols-1 gap-x-5 gap-y-1 text-xs sm:grid-cols-2">
                            <div>
                              <span className="text-muted-foreground">{t("resultEvidenceLevel")}: </span>
                              <span className="font-medium text-foreground">{getEvidenceLabel(result.authenticity.evidenceLevel)}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t("resultVerifierScope")}: </span>
                              <span className="font-medium text-foreground">
                                {result.authenticity.verifierScope === "dedicated" ? t("verifierScopeDedicated") : t("verifierScopeQualityOnly")}
                              </span>
                            </div>
                          </div>
                        </div>
                        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                          {getReasonText(result.authenticity.reason)}
                        </p>
                        <div data-testid="channel-evidence" className="mt-3 border-t border-black/5 pt-2 text-xs">
                          <span className="text-muted-foreground">{t("channelEvidenceLabel")}: </span>
                          <span className="font-medium text-foreground">{getChannelLabel(result.channelEvidence.kind)}</span>
                          <span className="ml-2 text-muted-foreground">({getChannelConfidence(result.channelEvidence.confidence)})</span>
                          <div className={`mt-1 text-[11px] font-medium ${isOfficialChannel(result.channelEvidence) ? "text-success" : "text-warning"}`}>
                            {t("channelOfficialStatus")}: {getOfficialChannelStatus(result.channelEvidence)}
                          </div>
                          {result.channelEvidence.signals.length > 0 && (
                            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                              {result.channelEvidence.signals.map((signal, index) => (
                                <div key={`${signal}-${index}`}>{getChannelSignal(signal)}</div>
                              ))}
                            </div>
                          )}
                          <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-3">
                            <span>{t("channelRequestedHost")}: {result.channelEvidence.requestedHost || "-"}</span>
                            <span>{t("channelFinalHosts")}: {result.channelEvidence.finalHosts.length > 0 ? result.channelEvidence.finalHosts.join(", ") : "-"}</span>
                            <span>{t("channelStatusCodes")}: {result.channelEvidence.observedStatusCodes.length > 0 ? result.channelEvidence.observedStatusCodes.join(", ") : "-"}</span>
                          </div>
                          {result.channelEvidence.direct && (
                            <div className="mt-1 text-[11px] font-medium text-success">
                              {t("channelDirectConfirmed")}
                            </div>
                          )}
                        </div>
                        <p className="mt-2 border-t border-black/5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                          {t("authenticityBoundaryNotice")}
                        </p>
                      </div>
                    );
                  })()}

                  <div className="mb-3">
                    <div data-testid="quality-score" className="rounded-lg border border-border bg-card/60 px-3 py-2.5">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                        {result.authenticity.verifierScope === "dedicated" ? t("resultOfficialCompatibility") : t("resultScoreOverall")}
                      </div>
                      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                        {result.score === null ? "—" : `${result.score}%`}
                      </div>
                      {result.authenticity.verifierScope === "dedicated" && result.score !== null && (
                        <div className={`mt-0.5 text-[11px] font-medium ${result.score >= (result.profileId.startsWith("gpt-") || result.profileId.startsWith("gemini-") ? 70 : 60) ? "text-success" : "text-error"}`}>
                          {result.score >= (result.profileId.startsWith("gpt-") || result.profileId.startsWith("gemini-") ? 70 : 60) ? t("resultOfficialPass") : t("resultOfficialFail")}
                        </div>
                      )}
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {result.kind === "image"
                          ? t("resultScoreOperational")
                          : result.authenticity.verifierScope === "dedicated"
                            ? t("resultOfficialCompatibilityHint")
                            : t("resultQualityGauge")}
                      </div>
                      {result.score !== null && result.scoreBreakdown && result.scoreBreakdown.privateSignatureAdjustment < 0
                        ? (
                            <div className="mt-2 border-t border-border/70 pt-2 text-[11px] font-medium leading-relaxed text-foreground" data-testid="score-breakdown">
                              {t("resultPrivateSignatureEquation")
                                .replace("{observable}", String(result.scoreBreakdown.publicObservableScore))
                                .replace("{withheld}", String(Math.abs(result.scoreBreakdown.privateSignatureAdjustment)))
                                .replace("{primary}", String(result.score))}
                            </div>
                          )
                        : result.authenticity.verifierScope === "dedicated" &&
                          result.score !== null &&
                          result.capabilityScore !== null &&
                          result.capabilityScore !== result.score && (
                            <div className="mt-2 border-t border-border/70 pt-2 text-[11px] leading-relaxed text-muted-foreground" data-testid="score-breakdown">
                              <span className="font-medium text-foreground">{t("resultScoreCapability")}:</span> {result.capabilityScore}%
                              <span className="mx-1.5">·</span>
                              <span className="font-medium text-foreground">{t("resultScoreEvidenceAdjustment")}:</span> {result.score - result.capabilityScore}%
                            </div>
                          )}
                    </div>
                  </div>

                  <div className="mb-4 flex flex-wrap items-start gap-x-3 gap-y-1 text-[11px] leading-relaxed text-muted-foreground">
                    <span><span className="font-medium text-foreground">{t("resultProfileLabel")}:</span> {result.profileId}</span>
                    <span>{t("resultScoreComparisonNotice")}</span>
                  </div>

                  {renderLiveKnowledgeReport(result)}

                  {result.kind === "image" && (
                    <div className="mb-4 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                      {t("resultImageNotice")}
                    </div>
                  )}

                  <div>
                    <DetectionChecklist
                      items={result.checks}
                      latency={result.latency}
                      tps={result.upstreamAvailability?.hasUnavailable ? undefined : result.tps}
                      inputTokens={result.upstreamAvailability?.hasUnavailable ? undefined : result.inputTokens}
                      outputTokens={result.upstreamAvailability?.hasUnavailable ? undefined : result.outputTokens}
                    />
                  </div>
                      </>
                    )}
                  {result.cacheReport && <CacheReportPanel report={result.cacheReport} />}
                  {result.attachmentAnalysis && <AttachmentAnalysisPanel report={result.attachmentAnalysis} />}
                </>
              )}

              {isScanning && !result && <div className="h-64" />}
            </motion.div>
          )}
        </AnimatePresence>

        {/* History Section */}
        <HistoryLog
          entries={history}
          onClear={clearHistory}
          onRetest={retestHistory}
          retestingId={retestingHistoryId}
        />

      </main>
      <AnimatePresence>
        {showTurnstileModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-foreground/35 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          >
            <motion.div
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
              className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-border bg-card px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+16px)] sm:p-5 shadow-xl max-h-[88vh] overflow-y-auto"
            >
              <div className="mx-auto mb-3 mt-1 h-1.5 w-12 rounded-full bg-muted sm:hidden" />
              <h3 className="text-base font-semibold text-foreground mb-1">
                {t("verifyModalTitle")}
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                {t("verifyModalDescription")}
              </p>
              <div className="rounded-xl border border-border/70 bg-muted/45 p-2.5">
                <div className="mx-auto flex min-h-[72px] w-full items-center justify-center" ref={turnstileContainerRef} />
              </div>
              <div className="mt-4 grid grid-cols-2 sm:flex sm:justify-end gap-2">
                <button
                  onClick={closeTurnstileModal}
                  className="h-10 px-3 text-sm rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  {t("verifyModalCancel")}
                </button>
                <button
                  onClick={runDetection}
                  disabled={!turnstileVerified || isScanning}
                  className="h-10 px-3 text-sm rounded-lg bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t("verifyModalConfirm")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Index;
