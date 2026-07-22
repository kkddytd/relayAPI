import type { ApiProtocol } from "@/lib/apiProtocol";
import { isImageModel, resolveModelProfileId } from "@/lib/models";

export type EndpointMode = Exclude<ApiProtocol, "auto">;

function isOpenAIModel(model: string): boolean {
  return /^(gpt|o[1-9](?:$|[-.])|glm-)/i.test(model.trim());
}

function isGeminiModel(model: string): boolean {
  return /^gemini-/i.test(model.trim());
}

function isGoogleGenerativeHost(hostname: string): boolean {
  return hostname === "generativelanguage.googleapis.com" ||
    /(?:^|[.-])aiplatform\.googleapis\.com$/i.test(hostname);
}

function normalizeModelToken(model: string): string {
  return model.trim().toLowerCase();
}

function stripClaudeDecorators(model: string): string {
  return model
    .replace(/\[(?:1m|fast)\]$/i, "")
    .replace(/\[fast\]$/i, "")
    .trim();
}

function claudeAliasFamily(model: string): { base: string; suffix: string } | null {
  const value = stripClaudeDecorators(normalizeModelToken(model));
  const match = value.match(
    /^claude-(?:(opus|sonnet|haiku)-(\d+)-(\d+)|(\d+)-(\d+)-(opus|sonnet|haiku))(?:-(.+))?$/i,
  );
  if (!match) return null;

  const family = (match[1] || match[6] || "").toLowerCase();
  const major = match[2] || match[4] || "";
  const minor = match[3] || match[5] || "";
  if (!family || !major || !minor) return null;
  return {
    base: `claude-${family}-${major}-${minor}`,
    suffix: (match[7] || "").toLowerCase(),
  };
}

function isRecognizedClaudeAlias(requested: string, reported: string): boolean {
  const requestedToken = normalizeModelToken(requested);
  const reportedToken = normalizeModelToken(reported);

  const parseFableAlias = (value: string): string | null => {
    const match = stripClaudeDecorators(value).match(/^(?:claude-(?:fable-5|5-fable|fable5)|fable5|fable-5)(?:-(.+))?$/i);
    return match ? (match[1] || "").toLowerCase() : null;
  };
  const requestedFableSuffix = parseFableAlias(requestedToken);
  const reportedFableSuffix = parseFableAlias(reportedToken);
  if (requestedFableSuffix !== null && reportedFableSuffix !== null) {
    const isAllowedSuffix = (suffix: string) =>
      !suffix || /^(?:latest|preview|fast|1m|\d{4}(?:-\d{2}(?:-\d{2})?)?|\d{8})$/.test(suffix);
    return isAllowedSuffix(requestedFableSuffix) && isAllowedSuffix(reportedFableSuffix);
  }

  if (!requestedToken.startsWith("claude-") || !reportedToken.startsWith("claude-")) return false;

  const requestedFamily = claudeAliasFamily(requestedToken);
  const reportedFamily = claudeAliasFamily(reportedToken);
  if (!requestedFamily || !reportedFamily || requestedFamily.base !== reportedFamily.base) return false;

  // Anthropic publishes dated snapshots and Claude Code exposes the explicit
  // fast/1m variants. Accept only those documented suffix forms; arbitrary
  // suffixes remain a mismatch so a relay cannot hide a model substitution.
  const isAllowedSuffix = (suffix: string) =>
    !suffix || /^(?:\d{4}(?:-\d{2}(?:-\d{2})?)?|\d{8}|fast|1m)$/.test(suffix);
  return isAllowedSuffix(requestedFamily.suffix) && isAllowedSuffix(reportedFamily.suffix);
}

function modelMatchesDirectly(requestedModel: string, reportedModel: string | null): boolean {
  if (!reportedModel) return false;

  const requested = normalizeModelToken(requestedModel);
  const reported = normalizeModelToken(reportedModel);
  if (!requested || !reported) return false;
  if (requested === reported) return true;
  if (isRecognizedClaudeAlias(requested, reported)) return true;
  // Provider responses may report a dated/preview generation identifier
  // instead of the short OpenAI or Gemini request ID. Accept only documented
  // version-style suffixes; an unrelated family still remains a conflict.
  if (/^(?:gpt-|gemini-)/i.test(requested) && reported.startsWith(`${requested}-`)) {
    const suffix = reported.slice(requested.length + 1);
    if (/^(?:latest|chat-latest|preview|\d{2}-\d{2}|\d{4}-\d{2}-\d{2}|\d{8}|\d{3})$/i.test(suffix)) {
      return true;
    }
  }
  if (
    reported.startsWith(`${requested}-`) &&
    /^(?:\d{4}(?:-\d{2}(?:-\d{2})?)?|\d{8})$/.test(reported.slice(requested.length + 1))
  ) {
    return true;
  }

  return false;
}

export function modelMatchesRequested(
  requestedModel: string,
  reportedModel: string | null,
  profileModel?: string | null,
): boolean {
  if (modelMatchesDirectly(requestedModel, reportedModel)) return true;

  // A relay may accept a private alias while reporting the canonical upstream
  // model. Only use the selected profile as a fallback when the request ID is
  // genuinely unknown; a recognized but conflicting model must still fail.
  if (resolveModelProfileId(requestedModel) || !profileModel) return false;
  const canonicalProfile = resolveModelProfileId(profileModel);
  return Boolean(canonicalProfile && modelMatchesDirectly(canonicalProfile, reportedModel));
}

export function resolveEndpoint(
  rawUrl: string,
  model = "",
  protocol: ApiProtocol = "auto",
  profileModel?: string | null,
): { endpoint: string; mode: EndpointMode } {
  const raw = rawUrl.trim();
  if (!raw) return { endpoint: "", mode: "anthropic" };
  const trimmed = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    // Keep the raw value below so the server can return its normal endpoint
    // validation error for malformed input.
  }
  const query = parsedUrl?.search ?? "";
  const normalized = parsedUrl
    ? `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/+$/, "")
    : trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const lowered = normalized.toLowerCase();
  let hostname = "";
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    // The endpoint will remain invalid and be rejected by the request layer.
  }
  const hasResponsesPath = lowered.endsWith("/v1/responses") || lowered.endsWith("/responses");
  const hasChatPath = lowered.endsWith("/v1/chat/completions") || lowered.endsWith("/chat/completions");
  const hasImagesPath = lowered.endsWith("/v1/images/generations") || lowered.endsWith("/images/generations");
  const officialOpenAIHost = hostname === "api.openai.com";
  const openAICompatibleHost = officialOpenAIHost || hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  const googleHost = isGoogleGenerativeHost(hostname);
  const hasVertexAnthropicRoute = googleHost && /\/publishers\/anthropic\/models\/[^/:]+:(?:rawPredict|streamRawPredict)$/i.test(parsedUrl?.pathname ?? "");
  const inferenceModel = profileModel || model;

  const mode: EndpointMode = protocol !== "auto"
    ? protocol
    : hasImagesPath
      ? "openai-images"
      : hasResponsesPath
        ? "openai-responses"
      : hasChatPath
        ? "openai-chat"
        : hasVertexAnthropicRoute
          ? "anthropic"
          : isImageModel(inferenceModel)
            ? "openai-images"
            : googleHost && /\/projects\//i.test(parsedUrl?.pathname ?? "") && /^claude-/i.test(inferenceModel)
              ? "anthropic"
            : isGeminiModel(inferenceModel) || googleHost
              ? "google-generative"
              : openAICompatibleHost || isOpenAIModel(inferenceModel)
                ? "openai-chat"
                : "anthropic";

  const base = normalized
    .replace(/\/v1\/images\/generations\/?$/i, "")
    .replace(/\/images\/generations\/?$/i, "")
    .replace(/\/v1\/responses\/?$/i, "")
    .replace(/\/responses\/?$/i, "")
    .replace(/\/v1\/chat\/completions\/?$/i, "")
    .replace(/\/chat\/completions\/?$/i, "")
    .replace(/\/v1beta\/models\/[^/]+:generatecontent\/?$/i, "")
    .replace(/\/v1\/messages?\/?$/i, "")
    .replace(/\/v1beta\/?$/i, "")
    .replace(/\/v1\/?$/i, "")
    .replace(/\/+$/, "");

  if (!base) return { endpoint: "", mode };
  if (mode === "openai-images") return { endpoint: `${base}/v1/images/generations${query}`, mode };
  if (mode === "openai-responses") return { endpoint: `${base}/v1/responses${query}`, mode };
  if (mode === "openai-chat") return { endpoint: `${base}/v1/chat/completions${query}`, mode };
  if (mode === "google-generative") {
    // Vertex AI and AI Studio both expose a `.../models/{id}:generateContent`
    // route. Preserve a complete user-supplied route (including the project /
    // location prefix used by Vertex) and only replace its model segment.
    const existingModelPath = parsedUrl?.pathname.match(
      /^(.*\/models\/)[^/:]+:(generateContent|streamGenerateContent)$/i,
    );
    if (parsedUrl && existingModelPath) {
      return {
        endpoint: `${parsedUrl.origin}${existingModelPath[1]}${encodeURIComponent(model)}:${existingModelPath[2]}${query}`,
        mode,
      };
    }
    // A Vertex base URL includes the project/location prefix and optionally
    // the publisher. It must not receive the AI Studio `/v1beta/models` route.
    // Build the documented publisher path when the caller supplied only the
    // project/location portion.
    if (parsedUrl && googleHost && /\/projects\//i.test(parsedUrl.pathname)) {
      const publisherBase = /\/publishers\/[^/]+$/i.test(base)
        ? base.replace(/\/publishers\/[^/]+$/i, "/publishers/google")
        : `${base}/publishers/google`;
      return { endpoint: `${publisherBase}/models/${encodeURIComponent(model)}:generateContent${query}`, mode };
    }
    return { endpoint: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent${query}`, mode };
  }
  if (mode === "anthropic") {
    const existingVertexAnthropicPath = parsedUrl?.pathname.match(
      /^(.*\/publishers\/anthropic\/models\/)[^/:]+:(rawPredict|streamRawPredict)$/i,
    );
    if (parsedUrl && existingVertexAnthropicPath) {
      return {
        endpoint: `${parsedUrl.origin}${existingVertexAnthropicPath[1]}${encodeURIComponent(model)}:${existingVertexAnthropicPath[2]}${query}`,
        mode,
      };
    }
    if (parsedUrl && googleHost && /\/projects\//i.test(parsedUrl.pathname)) {
      const publisherBase = /\/publishers\/[^/]+$/i.test(base)
        ? base.replace(/\/publishers\/[^/]+$/i, "/publishers/anthropic")
        : `${base}/publishers/anthropic`;
      return { endpoint: `${publisherBase}/models/${encodeURIComponent(model)}:rawPredict${query}`, mode };
    }
  }
  return { endpoint: `${base}/v1/messages${query}`, mode };
}
