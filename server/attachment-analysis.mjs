import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { extractText, resolveDetectionEndpoint } from "./detection-api.mjs";
import { renderPdfPreview } from "./pdf-preview.mjs";

const FULL_TEXT_BYTES = 1024 * 1024;
const SAMPLE_EDGE_BYTES = 512 * 1024;
const NATIVE_INLINE_BYTES = 20 * 1024 * 1024;
const NATIVE_IMAGE_TARGET_BYTES = 4 * 1024 * 1024;
const ATTACHMENT_SYSTEM_INSTRUCTION = [
  "You are an attachment-analysis component.",
  "This is an attachment recognition check, not a content-accuracy or intent-scoring task.",
  "Analyze only the supplied attachment and the user's optional note.",
  "Do not introduce yourself or discuss your model identity unless that identity text is visibly present inside the attachment.",
  "Return only the requested JSON object, with no markdown or commentary outside it.",
].join(" ");

function normalizeKey(raw) {
  return String(raw || "").trim().replace(/^(?:bearer\s+|x-api-key\s*:\s*)/i, "");
}

function requestHeaders(protocol, endpoint, rawKey) {
  const key = normalizeKey(rawKey);
  const bearer = /^bearer\s+/i.test(String(rawKey || ""));
  const hostname = new URL(endpoint).hostname.toLowerCase();
  const vertex = /(?:^|[.-])aiplatform\.googleapis\.com$/i.test(hostname);
  if (protocol === "anthropic") {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(vertex || bearer ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "pdfs-2024-09-25",
    };
  }
  if (protocol === "google-generative") {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(vertex || bearer ? { authorization: `Bearer ${key}` } : { "x-goog-api-key": key }),
    };
  }
  return {
    accept: "application/json",
    "content-type": "application/json",
    "cache-control": "no-store",
    authorization: `Bearer ${key}`,
  };
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".toml", ".ini", ".conf", ".config", ".properties", ".env", ".log", ".sql",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".pyw", ".php", ".phtml", ".inc", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".swift", ".kt", ".kts", ".dart", ".rb", ".r", ".lua", ".pl", ".pm", ".ex", ".exs", ".erl", ".hrl", ".fs", ".fsx", ".vb", ".asm", ".sol", ".proto",
  ".vue", ".svelte", ".graphql", ".gql", ".sh", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".dockerfile", ".html", ".htm", ".css", ".scss", ".sass", ".less",
]);

const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "procfile", "gemfile", "rakefile", "justfile", "jenkinsfile", ".env", ".npmrc", ".yarnrc", ".babelrc", ".eslintrc", ".prettierrc",
  ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".ico", ".avif", ".heic", ".heif", ".pdf", ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".mp3", ".wav", ".flac", ".mp4", ".mov", ".avi", ".mkv", ".woff", ".woff2", ".ttf", ".otf", ".exe", ".dll", ".so", ".dylib",
]);

function looksLikeText(buffer) {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controls += 1;
  }
  const decoded = sample.toString("utf8");
  const replacements = decoded.match(/\uFFFD/g)?.length ?? 0;
  return controls / sample.length < 0.02 && replacements / Math.max(1, decoded.length) < 0.02;
}

function isTextLike(record, sampled) {
  const mediaType = String(record.media_type || "").toLowerCase();
  const extension = path.extname(record.original_name || "").toLowerCase();
  const filename = path.basename(record.original_name || "").toLowerCase();
  const explicitlyText = mediaType.startsWith("text/") ||
    /(?:json|xml|yaml|javascript|typescript|php|python|ruby|java|csharp|swift|kotlin|dart|csv|markdown|sql|toml|x-sh|form-urlencoded)/.test(mediaType) ||
    TEXT_EXTENSIONS.has(extension) || TEXT_FILENAMES.has(filename);
  if (explicitlyText) return true;
  if (BINARY_EXTENSIONS.has(extension) || /^(?:image|audio|video|font)\//.test(mediaType) || /(?:pdf|zip|gzip|compressed|archive)/.test(mediaType)) return false;
  return looksLikeText(sampled);
}

function readEdges(filePath, sizeBytes) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    if (sizeBytes <= FULL_TEXT_BYTES) return fs.readFileSync(descriptor);
    const first = Buffer.alloc(Math.min(SAMPLE_EDGE_BYTES, sizeBytes));
    fs.readSync(descriptor, first, 0, first.length, 0);
    const lastLength = Math.min(SAMPLE_EDGE_BYTES, Math.max(0, sizeBytes - first.length));
    const last = Buffer.alloc(lastLength);
    if (lastLength > 0) fs.readSync(descriptor, last, 0, lastLength, sizeBytes - lastLength);
    return Buffer.concat([first, Buffer.from("\n\n[... middle bytes omitted ...]\n\n"), last]);
  } finally {
    fs.closeSync(descriptor);
  }
}

function printableStrings(buffer, limit = 80) {
  const text = buffer.toString("utf8");
  const values = text.match(/[\p{L}\p{N}\p{P}\p{S}][\p{L}\p{N}\p{P}\p{S} \t]{5,}/gu) ?? [];
  return values
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function byteSummary(record, buffer) {
  const first = buffer.subarray(0, 96).toString("hex").match(/.{1,2}/g)?.join(" ") ?? "";
  const last = buffer.subarray(Math.max(0, buffer.length - 96)).toString("hex").match(/.{1,2}/g)?.join(" ") ?? "";
  const strings = printableStrings(buffer);
  return [
    `Original filename: ${JSON.stringify(record.original_name)}`,
    `Declared media type: ${record.media_type || "application/octet-stream"}`,
    `File size: ${record.size_bytes} bytes`,
    `SHA-256: ${record.sha256}`,
    `First sampled bytes (hex): ${first || "(empty)"}`,
    `Last sampled bytes (hex): ${last || "(empty)"}`,
    "Printable strings from the sampled bytes:",
    strings.length > 0 ? strings.map((value, index) => `${index + 1}. ${value}`).join("\n") : "(none)",
  ].join("\n");
}

function buildPrompt(spec, record, deliveryMode, materialDescription, { repair = false } = {}) {
  const instruction = typeof spec.instruction === "string" && spec.instruction.trim()
    ? spec.instruction.trim()
    : "Confirm that you received and can read the attachment, identify only its broad type, and give one short observable clue.";
  return [
    "Inspect the supplied attachment before answering. This request is not asking who you are.",
    repair ? "Your previous response did not contain a valid attachment-analysis JSON object for this attachment-recognition check. Inspect the attachment again now and follow the schema exactly." : "You are performing a separate attachment-understanding check. Do not discuss hidden reasoning.",
    `Analysis request ID: ${randomUUID()}`,
    `Filename: ${record.original_name}`,
    `Delivery mode: ${deliveryMode}`,
    materialDescription ? `Material note: ${materialDescription}` : "",
    `Optional user note (not a scoring criterion): ${instruction}`,
    "Do not guess exact OCR, detailed purpose, or hidden intent. For source code, JSON, PHP, Python, JavaScript, or other text, it is enough to say that readable source or structured text was received and name the broad format.",
    "Return one JSON object with exactly these keys:",
    '{"attachment_received":true,"attachment_type":"image|document|source_code|structured_data|text|archive|other|unknown","observation":"short evidence grounded in the supplied attachment","confidence":0}',
    "attachment_received must be false when the attachment was not visible or readable. Use an empty observation and confidence 0 in that case. Never replace the result with a self-introduction.",
    "The result only answers whether the attachment reached the model and could be read. It does not grade the model, validate semantic accuracy, or affect the primary score.",
  ].filter(Boolean).join("\n");
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const ATTACHMENT_MISSING_PATTERN = /(?:no|without|missing).{0,40}(?:attachment|image|file)|(?:attachment|image|file).{0,40}(?:not supplied|not provided|not transmitted|was not supplied|was not provided|unavailable)|(?:未|没有)(?:提供|收到|传输|上传).{0,12}(?:附件|图片|文件)/i;
const MODEL_SELF_INTRODUCTION_PATTERN = /\b(?:i(?:['\u2019]m| am))\s+(?:claude|chatgpt|gemini|copilot|an?\s+(?:ai|artificial intelligence)(?:\s+assistant)?|an?\s+assistant)\b|(?:我是|作为)(?:\s*(?:claude|chatgpt|gemini|copilot)|.{0,12}(?:ai|人工智能)(?:助手|模型))/i;
const ATTACHMENT_REFUSAL_PATTERN = /\b(?:i\s+(?:can't|cannot|couldn't|wasn't able to|am unable to)|unable to|cannot)\s+(?:see|view|read|access|analy[sz]e|process|interpret)\b|\b(?:no|without)\s+(?:visual|image)\s+capabilit(?:y|ies)\b|(?:无法|不能|看不到|看不见|无法识别|不支持).{0,20}(?:附件|图片|文件|内容|读取|识别)/i;
const MODEL_GENERIC_ASSISTANT_PATTERN = /^(?:i\s+(?:can|could|will|would)\s+(?:help|assist|answer|provide|try|do)\b|i(?:['\u2019]m| am)\s+here\s+to\s+(?:help|assist)\b|i(?:['\u2019]d| would)\s+be\s+happy\s+to\b|sure\b|of course\b|certainly\b|happy to\b|how can i\b|let me know\b|thanks? for (?:sharing|uploading)\b|thank you for (?:sharing|uploading)\b|(?:当然|好的|我可以帮你|我能帮你|请提供|让我来|很乐意|已收到附件|收到附件))/i;

function hasGroundedAttachmentEvidence(analysis) {
  const evidence = isStringArray(analysis?.evidence) ? analysis.evidence : [];
  return Boolean(
    String(analysis?.observation || "").trim() ||
    String(analysis?.observable_content || "").trim() ||
    String(analysis?.likely_purpose || "").trim() ||
    String(analysis?.extracted_text || "").trim() ||
    evidence.some((item) => String(item || "").trim()),
  );
}

export function isUngroundedAttachmentAnalysis(analysis) {
  const limitations = Array.isArray(analysis?.limitations) ? analysis.limitations.join(" ") : "";
  if (analysis?.attachment_received === false || analysis?.recognized === false) return true;
  const narrative = [analysis?.observation, analysis?.attachment_type, analysis?.observable_content, analysis?.likely_purpose]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  const evidence = isStringArray(analysis?.evidence) ? analysis.evidence : [];
  const extractedText = String(analysis?.extracted_text || "").trim();
  const positiveTextEvidence = Boolean(
    extractedText ||
    evidence.some((item) => String(item || "").trim()),
  );
  const corroboratedQuotedContent = Boolean(
    extractedText &&
    evidence.some((item) => String(item || "").trim()) &&
    String(analysis?.observable_content || analysis?.observation || analysis?.likely_purpose || "").trim(),
  );
  const suspiciousNarrative = ATTACHMENT_MISSING_PATTERN.test(narrative) ||
    ATTACHMENT_REFUSAL_PATTERN.test(narrative) ||
    MODEL_SELF_INTRODUCTION_PATTERN.test(narrative) ||
    MODEL_GENERIC_ASSISTANT_PATTERN.test(narrative);
  if (suspiciousNarrative && !corroboratedQuotedContent) return true;
  const hasEvidence = hasGroundedAttachmentEvidence(analysis);
  if (!hasEvidence) return true;
  if ((ATTACHMENT_MISSING_PATTERN.test(limitations) || ATTACHMENT_REFUSAL_PATTERN.test(limitations) || MODEL_GENERIC_ASSISTANT_PATTERN.test(limitations)) && !positiveTextEvidence) return true;
  return false;
}

export function parseAttachmentAnalysis(text) {
  const trimmed = String(text || "").trim();
  const structuredCandidate = /^\s*[\[{]/.test(trimmed) || /^\s*```(?:json)?\b/i.test(trimmed) || /\{[\s\S]*\}/.test(trimmed);
  const candidates = [trimmed, trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], trimmed.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const hasLegacyShape = typeof value.observable_content === "string" &&
        typeof value.extracted_text === "string" &&
        typeof value.likely_purpose === "string" &&
        isStringArray(value.evidence) &&
        isStringArray(value.alternatives) &&
        Number.isFinite(value.confidence) &&
        isStringArray(value.limitations);
      const receivedValue = typeof value.attachment_received === "boolean"
        ? value.attachment_received
        : typeof value.recognized === "boolean"
          ? value.recognized
          : null;
      const observation = typeof value.observation === "string"
        ? value.observation.trim()
        : "";
      const observableContent = typeof value.observable_content === "string"
        ? value.observable_content.trim()
        : observation;
      const type = typeof value.attachment_type === "string" ? value.attachment_type.trim() : "";
      const hasRecognitionShape = receivedValue !== null && typeof value.observation === "string" && typeof value.attachment_type === "string";
      if (!hasLegacyShape && !hasRecognitionShape) continue;
      const extractedText = typeof value.extracted_text === "string" ? value.extracted_text : "";
      const evidence = isStringArray(value.evidence)
        ? value.evidence
        : observation ? [observation] : [];
      const limitations = isStringArray(value.limitations) ? value.limitations : [];
      return {
        ok: true,
        analysis: {
          ...(receivedValue === null ? {} : { attachment_received: receivedValue }),
          ...(type ? { attachment_type: type } : {}),
          ...(observation ? { observation } : {}),
          observable_content: observableContent,
          extracted_text: extractedText,
          likely_purpose: typeof value.likely_purpose === "string" ? value.likely_purpose : "",
          evidence,
          alternatives: isStringArray(value.alternatives) ? value.alternatives : [],
          confidence: Number.isFinite(value.confidence)
            ? Math.max(0, Math.min(100, Math.round(value.confidence)))
            : receivedValue === true ? 80 : 0,
          limitations,
        },
        error: null,
      };
    } catch {
      // Try the next JSON-shaped candidate.
    }
  }
  // A few compatible endpoints ignore JSON-only instructions. A concise,
  // attachment-grounded free-form observation is still enough for the
  // recognition check; self-introductions and refusals remain failures.
  if (trimmed.length >= 12 && !structuredCandidate && !MODEL_SELF_INTRODUCTION_PATTERN.test(trimmed) && !MODEL_GENERIC_ASSISTANT_PATTERN.test(trimmed) && !ATTACHMENT_MISSING_PATTERN.test(trimmed) && !ATTACHMENT_REFUSAL_PATTERN.test(trimmed)) {
    return {
      ok: true,
      analysis: {
        observation: trimmed,
        observable_content: trimmed,
        extracted_text: "",
        likely_purpose: "",
        evidence: [trimmed],
        alternatives: [],
        confidence: 50,
        limitations: ["The model returned a free-form observation instead of the optional JSON shape."],
      },
      error: null,
    };
  }
  return { ok: false, analysis: null, error: "attachment_invalid_analysis_structure" };
}

function canonicalIntentText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/登陆/g, "登录")
    .replace(/身份(?:认证|校验)/g, "身份验证")
    .replace(/(?:屏幕截图|截屏)/g, "截图")
    .replace(/付款/g, "支付")
    .replace(/(?:报错|错误|异常)/g, "失败")
    .replace(/\bsign[\s-]?in\b/g, "login")
    .replace(/\blog[\s-]?in\b/g, "login")
    .replace(/\b(?:authentication|identity verification)\b/g, "identitycheck")
    .replace(/\b(?:failed|failure|error)\b/g, "failure")
    .replace(/\b(?:screen ?shot|screen capture)\b/g, "screenshot");
}

function comparisonTokens(value) {
  const canonical = canonicalIntentText(value);
  const normalized = canonical.replace(/[\p{P}\p{S}\s]+/gu, "");
  const words = canonical.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  const chinese = [...normalized].filter((char) => /[\u3400-\u9fff]/.test(char));
  const bigrams = chinese.slice(0, -1).map((char, index) => `${char}${chinese[index + 1]}`);
  return { normalized, values: [...new Set([...words, ...bigrams])] };
}

function expectedPolarity(normalized) {
  for (const prefix of ["并不是", "不属于", "不能用于", "不可用于", "不是", "并非", "isnot", "isnt", "doesnot", "doesnt", "not", "no"]) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      return { negative: true, core: normalized.slice(prefix.length) };
    }
  }
  return { negative: false, core: normalized };
}

function phraseMentions(source, phrase) {
  let positive = 0;
  let negative = 0;
  let index = source.indexOf(phrase);
  while (index !== -1) {
    const prefix = source.slice(Math.max(0, index - 12), index);
    if (/(?:并不是|不属于|不能用于|不可用于|不是|并非|isnot|isnt|doesnot|doesnt|not|no)$/.test(prefix)) negative += 1;
    else positive += 1;
    index = source.indexOf(phrase, index + Math.max(1, phrase.length));
  }
  return { positive, negative };
}

export function verifyExpectedIntent(expected, analysis) {
  const source = [analysis.observable_content, analysis.extracted_text, analysis.likely_purpose, ...analysis.evidence].join(" ");
  const expectedTokens = comparisonTokens(expected);
  const actualTokens = comparisonTokens(source);
  if (!expectedTokens.normalized) return null;
  const polarity = expectedPolarity(expectedTokens.normalized);
  const mentions = polarity.core ? phraseMentions(actualTokens.normalized, polarity.core) : { positive: 0, negative: 0 };
  if (mentions.positive > 0 || mentions.negative > 0) {
    const matchingMentions = polarity.negative ? mentions.negative : mentions.positive;
    const conflictingMentions = polarity.negative ? mentions.positive : mentions.negative;
    if (matchingMentions > 0 && conflictingMentions === 0) {
      return { status: "match", matched_ratio: 1, method: "evidence-overlap-v2", reason: "exact-consistent-mention" };
    }
    if (conflictingMentions > 0 && matchingMentions === 0) {
      return { status: "no-match", matched_ratio: 0, method: "evidence-overlap-v2", reason: "negation-conflict" };
    }
    return { status: "partial", matched_ratio: 0.5, method: "evidence-overlap-v2", reason: "mixed-polarity-evidence" };
  }
  const actualSet = new Set(actualTokens.values);
  const matched = expectedTokens.values.filter((token) => actualSet.has(token)).length;
  const ratio = expectedTokens.values.length > 0 ? matched / expectedTokens.values.length : 0;
  return {
    status: ratio >= 0.65 ? "match" : ratio >= 0.3 ? "partial" : "no-match",
    matched_ratio: Number(ratio.toFixed(2)),
    method: "evidence-overlap-v2",
    reason: ratio >= 0.65 ? "token-overlap" : ratio >= 0.3 ? "limited-token-overlap" : "insufficient-token-overlap",
  };
}

function nativeKind(record, protocol) {
  if (record.size_bytes > NATIVE_INLINE_BYTES) return null;
  const mediaType = String(record.media_type || "").toLowerCase();
  if (mediaType.startsWith("image/") && ["anthropic", "openai-chat", "openai-responses", "google-generative"].includes(protocol)) {
    return "image";
  }
  if (mediaType === "application/pdf" && ["anthropic", "openai-responses", "google-generative"].includes(protocol)) {
    return "document";
  }
  return null;
}

function inferredNativeMediaType(record) {
  const declared = String(record.media_type || "").toLowerCase();
  if (declared.startsWith("image/") || declared === "application/pdf") return declared;
  const extension = path.extname(record.original_name || "").toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".pdf": "application/pdf",
  })[extension] || declared || "application/octet-stream";
}

function isVisualAttachment(record) {
  const mediaType = inferredNativeMediaType(record);
  return mediaType.startsWith("image/");
}

const NONSTANDARD_IMAGE_EXTENSIONS = new Set([".avif", ".heic", ".heif"]);
const NONSTANDARD_IMAGE_MEDIA_TYPES = new Set(["image/avif", "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

async function prepareNativePayload(record, nativeType) {
  const source = fs.readFileSync(record.storage_path);
  const extension = path.extname(record.original_name || "").toLowerCase();
  const mediaType = String(record.media_type || "").toLowerCase();
  const requiresConversion = NONSTANDARD_IMAGE_EXTENSIONS.has(extension) || NONSTANDARD_IMAGE_MEDIA_TYPES.has(mediaType);
  const unchanged = {
    data: source.toString("base64"),
    mediaType: record.media_type,
    sizeBytes: source.length,
    optimized: false,
  };
  if (nativeType !== "image") return unchanged;

  try {
    const metadata = await sharp(source, { animated: false }).metadata();
    const oversizedDimensions = Number(metadata.width || 0) > 4096 || Number(metadata.height || 0) > 4096;
    if (!requiresConversion && source.length <= NATIVE_IMAGE_TARGET_BYTES && !oversizedDimensions) return unchanged;

    if (requiresConversion) {
      const converted = await sharp(source, { animated: false })
        .rotate()
        .webp({ quality: 88, effort: 1 })
        .toBuffer();
      return {
        data: converted.toString("base64"),
        mediaType: "image/webp",
        sizeBytes: converted.length,
        optimized: true,
      };
    }

    let best = null;
    for (const dimension of [2048, 1600, 1280, 1024]) {
      for (const quality of [88, 76, 64]) {
        const candidate = await sharp(source, { animated: false })
          .rotate()
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .webp({ quality, effort: 1 })
          .toBuffer();
        if (!best || candidate.length < best.length) best = candidate;
        if (candidate.length <= NATIVE_IMAGE_TARGET_BYTES) {
          return {
            data: candidate.toString("base64"),
            mediaType: "image/webp",
            sizeBytes: candidate.length,
            optimized: true,
          };
        }
      }
    }
    if (best) {
      return {
        data: best.toString("base64"),
        mediaType: "image/webp",
        sizeBytes: best.length,
        optimized: true,
      };
    }
  } catch {}
  return unchanged;
}

function cachedPdfPreview(record, cache, renderer, signal) {
  const key = `${record.storage_path}:${record.size_bytes}:${record.sha256}`;
  if (!cache) return renderer(record.storage_path, { signal });
  if (!cache.has(key)) cache.set(key, renderer(record.storage_path, { signal }));
  return cache.get(key);
}

function createBody({ protocol, model, prompt, record, nativeType, data, representation, endpoint }) {
  const systemInstruction = `${ATTACHMENT_SYSTEM_INSTRUCTION}\n\n${prompt}`;
  if (protocol === "anthropic") {
    const content = nativeType === "image"
      ? [{ type: "image", source: { type: "base64", media_type: record.media_type, data } }, { type: "text", text: prompt }]
      : nativeType === "document"
        ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }, { type: "text", text: prompt }]
        : [{ type: "text", text: `${prompt}\n\nAttachment-derived material:\n\n${representation}` }];
    const vertexAnthropic = (() => {
      try {
        return /(?:^|[.-])aiplatform\.googleapis\.com$/i.test(new URL(endpoint).hostname);
      } catch {
        return false;
      }
    })();
    return { model, system: systemInstruction, max_tokens: 2048, stream: false, messages: [{ role: "user", content }], ...(vertexAnthropic ? { anthropic_version: "vertex-2023-10-16" } : {}) };
  }
  if (protocol === "google-generative") {
    const parts = nativeType
      ? [{ inlineData: { mimeType: record.media_type, data } }, { text: prompt }]
      : [{ text: `${prompt}\n\nAttachment-derived material:\n\n${representation}` }];
    return { systemInstruction: { parts: [{ text: systemInstruction }] }, contents: [{ role: "user", parts }], generationConfig: { temperature: 0, maxOutputTokens: 2048 } };
  }
  if (protocol === "openai-responses") {
    const content = [];
    if (nativeType === "image") content.push({ type: "input_image", image_url: `data:${record.media_type};base64,${data}` });
    else if (nativeType === "document") content.push({ type: "input_file", filename: record.original_name, file_data: `data:application/pdf;base64,${data}` });
    else content.push({ type: "input_text", text: `Attachment-derived material:\n\n${representation}` });
    content.push({ type: "input_text", text: prompt });
    return { model, instructions: systemInstruction, input: [{ role: "user", content }], max_output_tokens: 2048, store: false };
  }
  const content = nativeType === "image"
    ? [{ type: "image_url", image_url: { url: `data:${record.media_type};base64,${data}` } }, { type: "text", text: prompt }]
    : `${prompt}\n\nAttachment-derived material:\n\n${representation}`;
  return { model, messages: [{ role: "system", content: systemInstruction }, { role: "user", content }], max_completion_tokens: 2048, stream: false, temperature: 0 };
}

async function invokeAnalysisProbe({ input, record, spec, probe, signal, previewCache, pdfRenderer, forceRepresentation = false, repair = false }) {
  const endpointInfo = resolveDetectionEndpoint(input.baseUrl, input.model, input.protocol, input.profileModel);
  if (endpointInfo.protocol === "openai-images") {
    return { status: "unsupported", upstreamStatus: 0, error: "image_generation_protocol_cannot_analyze_attachments" };
  }
  const sampled = readEdges(record.storage_path, record.size_bytes);
  const inferredRecord = { ...record, media_type: inferredNativeMediaType(record) };
  const isPdf = inferredRecord.media_type === "application/pdf";
  let nativeType = forceRepresentation ? null : nativeKind(inferredRecord, endpointInfo.protocol);
  let pdfPreview = null;
  let pdfPreviewError = null;
  if (isPdf && nativeType === null) {
    try {
      pdfPreview = await cachedPdfPreview(inferredRecord, previewCache, pdfRenderer, signal);
      nativeType = "image";
    } catch (error) {
      pdfPreviewError = error instanceof Error ? error.message : "pdf_preview_conversion_failed";
    }
  }
  const textLike = isTextLike(record, sampled);
  const representation = textLike
    ? sampled.toString("utf8")
    : byteSummary(record, sampled);
  const sampledBytes = Math.min(record.size_bytes, record.size_bytes <= FULL_TEXT_BYTES ? record.size_bytes : SAMPLE_EDGE_BYTES * 2);
  const deliveryMode = pdfPreview ? "pdf-preview" : nativeType ? "native" : textLike
    ? sampledBytes >= record.size_bytes ? "extracted" : "sampled"
    : "byte-summary";
  const coveragePercent = pdfPreview
    ? Number(((pdfPreview.pageIndexes.length / pdfPreview.totalPages) * 100).toFixed(2))
    : nativeType || record.size_bytes === 0
    ? 100
    : Number(Math.min(100, (sampledBytes / record.size_bytes) * 100).toFixed(2));
  if (isPdf && nativeType === null) {
    return {
      status: "failed",
      upstreamStatus: 0,
      error: "attachment_pdf_preview_failed",
      deliveryMode,
      coveragePercent: 0,
      analysisProtocol: endpointInfo.protocol,
      nativeAttempted: false,
      nativeOptimized: false,
      transmittedMediaType: null,
      transmittedSizeBytes: null,
      pdfPreviewGenerated: false,
      pdfPreviewError,
    };
  }
  const prompt = buildPrompt(
    spec,
    record,
    deliveryMode,
    pdfPreview
      ? `Rendered representative PDF pages ${pdfPreview.pageIndexes.map((index) => index + 1).join(", ")} of ${pdfPreview.totalPages}.`
      : deliveryMode === "sampled" ? `Only ${coveragePercent}% of the bytes fit in this analysis request.` : "",
    { repair },
  );
  const nativePayload = pdfPreview
    ? {
      data: pdfPreview.buffer.toString("base64"),
      mediaType: "image/webp",
      sizeBytes: pdfPreview.buffer.length,
      optimized: true,
    }
    : nativeType ? await prepareNativePayload(inferredRecord, nativeType) : null;
  const requestRecord = nativePayload ? { ...inferredRecord, media_type: nativePayload.mediaType } : inferredRecord;
  const data = nativePayload?.data ?? null;
  const resultMetadata = {
    deliveryMode,
    coveragePercent,
    analysisProtocol: endpointInfo.protocol,
    nativeAttempted: Boolean(nativeType),
    nativeOptimized: nativePayload?.optimized === true,
    transmittedMediaType: nativePayload?.mediaType ?? null,
    transmittedSizeBytes: nativePayload?.sizeBytes ?? null,
    pdfPreviewGenerated: Boolean(pdfPreview),
    pdfPreviewPageCount: pdfPreview?.totalPages ?? null,
    pdfPreviewPages: pdfPreview?.pageIndexes.map((index) => index + 1) ?? [],
    pdfPreviewBackend: pdfPreview?.backend ?? null,
    pdfPreviewError,
  };
  const response = await probe({
    stage: "attachment-analysis",
    mode: endpointInfo.protocol,
    endpoint: endpointInfo.endpoint,
    method: "POST",
    headers: requestHeaders(endpointInfo.protocol, endpointInfo.endpoint, input.upstreamApiKey),
    body: createBody({
      protocol: endpointInfo.protocol,
      model: input.model,
      prompt,
      record: requestRecord,
      nativeType,
      data,
      representation,
      endpoint: endpointInfo.endpoint,
    }),
  }, { signal });
  const upstreamStatus = typeof response?.status === "number" ? response.status : 0;
  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    return {
      status: "failed",
      upstreamStatus,
      error: `attachment_upstream_http_${upstreamStatus || 0}`,
      ...resultMetadata,
      upstreamMessageId: response?.messageId ?? null,
    };
  }
  let payload;
  try {
    payload = JSON.parse(response.bodyText || "{}");
  } catch {
    return {
      status: "failed",
      upstreamStatus,
      error: "attachment_invalid_upstream_json",
      ...resultMetadata,
      upstreamMessageId: response?.messageId ?? null,
    };
  }
  const responseText = extractText(payload, endpointInfo.protocol);
  const parsed = responseText
    ? parseAttachmentAnalysis(responseText)
    : { ok: false, analysis: null, error: "attachment_empty_model_response" };
  const attachmentIgnored = parsed.ok && isUngroundedAttachmentAnalysis(parsed.analysis);
  return {
    status: parsed.ok && !attachmentIgnored ? "completed" : "failed",
    upstreamStatus,
    error: attachmentIgnored ? "attachment_not_observed_by_model" : parsed.error,
    ...resultMetadata,
    upstreamMessageId: response?.messageId ?? null,
    responseText,
    analysis: attachmentIgnored ? null : parsed.analysis,
    retryableFormatError: !parsed.ok || attachmentIgnored,
  };
}

async function invokeAnalysisWithRetry({
  input,
  record,
  spec,
  probe,
  signal,
  previewCache,
  pdfRenderer,
  skipMissingRepair = false,
  maxAttempts = 2,
  preferVisionFallback = false,
}) {
  const attemptLimit = Math.max(1, Math.min(5, Math.trunc(Number(maxAttempts)) || 2));
  let attempts = 1;
  let formatRetry = false;
  let result = await invokeAnalysisProbe({ input, record, spec, probe, signal, previewCache, pdfRenderer });
  if (
    !preferVisionFallback &&
    result.status === "failed" &&
    result.nativeAttempted &&
    [400, 413, 415, 422].includes(result.upstreamStatus)
  ) {
    const fallback = await invokeAnalysisProbe({ input, record, spec, probe, signal, previewCache, pdfRenderer, forceRepresentation: true });
    result = { ...fallback, fallback_from_native: true };
    attempts += 1;
  }
  while (
    attempts < attemptLimit &&
    result.retryableFormatError &&
    !(skipMissingRepair && result.error === "attachment_not_observed_by_model")
  ) {
    const repaired = await invokeAnalysisProbe({
      input,
      record,
      spec,
      probe,
      signal,
      previewCache,
      pdfRenderer,
      forceRepresentation: result.fallback_from_native === true,
      repair: true,
    });
    attempts += 1;
    formatRetry = true;
    result = {
      ...repaired,
      fallback_from_native: result.fallback_from_native === true,
      format_retry: true,
    };
  }
  return { ...result, attemptCount: attempts, format_retry: formatRetry || result.format_retry === true };
}

function normalizedFallbackModels(requestedModel, fallbackModels) {
  const values = Array.isArray(fallbackModels)
    ? fallbackModels
    : String(fallbackModels || "").split(",");
  const requested = String(requestedModel || "").trim().toLowerCase();
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .filter((value) => value.toLowerCase() !== requested)
    .slice(0, 3);
}

function normalizedFallbackProtocols(requestedProtocol, fallbackProtocols) {
  const supported = new Set(["anthropic", "openai-chat", "openai-responses", "google-generative"]);
  const values = Array.isArray(fallbackProtocols)
    ? fallbackProtocols
    : String(fallbackProtocols || "").split(",");
  const requested = String(requestedProtocol || "auto").trim().toLowerCase();
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter((value) => supported.has(value)))]
    .filter((value) => value !== requested)
    .slice(0, 3);
}

function canUseVisionModelFallback(result) {
  return result?.status === "failed" && result?.nativeAttempted === true && (
    [
      "attachment_not_observed_by_model",
      "attachment_invalid_analysis_structure",
      "attachment_empty_model_response",
      "attachment_invalid_upstream_json",
    ].includes(result.error) || /^attachment_upstream_http_\d+$/.test(String(result.error || ""))
  );
}

function recognitionReason(result) {
  if (result?.recognitionStatus === "not-recognized" && result?.recognitionReason) return result.recognitionReason;
  if (result?.status === "completed") return "model_returned_grounded_attachment_observation";
  if (result?.error === "attachment_pdf_preview_failed") return "pdf_preview_failed";
  if (result?.error === "attachment_not_observed_by_model") return "model_did_not_observe_attachment";
  if (result?.error === "attachment_invalid_analysis_structure" || result?.error === "attachment_empty_model_response") {
    return "model_returned_invalid_response";
  }
  if (result?.error === "attachment_invalid_upstream_json") return "upstream_returned_invalid_json";
  if (result?.upstreamStatus && (result.upstreamStatus < 200 || result.upstreamStatus >= 300)) return "upstream_request_failed";
  return "attachment_analysis_failed";
}

export async function analyzeAttachments({
  input,
  attachmentSpecs,
  storage,
  ownerScope,
  probe,
  signal,
  allowAnyOwner = false,
  fallbackModels = [],
  fallbackProtocols = [],
  fallbackAttempts = 2,
  pdfRenderer = renderPdfPreview,
}) {
  const items = [];
  const previewCache = new Map();
  const modelFallbacks = normalizedFallbackModels(input.model, fallbackModels);
  const protocolFallbacks = normalizedFallbackProtocols(input.protocol, fallbackProtocols);
  const modelAttemptLimit = Math.max(1, Math.min(5, Math.trunc(Number(fallbackAttempts)) || 2));
  for (const spec of attachmentSpecs) {
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("attachment_analysis_aborted"), { name: "AbortError" });
    const record = storage.getAttachment(spec.id, ownerScope, allowAnyOwner);
    if (!record) {
      items.push({
        attachment_id: spec.id,
        status: "not-found",
        recognition_status: "not-recognized",
        recognition_reason: "attachment_not_found",
        error: "attachment_not_found",
      });
      continue;
    }
    let result;
    try {
      result = await invokeAnalysisWithRetry({
        input,
        record,
        spec,
        probe,
        signal,
        previewCache,
        pdfRenderer,
        skipMissingRepair: modelFallbacks.length > 0,
        preferVisionFallback: modelFallbacks.length > 0,
      });
      let totalAttempts = result.attemptCount ?? 1;
      let anyFormatRetry = result.format_retry === true;
      if (canUseVisionModelFallback(result)) {
        let completedByFallback = false;
        for (const fallbackModel of modelFallbacks) {
          const protocols = [input.protocol, ...protocolFallbacks];
          for (let protocolIndex = 0; protocolIndex < protocols.length; protocolIndex += 1) {
            const fallbackInput = {
              ...input,
              model: fallbackModel,
              profileModel: fallbackModel,
              protocol: protocols[protocolIndex],
            };
            const fallbackResult = await invokeAnalysisWithRetry({
              input: fallbackInput,
              record,
              spec,
              probe,
              signal,
              previewCache,
              pdfRenderer,
              maxAttempts: modelAttemptLimit,
              preferVisionFallback: protocolIndex < protocols.length - 1,
            });
            totalAttempts += fallbackResult.attemptCount ?? 1;
            anyFormatRetry = anyFormatRetry || fallbackResult.format_retry === true;
            result = {
              ...fallbackResult,
              analysisModel: fallbackModel,
              modelFallback: true,
              modelFallbackReason: "selected_model_did_not_observe_attachment",
              protocolFallback: protocolIndex > 0,
              protocolFallbackReason: protocolIndex > 0 ? "visual_route_did_not_observe_attachment" : null,
              totalAttemptCount: totalAttempts,
              format_retry: anyFormatRetry,
            };
            if (result.status === "completed") {
              completedByFallback = true;
              break;
            }
          }
          if (completedByFallback) break;
        }
      }
      result = { ...result, totalAttemptCount: result.totalAttemptCount ?? totalAttempts, format_retry: anyFormatRetry };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      result = { status: "failed", upstreamStatus: 0, error: error instanceof Error ? error.message : "attachment_analysis_failed" };
    }
    const verification = result.analysis && spec.mode === "verify" && typeof spec.expected_intent === "string" && spec.expected_intent.trim()
      ? verifyExpectedIntent(spec.expected_intent, result.analysis)
      : null;
    const visualPayloadUnavailable = result.status === "completed" &&
      result.fallback_from_native === true &&
      result.deliveryMode === "byte-summary" &&
      isVisualAttachment(record);
    const recognitionStatus = result.status === "completed" && !visualPayloadUnavailable ? "recognized" : "not-recognized";
    const recognitionResult = visualPayloadUnavailable
      ? { recognitionStatus: "not-recognized", recognitionReason: "native_visual_payload_unavailable" }
      : result;
    items.push({
      attachment_id: record.id,
      name: record.original_name,
      media_type: record.media_type,
      size_bytes: record.size_bytes,
      sha256: record.sha256,
      mode: typeof spec.mode === "string" ? spec.mode : verification ? "verify" : "understand",
      status: result.status,
      recognition_status: recognitionStatus,
      recognition_reason: recognitionReason(recognitionResult),
      requested_model: input.model,
      analysis_model: result.analysisModel ?? input.model,
      model_fallback: result.modelFallback === true,
      model_fallback_reason: result.modelFallbackReason ?? null,
      requested_protocol: input.protocol,
      analysis_protocol: result.analysisProtocol ?? input.protocol,
      protocol_fallback: result.protocolFallback === true,
      protocol_fallback_reason: result.protocolFallbackReason ?? null,
      analysis_attempts: result.totalAttemptCount ?? result.attemptCount ?? 0,
      upstream_message_id: result.upstreamMessageId ?? null,
      delivery_mode: result.deliveryMode ?? null,
      coverage_percent: result.coveragePercent ?? null,
      upstream_status: result.upstreamStatus ?? 0,
      fallback_from_native: result.fallback_from_native === true,
      format_retry: result.format_retry === true,
      native_optimized: result.nativeOptimized === true,
      transmitted_media_type: result.transmittedMediaType ?? null,
      transmitted_size_bytes: result.transmittedSizeBytes ?? null,
      pdf_preview_generated: result.pdfPreviewGenerated === true,
      pdf_page_count: result.pdfPreviewPageCount ?? null,
      pdf_preview_pages: result.pdfPreviewPages ?? [],
      pdf_preview_backend: result.pdfPreviewBackend ?? null,
      pdf_preview_error: result.pdfPreviewError ?? null,
      analysis: result.analysis ?? null,
      verification,
      raw_response: result.responseText ?? null,
      error: result.error ?? null,
    });
  }
  const completed = items.filter((item) => item.status === "completed").length;
  const recognizedCount = items.filter((item) => item.recognition_status === "recognized").length;
  return {
    requested: true,
    status: completed === items.length ? "completed" : completed > 0 ? "partial" : "failed",
    recognition_status: items.length === 0 ? "not-recognized" : recognizedCount === items.length ? "recognized" : recognizedCount > 0 ? "partial" : "not-recognized",
    recognition_total: items.length,
    recognized_count: recognizedCount,
    scored: false,
    affects_primary_score: false,
    completed,
    total: items.length,
    items,
  };
}
