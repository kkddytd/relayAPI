import { describe, expect, it } from "vitest";
import {
  buildVerdict,
  createCacheRunId,
  createOpenApiDocument,
  DETECTION_MODELS,
  extractText,
  resolveDetectionEndpoint,
  resolveDetectionProfile,
  runModelDetection,
  validateDetectionRequest,
} from "./detection-api.mjs";
import { OFFICIAL_CLAUDE_PROBE_HEADERS, OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID } from "../shared/official-scoring.mjs";

const MESSAGE_ID = "msg_abcdefghijklmnopqrstuvwxyz";
const KNOWLEDGE_ANSWERS = [
  ["OpenAI model released on August 7, 2025", "GPT-5"],
  ["summit on August 15, 2025", "Anchorage"],
  ["campus event in Utah", "Charlie Kirk"],
  ["Kamchatka Peninsula", "8.8"],
  ["Japan's first female Prime Minister", "Sanae Takaichi"],
  ["U.S. state did President Donald Trump meet", "Alaska"],
  ["Nobel Prize in Literature", "Laszlo Krasznahorkai"],
  ["Nobel Peace Prize", "Corina Machado"],
  ["Council of Heads of State", "Tianjin"],
];

const GPT_KNOWLEDGE_ANSWERS = [
  ["restaurant in Liaoyang", "22 people"],
  ["Jet Set nightclub", "221 people"],
  ["epicenter in the Sea of Marmara", "6.2"],
  ["wooden boat HB Kongolo", "148 people"],
  ["all Chinese imports", "145%"],
  ["Israeli passports", "The Maldives"],
  ["announced a retaliatory tariff", "84%"],
  ["snap presidential election", "June 3, 2025"],
  ["remain Prime Minister of Canada", "Mark Carney"],
  ["grand coalition between the CDU/CSU", "Friedrich Merz"],
  ["first female Prime Minister of Liechtenstein", "Brigitte Haas"],
  ["genetically modified wolf pups", "Romulus, Remus, and Khaleesi"],
  ["broke Wayne Gretzky", "895"],
  ["Universal Studios United Kingdom", "Kempston Hardwick, Bedfordshire"],
  ["orbit over Earth's poles", "Fram2"],
  ["Ras Isa oil terminal", "74 people"],
  ["official total death toll of the Gaza war", "52,243"],
  ["center of Sumy", "At least 35 people"],
  ["Which country adopted the euro", "Bulgaria"],
  ["Which currency did Bulgaria adopt", "Euro"],
  ["Which currency did Bulgaria replace", "Bulgarian lev"],
  ["Bulgaria became which numbered member", "21st"],
  ["officially became the capital of Equatorial Guinea", "Ciudad de la Paz"],
  ["Ciudad de la Paz became the capital of which country", "Equatorial Guinea"],
  ["Which city did Ciudad de la Paz replace", "Malabo"],
  ["Which automaker surpassed Tesla", "BYD"],
  ["Which automaker did BYD overtake", "Tesla"],
  ["Which company became the world's top-selling electric-vehicle automaker", "BYD"],
  ["Who was sworn in as President of Switzerland", "Guy Parmelin"],
  ["Guy Parmelin became president of which country", "Switzerland"],
  ["Who did Guy Parmelin succeed", "Karin Keller-Sutter"],
  ["Which country became the first member state to withdraw", "United States"],
  ["Which international organization did the United States", "World Health Organization"],
  ["On what date did the United States withdrawal", "January 22, 2026"],
];

function passingKnowledge(body) {
  const prompt = JSON.stringify(body);
  return KNOWLEDGE_ANSWERS
    .map(([needle, answer]) => ({ index: prompt.indexOf(needle), answer }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((entry, index) => `${index + 1}|${entry.answer}`)
    .join("\n");
}

function passingGptKnowledge(body) {
  const prompt = JSON.stringify(body);
  return GPT_KNOWLEDGE_ANSWERS
    .map(([needle, answer]) => ({ index: prompt.indexOf(needle), answer }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((entry, index) => `${index + 1}|${entry.answer}`)
    .join("\n");
}

function pdfToken(body) {
  const documentBlock = body?.messages?.[0]?.content?.find((item) => item?.type === "document");
  if (!documentBlock?.source?.data) return "000000";
  const decoded = Buffer.from(documentBlock.source.data, "base64").toString("utf8");
  return decoded.match(/Hvoy\.ai report total (\d{6})/)?.[1] ?? "000000";
}

function calculation(body) {
  const content = body?.messages?.[0]?.content;
  const prompt = typeof content === "string"
    ? content
    : content?.find((item) => item?.type === "text")?.text ?? "";
  const match = prompt.match(/Calculate (\d+) times (\d+)/i) ?? prompt.match(/计算\s*(\d+)\s*乘以\s*(\d+)/);
  const left = Number(match?.[1] ?? 0);
  const right = Number(match?.[2] ?? 0);
  return { expression: `${left}*${right}`, result: left * right };
}

function requestPrompt(payload) {
  const messages = payload?.body?.messages;
  const content = Array.isArray(messages) ? messages.at(-1)?.content : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.find((item) => item?.type === "text")?.text ?? "";
  const input = payload?.body?.input;
  if (Array.isArray(input)) {
    const final = input.at(-1)?.content;
    return typeof final === "string" ? final : "";
  }
  return typeof input === "string" ? input : "";
}

function qualityLogicAnswer(prompt) {
  const target = prompt.match(/已知恰好有\s*(\d+)\s*句话为真/);
  const candidates = [...prompt.matchAll(/目标在「([^」]+)」之一。/g)]
    .map((match) => match[1].split("、"));
  const required = Number(target?.[1] ?? 0);
  const counts = new Map();
  for (const candidate of candidates) {
    for (const label of candidate) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].find(([, count]) => count === required)?.[0] ?? "";
}

function qualityCodingAnswer(prompt) {
  const values = prompt.match(/print\(f\(\[([\d,\s]+)\]\)\)/)?.[1]
    ?.split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite) ?? [];
  const output = [];
  values.forEach((value, index) => {
    const adjusted = value + index;
    if (adjusted % 3 === 0) output.unshift(value - index);
    else if (index % 2 === 0) output.push(value * 2 + index);
    else output.push(value + index * 2);
  });
  if (prompt.includes("out.reverse()")) output.reverse();
  return String(output.reduce((sum, value, index) => sum + (index + 1) * value, 0));
}

function qualityInstructionAnswer(prompt) {
  const csv = prompt.match(/处理以下 CSV（字段为 id,priority,active,tag）：\n([\s\S]*?)\n只保留/);
  const records = (csv?.[1] ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, priority, active, tag] = line.split(",");
      return { id, priority: Number(priority), active, tag };
    });
  return records
    .filter((record) => record.active === "Y" && record.priority >= 5 && record.priority % 2 === 1 && record.tag.startsWith("a"))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .map((record) => record.id)
    .join("-");
}

function qualityChineseAnswer(prompt) {
  const options = [...prompt.matchAll(/(?:^|\n)([A-D])\. ([^\n]+)/g)];
  return options.find(([, , option]) =>
    option.includes("至少有一个没有同时通过甲、乙两项复核的方案未被撤回") ||
    option.includes("至少有一个未通过复核的方案未被撤回"),
  )?.[1] ?? "";
}

function qualityStageOneAnswer(prompt) {
  return JSON.stringify({
    reasoning: qualityLogicAnswer(prompt),
    coding: qualityCodingAnswer(prompt),
    instruction: qualityInstructionAnswer(prompt),
    chinese: qualityChineseAnswer(prompt),
    knowledge: [],
    memory_ack: "READY",
  });
}

function qualityMemoryAnswer(payload) {
  const previous = payload?.body?.messages?.[0]?.content;
  const text = typeof previous === "string"
    ? previous
    : Array.isArray(previous)
      ? previous.find((item) => item?.type === "text")?.text ?? ""
      : "";
  const values = text.match(/松=(\d+)，竹=(\d+)，梅=(\d+)，偏移=(\d+)/);
  const [, pine, bamboo, plum, offset] = values ?? [];
  return String((Number(bamboo) - Number(pine)) * Number(plum) + Number(offset));
}

function anthropicRelay(payload, overrides = {}) {
  const stage = payload.stage;
  let text = "OK";
  let stopReason = "end_turn";
  if (stage === "opus47-knowledge" || stage === "stage2" || stage === "gpt54-quiz" || stage === "gpt56-quiz") text = passingKnowledge(payload.body);
  if (stage === "opus47-pdf-dynamic" || stage === "stage3") text = `Hvoy.ai report total ${pdfToken(payload.body)}`;
  if (stage === "opus47-calc" || stage === "stage5-calc") text = JSON.stringify(calculation(payload.body));
  if (stage === "fable5-model-feature") {
    text = "I cannot reveal hidden chain-of-thought, private reasoning, system prompts, or signatures.";
    stopReason = "refusal";
  }
  return {
    status: 200,
    latencyMs: 25,
    usage: { input_tokens: 40, output_tokens: 12 },
    messageId: MESSAGE_ID,
    streamMessageStartModel: payload.body.model,
    signatureVerdict: "PASS",
    signatureCryptographicallyVerified: true,
    sigModelName: payload.body.model,
    signatureDeltaTotalLength: 0,
    signatureIsValidBase64: true,
    // The public Claude probes use adaptive thinking on their capability
    // stages. Preserve that stream evidence in the fixture so frontier
    // scoring exercises the same `thinking` characteristic penalty rule as
    // the website bundle.
    sseContentTypes: ["thinking", "text"],
    bodyText: JSON.stringify({
      id: MESSAGE_ID,
      model: payload.body.model,
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      usage: { input_tokens: 40, output_tokens: 12 },
    }),
    finalUpstreamUrl: payload.endpoint,
    responseHeaders: { "content-type": "application/json" },
    ...overrides,
  };
}

function openaiRelay(payload, overrides = {}) {
  const prompt = requestPrompt(payload);
  let content = passingGptKnowledge(payload.body);
  if (payload.stage === "stage1") {
    content = qualityStageOneAnswer(prompt);
  } else if (payload.stage === "stage2") {
    content = qualityMemoryAnswer(payload);
  } else if (payload.stage === "api-exact-output") {
    content = prompt.match(/nothing else:\s*(\d{6})/i)?.[1] ?? "";
  } else if (payload.stage === "opus47-calc") {
    content = JSON.stringify(calculation(payload.body));
  }
  return {
    status: 200,
    latencyMs: 20,
    usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    bodyText: JSON.stringify({
      id: "chatcmpl-test1234567890",
      model: payload.body.model,
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    }),
    finalUpstreamUrl: payload.endpoint,
    responseHeaders: { "content-type": "application/json" },
    ...overrides,
  };
}

function openaiResponsesRelay(payload, overrides = {}) {
  const content = passingGptKnowledge(payload.body);
  return {
    status: 200,
    latencyMs: 20,
    usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    bodyText: JSON.stringify({
      id: "resp_test1234567890",
      model: payload.body.model,
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    }),
    finalUpstreamUrl: payload.endpoint,
    responseHeaders: { "content-type": "application/json" },
    ...overrides,
  };
}

function detectionInput(overrides = {}) {
  return {
    baseUrl: "https://relay.example",
    upstreamApiKey: "sk-test-only",
    model: "claude-fable-5",
    protocol: "auto",
    rounds: 1,
    checks: { cache: false, liveKnowledge: false },
    ...overrides,
  };
}

function dependencies(probe) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    seedSecret: "unit-test-seed",
    probe,
    cacheRoundDelayMs: 0,
    phaseDelayMs: 0,
    getLiveKnowledgeSnapshot: async () => {
      throw new Error("not_used");
    },
  };
}

describe("detection API request validation", () => {
  it("creates fixed-width unique cache run markers within the same millisecond", () => {
    const now = new Date("2026-07-17T12:34:56.789Z");
    const ids = Array.from({ length: 64 }, () => createCacheRunId(now));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^\d{17}[0-9a-z]{3}$/.test(id))).toBe(true);
  });

  it("normalizes defaults without exposing the upstream key", () => {
    const result = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-fable-5",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { protocol: "auto", questionMode: "official-random", rounds: 1, checks: { cache: false, liveKnowledge: false } },
    });
  });

  it("rejects embedded credentials and excessive rounds", () => {
    const result = validateDetectionRequest({
      base_url: "https://user:pass@relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-fable-5",
      rounds: 9,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["invalid_url", "invalid_rounds"]));
  });

  it("accepts one to three independent cache validation runs", () => {
    const valid = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-opus-4-8",
      checks: { cache: true, cache_runs: 3 },
    });
    expect(valid).toMatchObject({ ok: true, value: { cacheRuns: 3 } });

    for (const cacheRuns of [0, 1.5, 4]) {
      const invalid = validateDetectionRequest({
        base_url: "https://relay.example",
        upstream_api_key: "sk-test-only",
        model: "claude-opus-4-8",
        checks: { cache: true, cache_runs: cacheRuns },
      });
      expect(invalid).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ field: "checks.cache_runs", code: "invalid_cache_runs" }),
        ]),
      });
    }
  });

  it("accepts the explicit website-compatible random question mode", () => {
    const result = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "gpt-5.5",
      question_mode: "official-random",
    });
    expect(result).toMatchObject({ ok: true, value: { questionMode: "official-random" } });
  });

  it("auto-resolves Fable aliases and validates explicit profiles", () => {
    const automatic = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-5-fable",
    });
    expect(automatic).toMatchObject({
      ok: true,
      value: { model: "claude-5-fable", profileModel: "claude-fable-5", profileResolution: "auto-alias" },
    });

    const invalid = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "vendor/fable-v9",
      profile_model: "not-a-profile",
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toContainEqual(expect.objectContaining({ field: "profile_model", code: "unknown_profile_model" }));
  });

  it("rejects undocumented fields instead of silently skipping requested checks", () => {
    const result = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-fable-5",
      extra_option: true,
      checks: { cache: true, typo_live_knowledge: true },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "extra_option", code: "unknown_field" }),
      expect.objectContaining({ field: "checks.typo_live_knowledge", code: "unknown_field" }),
    ]));
  });

  it("rejects non-object checks and documents the deprecated upstream key alias", () => {
    const invalidChecks = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-fable-5",
      checks: "cache",
    });
    expect(invalidChecks).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ field: "checks", code: "invalid_checks" })]),
    });

    const legacyKey = validateDetectionRequest({
      base_url: "https://relay.example",
      api_key: "sk-legacy-key",
      model: "claude-fable-5",
    });
    expect(legacyKey).toMatchObject({ ok: true, value: { upstreamApiKey: "sk-legacy-key" } });
  });

  it("does not coerce JSON field types away from the documented contract", () => {
    const result = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-fable-5",
      profile_model: 5,
      protocol: false,
      rounds: "2",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "profile_model", code: "invalid_profile_model" }),
      expect.objectContaining({ field: "protocol", code: "invalid_protocol" }),
      expect.objectContaining({ field: "rounds", code: "invalid_rounds" }),
    ]));

    const mixedCredentialTypes = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: 123,
      api_key: "sk-legacy-key",
      model: "claude-fable-5",
    });
    expect(mixedCredentialTypes).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ field: "upstream_api_key", code: "invalid_upstream_api_key" })]),
    });
  });

  it("accepts uploaded attachment references and requires a hidden reference only for verify mode", () => {
    const valid = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "gpt-test",
      attachments: [
        { id: "att_0123456789abcdef0123456789abcdef", mode: "understand", instruction: "Describe it" },
        { id: "att_fedcba9876543210fedcba9876543210", mode: "verify", expected_intent: "A payment error" },
      ],
    });
    expect(valid).toMatchObject({
      ok: true,
      value: {
        attachments: [
          { id: "att_0123456789abcdef0123456789abcdef", mode: "understand", instruction: "Describe it" },
          { id: "att_fedcba9876543210fedcba9876543210", mode: "verify", expected_intent: "A payment error" },
        ],
      },
    });

    const invalid = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "gpt-test",
      attachments: [{ id: "not-an-upload-id", mode: "verify" }],
    });
    expect(invalid).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ field: "attachments.0.id", code: "invalid_attachment_id" }),
        expect.objectContaining({ field: "attachments.0.expected_intent", code: "required" }),
      ]),
    });

    const invalidUnderstandReference = validateDetectionRequest({
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "gpt-test",
      attachments: [{
        id: "att_0123456789abcdef0123456789abcdef",
        mode: "understand",
        expected_intent: "This must not trigger verification",
      }],
    });
    expect(invalidUnderstandReference).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ field: "attachments.0.expected_intent", code: "verify_mode_required" }),
      ]),
    });
  });
});

describe("detection endpoint resolution", () => {
  it("uses the actual custom model ID for automatic protocol selection", () => {
    expect(resolveDetectionEndpoint("https://relay.example", "gpt-private-v9", "auto")).toEqual({
      protocol: "openai-chat",
      endpoint: "https://relay.example/v1/chat/completions",
    });
  });

  it("treats OpenRouter hosts as OpenAI-compatible in automatic mode", () => {
    expect(resolveDetectionEndpoint("https://openrouter.ai/api/v1", "vendor/private-model", "auto")).toEqual({
      protocol: "openai-chat",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
    });
    expect(resolveDetectionEndpoint("https://edge.openrouter.ai/v1", "claude-private", "auto")).toEqual({
      protocol: "openai-chat",
      endpoint: "https://edge.openrouter.ai/v1/chat/completions",
    });
    expect(resolveDetectionEndpoint("https://openrouter.ai.evil.example/v1", "claude-private", "auto")).toEqual({
      protocol: "anthropic",
      endpoint: "https://openrouter.ai.evil.example/v1/messages",
    });
  });

  it("uses the evaluation profile to infer a custom image model protocol", () => {
    expect(resolveDetectionEndpoint("https://relay.example", "vendor/image-v2", "auto", "gpt-image-2")).toEqual({
      protocol: "openai-images",
      endpoint: "https://relay.example/v1/images/generations",
    });
  });

  it("matches the browser protocol for cross-provider custom model names", () => {
    expect(resolveDetectionEndpoint("https://relay.example/v1", "claude-custom-route", "auto", "gpt-5.6-sol")).toEqual({
      protocol: "openai-chat",
      endpoint: "https://relay.example/v1/chat/completions",
    });
    expect(resolveDetectionEndpoint("https://relay.example/v1", "gpt-custom-route", "auto", "claude-opus-4-8")).toEqual({
      protocol: "anthropic",
      endpoint: "https://relay.example/v1/messages",
    });
  });

  it("does not duplicate a configured bare /v1 for OpenAI or Anthropic endpoints", () => {
    expect(resolveDetectionEndpoint("https://relay.example/v1", "gpt-5.5", "openai-chat")).toEqual({
      protocol: "openai-chat",
      endpoint: "https://relay.example/v1/chat/completions",
    });
    expect(resolveDetectionEndpoint("https://relay.example/v1/", "claude-fable-5", "anthropic")).toEqual({
      protocol: "anthropic",
      endpoint: "https://relay.example/v1/messages",
    });
  });

  it("does not duplicate the AI Studio v1beta segment", () => {
    expect(resolveDetectionEndpoint(
      "https://generativelanguage.googleapis.com/v1beta/",
      "gemini-3.1-pro-preview",
      "auto",
    )).toEqual({
      protocol: "google-generative",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
    });
  });

  it("builds Vertex Anthropic routes from publisher bases and complete model routes", () => {
    const publisherBase = "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic";
    expect(resolveDetectionEndpoint(publisherBase, "vendor-gemini-alias", "google-generative")).toEqual({
      protocol: "google-generative",
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/vendor-gemini-alias:generateContent",
    });
    expect(resolveDetectionEndpoint(publisherBase, "claude-opus-4-8", "anthropic")).toEqual({
      protocol: "anthropic",
      endpoint: `${publisherBase}/models/claude-opus-4-8:rawPredict`,
    });
    expect(resolveDetectionEndpoint(
      `${publisherBase}/models/old-model:streamRawPredict?alt=sse`,
      "claude-opus-4-8",
      "auto",
    )).toEqual({
      protocol: "anthropic",
      endpoint: `${publisherBase}/models/claude-opus-4-8:streamRawPredict?alt=sse`,
    });
    expect(resolveDetectionEndpoint(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1",
      "vendor-claude-alias",
      "auto",
      "claude-opus-4-8",
    )).toEqual({
      protocol: "anthropic",
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/vendor-claude-alias:rawPredict",
    });
    expect(resolveDetectionEndpoint(
      "https://generativelanguage.googleapis.com/v1beta",
      "vendor-ai-studio-model",
      "auto",
      "claude-opus-4-8",
    )).toEqual({
      protocol: "google-generative",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/vendor-ai-studio-model:generateContent",
    });
  });
});

describe("detection response text extraction", () => {
  it("extracts OpenAI chat text arrays without stringifying objects", () => {
    expect(extractText({
      choices: [{ message: { content: [{ type: "text", text: "first" }, { type: "image_url", image_url: {} }, { type: "text", text: "second" }] } }],
    }, "openai-chat")).toBe("first\nsecond");
  });

  it("excludes Responses reasoning summaries and Gemini thought parts", () => {
    expect(extractText({
      output: [
        { type: "reasoning", text: "private reasoning", content: [{ type: "summary", text: "private summary" }] },
        { type: "message", content: [{ type: "output_text", text: "final answer" }] },
      ],
    }, "openai-responses")).toBe("final answer");
    expect(extractText({
      candidates: [{ content: { parts: [{ thought: true, text: "private thought" }, { text: "visible answer" }] } }],
    }, "google-generative")).toBe("visible answer");
  });
});

describe("detection model profiles", () => {
  it("uses the current GPT 5.6 dedicated allowlist and controlled aliases", () => {
    expect(DETECTION_MODELS.find((model) => model.id === "gpt-5.6")?.dedicated).toBe(false);
    expect(DETECTION_MODELS.find((model) => model.id === "gpt-5.6-sol")?.dedicated).toBe(true);
    expect(DETECTION_MODELS.find((model) => model.id === "gpt-5.6-terra")?.dedicated).toBe(true);
    expect(resolveDetectionProfile("claude-5-fable")).toMatchObject({ profileModelId: "claude-fable-5", match: "alias" });
    expect(resolveDetectionProfile("vendor/claude-fable-5").profileModelId).toBeNull();
  });

  it("uses the same family thresholds for the public result and provenance verdict", () => {
    const hiddenChannel = { transport_verified: false };
    const officialChannel = { transport_verified: true };
    const verdict = (profileModel, behavior, channel = hiddenChannel, dedicated = true) => buildVerdict(
      { dedicated, profileModel },
      { quality: behavior, behavior },
      channel,
      false,
      false,
      false,
    );

    expect(verdict("claude-opus-4-8", 59)).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });
    expect(verdict("claude-opus-4-8", 60)).toMatchObject({ value: "consistent", evidence_level: "behavioral" });
    expect(verdict("gpt-5.5", 69)).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });
    expect(verdict("gpt-5.5", 70)).toMatchObject({ value: "consistent", evidence_level: "behavioral" });
    expect(verdict("gemini-3.1-pro-preview", 69, officialChannel)).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });
    expect(verdict("gemini-3.1-pro-preview", 70, officialChannel)).toMatchObject({ value: "consistent", evidence_level: "provider-transport" });
    expect(verdict("gpt-5.6", 100, officialChannel, false)).toMatchObject({ value: "unverifiable", evidence_level: "insufficient" });
    expect(buildVerdict(
      { dedicated: true, profileModel: "claude-opus-4-8" },
      { quality: null, behavior: null },
      hiddenChannel,
      true,
      false,
      true,
      { stageIdentityOnly: true },
    )).toMatchObject({ value: "unverifiable", evidence_level: "insufficient" });
  });
});

describe("model detection reports", () => {
  it("preserves an explicitly supplied Google Bearer credential", async () => {
    const requests = [];
    await runModelDetection(
      detectionInput({
        upstreamApiKey: "Bearer google-access-token",
        model: "vendor-gemini-route",
        profileModel: "gemini-3.1-pro-preview",
        protocol: "google-generative",
      }),
      dependencies(async (payload) => {
        requests.push(payload);
        return {
          status: 200,
          latencyMs: 10,
          usage: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
          bodyText: JSON.stringify({
            modelVersion: payload.body.model,
            candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
          }),
          finalUpstreamUrl: payload.endpoint,
          responseHeaders: { "content-type": "application/json" },
        };
      }),
    );

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.headers.authorization === "Bearer google-access-token")).toBe(true);
    expect(requests.every((request) => request.headers["x-goog-api-key"] === undefined)).toBe(true);
  });

  it("runs the current GPT 5.6 Sol public quiz and keeps plain GPT 5.6 quality-only", async () => {
    const requests = [];
    const sol = await runModelDetection(
      detectionInput({ model: "gpt-5.6-sol", protocol: "auto" }),
      dependencies(async (payload) => {
        requests.push(payload);
        return openaiRelay(payload);
      }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ stage: "gpt56-quiz", mode: "openai-chat" });
    expect(requests[0].body).toMatchObject({ model: "gpt-5.6-sol", max_completion_tokens: 10240, stream: true });
    expect(sol.profile).toMatchObject({ dedicated: true, probe_family: "gpt-official" });
    expect(sol.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100, official_result: "pass" });

    const genericRequests = [];
    const generic = await runModelDetection(
      detectionInput({ model: "gpt-5.6", protocol: "auto" }),
      dependencies(async (payload) => {
        genericRequests.push(payload);
        return openaiRelay(payload);
      }),
    );
    expect(genericRequests.map((request) => request.stage)).toEqual(["stage1", "stage2"]);
    expect(genericRequests[1].body.messages).toHaveLength(3);
    expect(requestPrompt(genericRequests[1])).toContain("仅使用上一轮用户消息中的记忆参数");
    expect(generic.profile).toMatchObject({ dedicated: false, probe_family: "gpt-quality" });
    expect(generic.scores).toMatchObject({ primary: 100, primary_basis: "quality", quality: 100, official_compatibility: null, behavior: null, official_result: null });
    expect(generic.score).toBe(generic.scores.primary);
    expect(sol.score).toBe(sol.scores.primary);
    expect(generic.checks.map((item) => item.id)).toEqual(expect.arrayContaining([
      "capability_score", "reasoning", "coding", "instruction", "chinese", "memory",
    ]));
    expect(generic.verdict).toMatchObject({ value: "unverifiable", evidence_level: "insufficient" });
  });

  it("uses normalized OpenAI cache usage for the GPT 5.6 token penalty", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6-sol", protocol: "openai-chat" }),
      dependencies(async (payload) => {
        const relay = openaiRelay(payload);
        const body = JSON.parse(relay.bodyText);
        body.usage = {
          prompt_tokens: 3300,
          completion_tokens: 2100,
          total_tokens: 5400,
          prompt_tokens_details: { cached_tokens: 1200, cache_write_tokens: 300 },
        };
        return {
          ...relay,
          usage: body.usage,
          cacheReadInputTokens: 1200,
          cacheCreationInputTokens: 300,
          bodyText: JSON.stringify(body),
        };
      }),
    );

    expect(report.scores).toMatchObject({ primary: 94, official_compatibility: 94, behavior: 94 });
    expect(report.metrics).toMatchObject({ input_tokens: 1800, output_tokens: 2100 });
    expect(report.checks.find((item) => item.id === "token_usage")).toMatchObject({
      status: "warning",
      evidence: {
        penalty: {
          breakdown: { input: 0, output: 3, cacheRead: 3, cacheWrite: 0 },
          total: 6,
        },
      },
    });
  });

  it("rejects GPT quiz answers that contain an abstention before the expected value", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6-sol", protocol: "openai-chat", questionMode: "stable" }),
      dependencies(async (payload) => {
        const relay = openaiRelay(payload);
        const body = JSON.parse(relay.bodyText);
        body.choices[0].message.content = passingGptKnowledge(payload.body)
          .split("\n")
          .map((line) => line.replace("|", "|I don’t know, maybe "))
          .join("\n");
        return { ...relay, bodyText: JSON.stringify(body) };
      }),
    );

    expect(report.checks.find((item) => item.id === "knowledge")).toMatchObject({ status: "fail" });
    expect(report.scores.official_compatibility).toBeLessThan(60);
  });

  it("routes every quality-only GPT preset through the full cutoff-independent capability suite", async () => {
    const models = ["gpt-5.6-luna", "gpt-5.6", "gpt-5", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"];
    for (const model of models) {
      const stages = [];
      const report = await runModelDetection(
        detectionInput({ model, protocol: "auto" }),
        dependencies(async (payload) => {
          stages.push(payload.stage);
          return openaiRelay(payload);
        }),
      );
      expect(stages, model).toEqual(["stage1", "stage2"]);
      expect(report.profile, model).toMatchObject({ dedicated: false, probe_family: "gpt-quality" });
      expect(report.scores, model).toMatchObject({ primary: 100, primary_basis: "quality", quality: 100, official_compatibility: null, behavior: null });
    }
  });

  it("averages two completed stability rounds instead of selecting the higher score", async () => {
    let stageOneRound = 0;
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6", protocol: "auto", rounds: 2 }),
      dependencies(async (payload) => {
        if (payload.stage === "stage1") stageOneRound += 1;
        const relay = openaiRelay(payload);
        if (stageOneRound === 2 && payload.stage === "stage1") {
          const body = JSON.parse(relay.bodyText);
          body.choices[0].message.content = "{}";
          return { ...relay, bodyText: JSON.stringify(body) };
        }
        return relay;
      }),
    );

    expect(report.status).toBe("completed");
    expect(report.rounds.map((round) => round.quality_score)).toEqual([100, 18]);
    expect(report.scores).toMatchObject({ primary: 59, primary_basis: "quality", quality: 59, official_compatibility: null, behavior: null });
  });

  it("does not turn an unexecuted mandatory quality-memory probe into a low quality score", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6", protocol: "openai-chat" }),
      dependencies(async (payload) => {
        if (payload.stage === "stage1") return openaiRelay(payload);
        return {
          ...openaiRelay(payload),
          status: 0,
          bodyText: JSON.stringify({ error: { message: "internal_probe_timeout" } }),
        };
      }),
    );

    expect(report.status).toBe("incomplete");
    expect(report.rounds[0]).toMatchObject({ incomplete: true, quality_score: null });
    expect(report.scores).toMatchObject({ primary: null, quality: null, official_compatibility: null, behavior: null });
  });

  it("rotates dedicated knowledge batches across stability rounds", async () => {
    const requests = [];
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.5", protocol: "openai-chat", rounds: 3, questionMode: "stable" }),
      dependencies(async (payload) => {
        requests.push(payload);
        return openaiRelay(payload);
      }),
    );

    const prompts = requests.map(requestPrompt);
    expect(prompts).toHaveLength(3);
    expect(new Set(prompts).size).toBe(3);
    expect(report.rounds).toHaveLength(3);
    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100 });
    const questionIds = report.rounds.map((round) => round.checks.find((item) => item.id === "knowledge")?.evidence.question_ids ?? []);
    expect(questionIds[0].filter((id) => questionIds[1].includes(id))).toEqual([]);
  });

  it("does not publish a stale score when a later stability round is unavailable", async () => {
    let calls = 0;
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6", protocol: "auto", rounds: 3 }),
      dependencies(async (payload) => {
        calls += 1;
        if (calls > 2) {
          return {
            ...openaiRelay(payload),
            status: 429,
            bodyText: JSON.stringify({ error: { message: "Too many requests" } }),
          };
        }
        return openaiRelay(payload);
      }),
    );

    expect(report.rounds).toHaveLength(2);
    expect(report.rounds[0]).toMatchObject({ quality_score: 100, unavailable: false });
    expect(report.rounds[1]).toMatchObject({ quality_score: null, unavailable: true });
    expect(report.status).toBe("incomplete");
    expect(report.scores).toMatchObject({ primary: null, quality: null, official_compatibility: null, behavior: null });
    expect(report.verdict).toMatchObject({ value: "unverifiable", evidence_level: "insufficient" });
  });

  it("requires a reported GPT 5.6 Sol/Terra variant", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6-sol", protocol: "auto" }),
      dependencies(async (payload) => {
        const relay = openaiRelay(payload);
        const body = JSON.parse(relay.bodyText);
        delete body.model;
        return { ...relay, bodyText: JSON.stringify(body) };
      }),
    );
    expect(report.scores).toMatchObject({ quality: 100, official_compatibility: 64, behavior: 64 });
    expect(report.verdict).toMatchObject({ value: "suspicious", evidence_level: "conflict" });
  });

  it("recognizes the current OpenAI Responses protocol fields for dedicated GPT scoring", async () => {
    const requests = [];
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.5", protocol: "openai-responses" }),
      dependencies(async (payload) => {
        requests.push(payload);
        return openaiResponsesRelay(payload);
      }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      model: "gpt-5.5",
      input: [{ role: "user", content: expect.any(String) }],
      max_output_tokens: 10240,
      reasoning: { effort: "low" },
      store: false,
    });
    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100 });
    expect(report.checks.find((item) => item.id === "protocol")).toMatchObject({ status: "pass" });
    expect(report.checks.find((item) => item.id === "response_structure")).toMatchObject({ status: "pass" });
  });

  it("uses adaptive omitted thinking and xhigh effort for Sonnet 5", async () => {
    const requests = [];
    const report = await runModelDetection(
      detectionInput({ model: "claude-sonnet-5", protocol: "anthropic" }),
      dependencies(async (payload) => {
        requests.push(payload);
        return anthropicRelay(payload);
      }),
    );
    expect(requests.map((request) => request.stage)).toEqual(["stage1", "stage2", "stage3", "stage5-calc"]);
    expect(requests.every((request) => request.body.thinking?.type === "adaptive" && request.body.thinking?.display === "omitted")).toBe(true);
    expect(requests.every((request) => request.body.output_config?.effort === "xhigh")).toBe(true);
    expect(requests[3].body.output_config).toMatchObject({ effort: "xhigh", format: { type: "json_schema" } });
    expect(report.profile).toMatchObject({ dedicated: true, probe_family: "claude-standard" });
  });

  it("uses a complete Claude signature envelope for public-formula compatibility without claiming cryptographic verification", async () => {
    const report = await runModelDetection(
      detectionInput(),
      dependencies(async (payload) => anthropicRelay(payload, {
        signatureCryptographicallyVerified: false,
        signatureCompatibilityVerdict: "PARTIAL",
        signatureCompatibilityReason: "complete envelope with channel=1",
        signatureFormulaCompatible: true,
        signatureEnvelopeModel: "claude-fable-5",
        signatureEnvelopeMatchesRequested: true,
        signatureEnvelopeChannelPresent: true,
        signatureEnvelopeChannelValue: 1,
        signatureEnvelopeVersion: 2,
        signatureEnvelopeKeyVersion: 15,
        signatureEnvelopeSchemaVersion: 2,
        signatureEnvelopeVariant: 1,
        signatureEnvelopePayloadType: "thinking",
        signatureEnvelopeSessionId: "34268aed-a2d5-499d-878d-6c858e124808",
        signatureEnvelopeEncryptedPayloadBytes: 53,
        signatureFormat: "claude-thinking-protobuf-v1",
        signatureStructureIssues: [],
        signatureReason: "parsed envelope; cryptographic verdict unavailable",
        signatureStructurallyParsed: true,
      })),
    );

    expect(report.scores).toMatchObject({
      primary: 99,
      quality: 100,
      official_compatibility: 99,
      behavior: 99,
      public_observable: 99,
      private_signature_adjustment: 0,
      private_signature_status: "envelope_compatible",
    });
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({
      status: "warning",
      evidence: {
        verdict: "PARTIAL",
        wire_verdict: "PASS",
        structural_compatibility_verdict: "PARTIAL",
        structural_compatibility_reason: "complete envelope with channel=1",
        structural_formula_compatible: true,
        cryptographically_verified: false,
        envelope_model: "claude-fable-5",
        envelope_model_non_cryptographic: true,
        envelope_model_matches_requested: true,
        envelope_channel_marker_present: true,
        envelope_channel_marker_value: 1,
        envelope_version: 2,
        envelope_key_version: 15,
        envelope_schema_version: 2,
        envelope_variant: 1,
        envelope_payload_type: "thinking",
        envelope_session_id: "34268aed-a2d5-499d-878d-6c858e124808",
        envelope_encrypted_payload_bytes: 53,
        envelope_format: "claude-thinking-protobuf-v1",
        envelope_structure_issues: [],
        envelope_reason: "parsed envelope; cryptographic verdict unavailable",
        envelope_structurally_parsed: true,
        envelope_fields_non_cryptographic: true,
      },
    });
  });

  it("explains that an otherwise perfect Opus 90 is a private-verdict coverage gap", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => anthropicRelay(payload, {
        signatureVerdict: "UNKNOWN",
        signatureCryptographicallyVerified: false,
        sigModelName: null,
        signatureEnvelopeModel: payload.stage === "opus47-sig" ? "claude-opus-4-8" : null,
        signatureDeltaTotalLength: payload.stage === "opus47-sig" ? 1080 : 0,
      })),
    );

    expect(report.scores).toMatchObject({
      primary: 90,
      quality: 100,
      official_compatibility: 90,
      behavior: 90,
      public_observable: 100,
      private_signature_adjustment: -10,
      private_signature_status: "unavailable",
    });
    expect(report.scores.public_observable + report.scores.private_signature_adjustment).toBe(report.scores.primary);
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({
      status: "warning",
      evidence: {
        penalty: 10,
        penalty_reason: "private_signature_verdict_unavailable",
        cryptographically_verified: false,
      },
    });
    expect(report.checks.find((item) => item.id === "signature")?.detail).toContain(
      "10 points are conservatively withheld",
    );
    expect(report.checks.filter((item) => item.status === "fail")).toEqual([]);
  });

  it("uses a complete direct Opus envelope to remove the ten-point private-verdict gap", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => {
        const signatureStage = payload.stage === "opus47-sig";
        return anthropicRelay(payload, {
          signatureVerdict: "UNKNOWN",
          signatureCryptographicallyVerified: false,
          sigModelName: null,
          signatureCompatibilityVerdict: signatureStage ? "PASS" : "UNKNOWN",
          signatureCompatibilityReason: signatureStage ? "complete envelope without channel marker" : null,
          signatureFormulaCompatible: signatureStage,
          signatureEnvelopeModel: signatureStage ? "claude-opus-4-8" : null,
          signatureEnvelopeMatchesRequested: signatureStage,
          signatureEnvelopeChannelPresent: false,
          signatureEnvelopeChannelValue: null,
          signatureFormat: signatureStage ? "claude-thinking-protobuf-v1" : null,
          signatureStructureIssues: [],
          signatureDeltaTotalLength: signatureStage ? 936 : 0,
        });
      }),
    );

    expect(report.scores).toMatchObject({
      primary: 100,
      quality: 100,
      official_compatibility: 100,
      behavior: 100,
      public_observable: 100,
      private_signature_adjustment: 0,
      private_signature_status: "envelope_compatible",
      signature_evidence_status: "envelope_compatible",
    });
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({
      status: "pass",
      evidence: {
        verdict: "PASS",
        structural_compatibility_verdict: "PASS",
        structural_formula_compatible: true,
        cryptographically_verified: false,
        envelope_model: "claude-opus-4-8",
        penalty: 0,
      },
    });
  });

  it("does not cap a direct Opus run when adaptive thinking signs a capability stage", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => {
        const signatureStage = payload.stage === "opus47-sig";
        const capabilitySignatureStage = payload.stage === "opus47-knowledge";
        return anthropicRelay(payload, {
          signatureVerdict: "UNKNOWN",
          signatureCryptographicallyVerified: false,
          sigModelName: null,
          signatureCompatibilityVerdict: signatureStage ? "PASS" : "UNKNOWN",
          signatureCompatibilityReason: signatureStage ? "complete envelope without channel marker" : null,
          signatureFormulaCompatible: signatureStage,
          signatureEnvelopeModel: signatureStage ? "claude-opus-4-8" : null,
          signatureEnvelopeMatchesRequested: signatureStage,
          signatureEnvelopeChannelPresent: false,
          signatureEnvelopeChannelValue: null,
          signatureStructurallyParsed: signatureStage,
          signatureDeltaTotalLength: capabilitySignatureStage ? 1100 : signatureStage ? 936 : 0,
        });
      }),
    );

    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100 });
    expect(report.checks.find((item) => item.id === "stage_identity")).toMatchObject({
      status: "pass",
      evidence: { stage_cap_suppressed_by_direct_envelope: true, public_score_cap: null },
    });
  });

  it("retains a Fable signature envelope diagnostic when its wire verdict is UNKNOWN", async () => {
    const report = await runModelDetection(
      detectionInput(),
      dependencies(async (payload) => anthropicRelay(payload, {
        signatureVerdict: "UNKNOWN",
        signatureCryptographicallyVerified: false,
        signatureEnvelopeModel: payload.stage === "opus47-calc" ? "claude-fable-5" : null,
      })),
    );

    expect(report.scores).toMatchObject({ quality: 100, official_compatibility: 94, behavior: 94 });
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({
      status: "warning",
      evidence: {
        verdict: "UNKNOWN",
        wire_verdict: "UNKNOWN",
        envelope_model: "claude-fable-5",
        envelope_model_non_cryptographic: true,
      },
    });
  });

  it("keeps objective malformed signature data as a public-format failure without crediting an unverified PASS", async () => {
    const report = await runModelDetection(
      detectionInput(),
      dependencies(async (payload) => anthropicRelay(payload, {
        signatureVerdict: "UNKNOWN",
        signatureCryptographicallyVerified: false,
        signatureIsValidBase64: false,
      })),
    );

    expect(report.scores).toMatchObject({ quality: 100, official_compatibility: 84, behavior: 84 });
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({
      status: "fail",
      evidence: { verdict: "FAIL", wire_verdict: "UNKNOWN", objective_format_failure: true, penalty: 16 },
    });
    expect(report.verdict).toMatchObject({ value: "suspicious", evidence_level: "conflict" });
  });

  it("excludes optional status-zero Claude probes from the public formula", async () => {
    const report = await runModelDetection(
      detectionInput(),
      dependencies(async (payload) => {
        if (payload.stage === "opus47-knowledge") return anthropicRelay(payload);
        return {
          ...anthropicRelay(payload),
          status: 0,
          bodyText: JSON.stringify({ error: { message: "internal_probe_timeout" } }),
        };
      }),
    );

    expect(report.status).toBe("completed");
    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100 });
    expect(report.checks.find((item) => item.id === "pdf")).toMatchObject({ status: "warning", evidence: { executed: false, status_code: 0 } });
    expect(report.checks.find((item) => item.id === "calculation")).toMatchObject({ status: "warning", evidence: { executed: false, status_code: 0 } });
    expect(report.checks.find((item) => item.id === "model_feature")).toMatchObject({ status: "warning", evidence: { executed: false, status_code: 0 } });
  });

  it("does not apply a missing-signature penalty when an optional frontier signature request never reached upstream", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => {
        if (payload.stage !== "opus47-sig") return anthropicRelay(payload);
        return {
          ...anthropicRelay(payload),
          status: 0,
          bodyText: JSON.stringify({ error: { message: "internal_probe_timeout" } }),
        };
      }),
    );

    expect(report.status).toBe("completed");
    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100 });
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({
      status: "warning",
      evidence: { executed: false, penalty: 0 },
    });
  });

  it("labels hidden Google response markers as unresolved instead of Vertex", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6", protocol: "openai-chat" }),
      dependencies(async (payload) => openaiRelay(payload, {
        responseHeaders: { "x-goog-request-id": "relay-marker" },
      })),
    );

    expect(report.channel).toMatchObject({
      kind: "google-unknown",
      provider: "google",
      confidence: "low",
      transport_verified: false,
    });
  });

  it("distinguishes a server-fetched live snapshot from model live access", async () => {
    const snapshot = {
      generatedAt: "2026-07-16T05:00:00.000Z",
      sourceDate: "2026-07-16",
      sourceUrl: "https://example.test/live-snapshot",
      snapshotId: "live-snapshot-test",
      cache: { status: "hit", ageSeconds: 42, ttlSeconds: 900 },
      requiredCorrect: 1,
      questions: [{ id: "snapshot-title", prompt: "What is the snapshot title?", expected: "Example title", aliases: ["example title"] }],
    };
    const availableDependencies = dependencies(async (payload) => openaiRelay(payload));
    availableDependencies.getLiveKnowledgeSnapshot = async () => snapshot;
    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6", checks: { cache: false, liveKnowledge: true } }),
      availableDependencies,
    );
    expect(report.live_knowledge).toMatchObject({
      requested: true,
      source_snapshot_fetched: true,
      source_answers_sent_to_model: false,
      source_generated_at: "2026-07-16T05:00:00.000Z",
      source_cache_status: "hit",
      source_cache_age_seconds: 42,
      source_cache_ttl_seconds: 900,
    });

    const failedDependencies = dependencies(async (payload) => openaiRelay(payload));
    failedDependencies.getLiveKnowledgeSnapshot = async () => { throw new Error("snapshot_fetch_failed"); };
    const failed = await runModelDetection(
      detectionInput({ model: "gpt-5.6", checks: { cache: false, liveKnowledge: true } }),
      failedDependencies,
    );
    expect(failed.live_knowledge).toMatchObject({
      requested: true,
      status: "unavailable",
      source_snapshot_fetched: false,
      source_answers_sent_to_model: false,
    });
  });

  it("does not score a negated live title as a correct answer", async () => {
    const snapshot = {
      sourceDate: "2026-07-16",
      sourceUrl: "https://example.test/live-snapshot",
      snapshotId: "live-snapshot-negation-test",
      requiredCorrect: 1,
      questions: [{ id: "snapshot-title", kind: "text", prompt: "What is the featured title?", expected: "Sam Neill", aliases: ["sam neill"] }],
    };
    const liveDependencies = dependencies(async (payload) => {
      const relay = openaiRelay(payload);
      if (payload.stage !== "api-live_knowledge") return relay;
      const body = JSON.parse(relay.bodyText);
      body.choices[0].message.content = "1|not Sam Neill";
      return { ...relay, bodyText: JSON.stringify(body) };
    });
    liveDependencies.getLiveKnowledgeSnapshot = async () => snapshot;

    const report = await runModelDetection(
      detectionInput({ model: "gpt-5.6", checks: { cache: false, liveKnowledge: true } }),
      liveDependencies,
    );

    expect(report.live_knowledge).toMatchObject({ status: "failed", correct: 0 });
    expect(report.live_knowledge.results).toEqual([
      expect.objectContaining({ actual: "not Sam Neill", passed: false, classification: "wrong" }),
    ]);
  });

  it("marks requested live knowledge as skipped when core probes are unavailable", async () => {
    const report = await runModelDetection(
      detectionInput({ checks: { cache: false, liveKnowledge: true } }),
      dependencies(async (payload) => ({
        ...anthropicRelay(payload),
        status: 429,
        bodyText: JSON.stringify({ error: { message: "Too many requests" } }),
      })),
    );

    expect(report.status).toBe("unavailable");
    expect(report.live_knowledge).toMatchObject({
      requested: true,
      status: "skipped",
      reason: "core_unavailable",
      source_snapshot_fetched: false,
      source_answers_sent_to_model: false,
    });
  });

  it("uses the current public frontier Claude request templates", async () => {
    const requests = [];
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => {
        requests.push(payload);
        return anthropicRelay(payload);
      }),
    );

    expect(requestPrompt(requests.find((request) => request.stage === "opus47-knowledge"))).toContain("例如：1|Alaska");
    expect(requestPrompt(requests.find((request) => request.stage === "opus47-knowledge"))).toContain("1. Q:");
    expect(requests.every((request) => request.body.metadata.user_id === OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID)).toBe(true);
    expect(requests.every((request) => Object.entries(OFFICIAL_CLAUDE_PROBE_HEADERS).every(
      ([name, value]) => request.headers[name] === value,
    ))).toBe(true);
    expect(requests[0].body.system).toEqual([
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.165; cc_entrypoint=cli; cch=3f806;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
    ]);
    expect(requestPrompt(requests.find((request) => request.stage === "opus47-pdf-dynamic"))).toBe("What text does this PDF contain? 只给我返回文字,不要使用工具");
    const pdfRequest = requests.find((request) => request.stage === "opus47-pdf-dynamic");
    const pdfData = pdfRequest.body.messages[0].content.find((item) => item.type === "document").source.data;
    expect(Buffer.from(pdfData, "base64")).toHaveLength(497);
    expect(Buffer.from(pdfData, "base64").toString("utf8")).toContain("Hvoy.ai report total ");
    expect(requestPrompt(requests.find((request) => request.stage === "opus47-calc"))).toMatch(/^计算 \d+ 乘以 \d+ 等于多少$/);
    const signatureRequest = requests.find((request) => request.stage === "opus47-sig");
    expect(requestPrompt(signatureRequest)).toMatch(/^把[a-z]{4} sha256 3次\.控制输出在100字以内$/);
    expect(signatureRequest.body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    });
    expect(report.profile.request_fingerprint).toBe("official-public");
    expect(report.warnings).toContain("The current public Claude metadata, system, and Stainless header fingerprint was used to match public probe routing behavior");
    expect(report.warnings).toContain("The public compatibility formula is reconstructed locally, but no complete Claude signature envelope or provider cryptographic verdict was available");
  });

  it("returns full Fable quality while keeping a relay source unverified", async () => {
    const report = await runModelDetection(detectionInput(), dependencies(async (payload) => anthropicRelay(payload)));
    expect(report.status).toBe("completed");
    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100 });
    expect(report.verdict).toMatchObject({ value: "consistent", evidence_level: "behavioral", source_verified: false });
    expect(report.channel).toMatchObject({ kind: "hidden-upstream", transport_verified: false, source_verified: false });
    expect(JSON.stringify(report)).not.toContain("sk-test-only");
  });

  it("matches the public 77 compatibility score for a Bedrock-style Opus response", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => {
        const relay = anthropicRelay(payload, {
          signatureVerdict: "PARTIAL",
          sigModelName: null,
          signatureDeltaTotalLength: payload.stage === "opus47-sig" ? 872 : 0,
          signatureIsValidBase64: true,
          messageId: "msg_bdrk_example1234567890",
          requestCompatibilityFallbacks: ["removed-anthropic-beta"],
        });
        const body = JSON.parse(relay.bodyText);
        body.id = "msg_bdrk_example1234567890";
        if (payload.stage === "opus47-knowledge") body.content[0].text = passingKnowledge(payload.body);
        if (payload.stage === "opus47-calc") {
          return {
            ...relay,
            status: 400,
            bodyText: JSON.stringify({ error: { type: "invalid_request_error", message: "output_config.format: Extra inputs are not permitted" }, type: "error" }),
          };
        }
        return { ...relay, bodyText: JSON.stringify(body) };
      }),
    );

    expect(report.scores).toMatchObject({ primary: 77, quality: 85, official_compatibility: 77, behavior: 77 });
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({ status: "warning", evidence: { penalty: 4 } });
    expect(report.checks.find((item) => item.id === "message_id")).toMatchObject({ status: "fail" });
    expect(report.checks.find((item) => item.id === "request_compatibility")).toMatchObject({ status: "warning" });
    expect(report.warnings).toContain("Anthropic compatibility fallback applied: removed-anthropic-beta");
    expect(report.channel).toMatchObject({ kind: "possible-bedrock", confidence: "low", provider: "bedrock", transport_verified: false });
    expect(report.verdict.source_verified).toBe(false);
  });

  it("reports a parsed Claude channel=1 envelope as an ambiguous Vertex/Bedrock proxy", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => {
        const signatureStage = payload.stage === "opus47-sig";
        return anthropicRelay(payload, {
          signatureVerdict: "UNKNOWN",
          signatureCryptographicallyVerified: false,
          sigModelName: null,
          signatureCompatibilityVerdict: signatureStage ? "PARTIAL" : "UNKNOWN",
          signatureCompatibilityReason: signatureStage ? "complete envelope with channel=1" : null,
          signatureFormulaCompatible: signatureStage,
          signatureEnvelopeModel: signatureStage ? "claude-quince" : null,
          signatureEnvelopeChannelPresent: signatureStage,
          signatureEnvelopeChannelValue: signatureStage ? 1 : null,
          signatureStructurallyParsed: signatureStage,
          signatureDeltaTotalLength: signatureStage ? 1092 : 0,
        });
      }),
    );

    expect(report.scores).toMatchObject({ primary: 96, official_compatibility: 96 });
    expect(report.channel).toMatchObject({
      kind: "possible-vertex-or-bedrock",
      confidence: "low",
      provider: null,
      transport_verified: false,
    });
    expect(report.channel.signals.join(" ")).toContain("channel=1");
  });

  it("keeps transport message IDs diagnostic when the public payload omits id", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => {
        const relay = anthropicRelay(payload, {
          signatureVerdict: "PARTIAL",
          sigModelName: null,
        });
        const body = JSON.parse(relay.bodyText);
        delete body.id;
        return { ...relay, bodyText: JSON.stringify(body) };
      }),
    );
    expect(report.scores).toMatchObject({ primary: 94, quality: 100, official_compatibility: 94, behavior: 94 });
    expect(report.checks.find((item) => item.id === "message_id")).toMatchObject({
      status: "warning",
      evidence: { payload_message_ids: [], transport_message_ids: expect.arrayContaining([expect.stringMatching(/^msg_/)]) },
    });
  });

  it("sends a Fable alias unchanged while using the canonical dedicated profile", async () => {
    const requests = [];
    const report = await runModelDetection(
      detectionInput({ model: "claude-5-fable" }),
      dependencies(async (payload) => {
        requests.push(payload);
        return anthropicRelay(payload);
      }),
    );
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.body.model === "claude-5-fable")).toBe(true);
    expect(report.request).toMatchObject({ model: "claude-5-fable", profile_model: "claude-fable-5", profile_resolution: "auto-alias" });
    expect(report.profile).toMatchObject({ model: "claude-fable-5", probe_family: "claude-fable", dedicated: true });
    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100 });
  });

  it("allows an unknown relay name to use an explicit Fable evaluation profile", async () => {
    const requests = [];
    const report = await runModelDetection(
      detectionInput({ model: "vendor-fable-v9", profileModel: "claude-fable-5", profileResolution: "explicit" }),
      dependencies(async (payload) => {
        requests.push(payload);
        const relay = anthropicRelay(payload);
        const body = JSON.parse(relay.bodyText);
        body.model = "claude-fable-5";
        return { ...relay, streamMessageStartModel: "claude-fable-5", sigModelName: "claude-fable-5", bodyText: JSON.stringify(body) };
      }),
    );
    expect(requests.every((request) => request.body.model === "vendor-fable-v9")).toBe(true);
    expect(report.profile).toMatchObject({ model: "claude-fable-5", dedicated: true, resolution: "explicit" });
    expect(report.checks.find((item) => item.id === "model_identity")?.status).toBe("pass");
    expect(report.scores).toMatchObject({ primary: 100, quality: 100, official_compatibility: 100, behavior: 100 });
  });

  it("infers explicit resolution for a lower-level call that supplies profile_model directly", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "vendor-fable-v9", profileModel: "claude-fable-5" }),
      dependencies(async (payload) => anthropicRelay(payload)),
    );

    expect(report.request).toMatchObject({ profile_model: "claude-fable-5", profile_resolution: "explicit" });
  });

  it("preserves the public custom-ID penalty without treating the echo as a conflicting family", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "vendor-fable-v9", profileModel: "claude-fable-5", profileResolution: "explicit" }),
      dependencies(async (payload) => anthropicRelay(payload)),
    );

    expect(report.scores).toMatchObject({ primary: 70, quality: 100, official_compatibility: 70, behavior: 70 });
    expect(report.checks.find((item) => item.id === "model_identity")).toMatchObject({
      status: "warning",
      evidence: { reported_model: "vendor-fable-v9", scoring_reported_model: "vendor-fable-v9", custom_model_echo: true },
    });
    expect(report.checks.find((item) => item.id === "signature")).toMatchObject({
      status: "fail",
      evidence: { sig_model_name: "vendor-fable-v9", scoring_sig_model_name: "vendor-fable-v9", custom_model_echo: true },
    });
    expect(report.verdict).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });
    expect(report.verdict.reason).toContain("custom model ID");
  });

  it("preserves the public GPT custom-ID penalty without calling the echo substitution", async () => {
    const gpt55 = await runModelDetection(
      detectionInput({ model: "vendor-gpt-v9", profileModel: "gpt-5.5", profileResolution: "explicit", protocol: "openai-chat" }),
      dependencies(async (payload) => openaiRelay(payload)),
    );
    expect(gpt55.scores).toMatchObject({ primary: 64, quality: 100, official_compatibility: 64, official_result: "fail" });
    expect(gpt55.checks.find((item) => item.id === "identity")).toMatchObject({
      status: "warning",
      evidence: { reported_model: "vendor-gpt-v9", scoring_reported_model: "vendor-gpt-v9", custom_model_echo: true },
    });
    expect(gpt55.verdict).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });

    const sol = await runModelDetection(
      detectionInput({ model: "vendor-sol-v9", profileModel: "gpt-5.6-sol", profileResolution: "explicit", protocol: "openai-chat" }),
      dependencies(async (payload) => openaiRelay(payload)),
    );
    expect(sol.scores.official_compatibility).toBe(64);
    expect(sol.verdict).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });
  });

  it("does not turn a partial 400 suite into a low model score", async () => {
    let calls = 0;
    const report = await runModelDetection(detectionInput(), dependencies(async (payload) => {
      calls += 1;
      if (calls === 1) return anthropicRelay(payload);
      return {
        ...anthropicRelay(payload),
        status: 400,
        bodyText: JSON.stringify({ error: { message: "request parameter is not supported" } }),
      };
    }));
    expect(report.status).toBe("completed");
    expect(report.scores.quality).toBeLessThan(100);
    expect(report.scores.behavior).toBeLessThan(100);
    expect(report.rounds[0].incomplete).toBe(false);
    expect(report.checks.find((item) => item.id === "response_integrity")).toMatchObject({ status: "fail" });
  });

  it("returns incomplete with null scores when a later mandatory Claude probe has no upstream response", async () => {
    let calls = 0;
    const report = await runModelDetection(
      detectionInput({ model: "claude-sonnet-5", protocol: "anthropic" }),
      dependencies(async (payload) => {
        calls += 1;
        if (calls === 1) return anthropicRelay(payload);
        return {
          ...anthropicRelay(payload),
          status: 0,
          bodyText: JSON.stringify({ error: { message: "internal_probe_timeout" } }),
        };
      }),
    );

    expect(report.status).toBe("incomplete");
    expect(report.rounds[0]).toMatchObject({ incomplete: true, quality_score: null, behavior_score: null });
    expect(report.scores).toMatchObject({ primary: null, quality: null, official_compatibility: null, behavior: null });
  });

  it("treats a fully rate-limited upstream as unavailable", async () => {
    const report = await runModelDetection(detectionInput(), dependencies(async (payload) => ({
      ...anthropicRelay(payload),
      status: 429,
      bodyText: JSON.stringify({ error: { message: "Too many requests" } }),
    })));
    expect(report.status).toBe("unavailable");
    expect(report.scores).toMatchObject({ primary: null, quality: null, official_compatibility: null, behavior: null });
    expect(report.verdict.value).toBe("unavailable");
    expect(report.checks).toEqual([
      expect.objectContaining({ id: "upstream_unavailable", category: "operational", status: "warning" }),
    ]);
  });

  it("keeps an explicitly requested canonical cache diagnostic independent of a 429 main probe", async () => {
    const stages = [];
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        stages.push(payload.stage);
        return {
          ...anthropicRelay(payload),
          status: 429,
          bodyText: JSON.stringify({ error: { message: "Too many requests" } }),
        };
      }),
    );

    expect(report.status).toBe("unavailable");
    expect(stages).toContain("cachecheck-r0");
    expect(report.cache).toMatchObject({
      requested: true,
      applicable: true,
      status: "failed",
      completed_rounds: 0,
      logical_rounds: 5,
      request_attempts: 2,
      request_profiles_used: ["custom"],
      rounds: [expect.objectContaining({ status: 429, parse_ok: false })],
    });
    expect(report.scores).toMatchObject({ primary: null, quality: null, behavior: null });
  });

  it("returns a requested not-applicable cache report for unsupported profiles without cache requests", async () => {
    const stages = [];
    const report = await runModelDetection(
      detectionInput({
        model: "gpt-5.6",
        protocol: "openai-chat",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        stages.push(payload.stage);
        return openaiRelay(payload);
      }),
    );

    expect(report.status).toBe("completed");
    expect(stages).toEqual(["stage1", "stage2"]);
    expect(report.cache).toEqual(expect.objectContaining({
      requested: true,
      applicable: false,
      status: "not-applicable",
      reason: "model_not_supported",
      rounds: [],
    }));
  });

  it("explains a public stage-identity cap separately from model-family consistency", async () => {
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic" }),
      dependencies(async (payload) => anthropicRelay(payload, {
        signatureDeltaTotalLength: payload.stage === "opus47-knowledge" || payload.stage === "opus47-sig" ? 128 : 0,
      })),
    );
    expect(report.scores).toMatchObject({ primary: 34, quality: 100, official_compatibility: 34, behavior: 34, official_result: "fail" });
    expect(report.checks.find((item) => item.id === "stage_identity")).toMatchObject({
      status: "fail",
      evidence: { main_stage_signature_delta_sum: 128, public_score_cap: 34 },
    });
    expect(report.checks.find((item) => item.id === "model_identity")).toMatchObject({ status: "pass" });
    expect(report.verdict).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });
    expect(report.verdict.reason).toContain("adaptive thinking or upstream routing");
  });

  it("keeps an intermittent multi-round stage fingerprint separate from substitution", async () => {
    let knowledgeRound = 0;
    const report = await runModelDetection(
      detectionInput({ model: "claude-opus-4-8", protocol: "anthropic", rounds: 2 }),
      dependencies(async (payload) => {
        if (payload.stage === "opus47-knowledge") knowledgeRound += 1;
        return anthropicRelay(payload, {
          signatureDeltaTotalLength: payload.stage === "opus47-knowledge" && knowledgeRound === 1 ? 128 : 0,
        });
      }),
    );

    expect(report.rounds.map((round) => round.behavior_score)).toEqual([34, 100]);
    expect(report.scores).toMatchObject({ primary: 67, official_compatibility: 67, official_result: "pass" });
    expect(report.checks.find((item) => item.id === "stage_identity")).toMatchObject({ status: "warning" });
    expect(report.verdict).toMatchObject({ value: "unverifiable", evidence_level: "behavioral" });
  });

  it("labels official transport without claiming cryptographic model provenance", async () => {
    const report = await runModelDetection(
      detectionInput({ baseUrl: "https://api.anthropic.com" }),
      dependencies(async (payload) => anthropicRelay(payload)),
    );
    expect(report.channel).toMatchObject({ provider: "anthropic", transport_verified: true, source_verified: false });
    expect(report.verdict).toMatchObject({ value: "consistent", evidence_level: "provider-transport", source_verified: false });
  });

  it("reports cache round hits separately from token hit rates", async () => {
    let cacheRound = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        const relay = anthropicRelay(payload);
        if (!payload.stage.startsWith("cachecheck-r")) return relay;
        cacheRound += 1;
        return {
          ...relay,
          cacheCreationInputTokens: cacheRound === 1 ? 1000 : 0,
          cacheReadInputTokens: cacheRound === 1 ? 0 : 1000,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }),
    );
    expect(report.cache).toMatchObject({
      status: "confirmed",
      warm_rounds_with_hit_percent: 100,
      mean_warm_token_hit_rate: 99,
      weighted_warm_token_hit_rate: 99,
      total_cache_read_tokens: 4000,
    });
  });

  it("requires complete warm usage coverage before confirming cache behavior or scoring compatibility", async () => {
    let cacheRound = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        const relay = anthropicRelay(payload);
        if (!payload.stage.startsWith("cachecheck-r")) return relay;
        cacheRound += 1;
        if (cacheRound !== 2) return relay;
        return {
          ...relay,
          cacheReadInputTokens: 1000,
          cacheEvidenceFields: ["cache_read_input_tokens"],
        };
      }),
    );

    expect(report.cache).toMatchObject({
      status: "unconfirmed",
      observed_warm_rounds: 1,
      warm_rounds_with_hit_percent: 25,
      average_hit_rate: expect.any(Number),
      comparison_hit_rate: null,
      compatibility_score: null,
      comparison_assumption: null,
    });
  });

  it("marks a complete cache run without any token fields as unmetered", async () => {
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        const relay = anthropicRelay(payload);
        if (!payload.stage.startsWith("cachecheck-r")) return relay;
        const body = JSON.parse(relay.bodyText);
        delete body.usage;
        return {
          ...relay,
          usage: {},
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheEvidenceFields: [],
          bodyText: JSON.stringify(body),
        };
      }),
    );

    expect(report.cache).toMatchObject({
      status: "unobserved",
      metering_observed: false,
      metering_evidence_fields: [],
      cache_evidence_observed: false,
      compatibility_score: null,
      measured_weighted_tokens: null,
      overall_multiplier: null,
      comparison_hit_rate: null,
      comparison_assumption: null,
      total_cache_read_tokens: null,
      total_cache_write_tokens: null,
    });
    expect(report.cache.rounds).toHaveLength(5);
    expect(report.cache.rounds.every((round) =>
      round.metering_observed === false &&
      round.input_tokens === 0 &&
      round.output_tokens === 0 &&
      round.cache_read_tokens === 0 &&
      round.cache_write_tokens === 0 &&
      round.weighted_tokens === null &&
      round.multiplier === null &&
      round.assessment === null
    )).toBe(true);
  });

  it("keeps the four planned warm rounds as the hit-percentage denominator for incomplete runs", async () => {
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        const relay = anthropicRelay(payload);
        if (!payload.stage.startsWith("cachecheck-r")) return relay;
        const round = Number(payload.stage.slice(-1));
        if (round === 2) {
          return {
            ...relay,
            status: 429,
            bodyText: JSON.stringify({ error: { message: "Too many requests" } }),
          };
        }
        return {
          ...relay,
          cacheCreationInputTokens: round === 0 ? 1000 : 0,
          cacheReadInputTokens: round === 1 ? 1000 : 0,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(report.cache).toMatchObject({
      status: "incomplete",
      completed_rounds: 2,
      logical_rounds: 5,
      request_attempts: 4,
      observed_warm_rounds: 1,
      required_warm_rounds: 4,
      warm_rounds_with_hit_percent: 25,
      compatibility_score: null,
    });
  });

  it("uses website cache stage names and retries one transient 5xx per round", async () => {
    const cacheStages = [];
    const attempts = new Map();
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        protocol: "anthropic",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        cacheStages.push(payload.stage);
        const attempt = attempts.get(payload.stage) ?? 0;
        attempts.set(payload.stage, attempt + 1);
        if (payload.stage === "cachecheck-r1" && attempt === 0) {
          return {
            ...anthropicRelay(payload),
            status: 504,
            bodyText: JSON.stringify({ error: { message: "gateway timeout" } }),
          };
        }
        const round = Number(payload.stage.slice(-1));
        return {
          ...anthropicRelay(payload),
          usage: { input_tokens: 10, output_tokens: 5 },
          cacheCreationInputTokens: round === 0 ? 1000 : 0,
          cacheReadInputTokens: round === 0 ? 0 : 1000,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(cacheStages).toEqual([
      "cachecheck-r0",
      "cachecheck-r1",
      "cachecheck-r1",
      "cachecheck-r2",
      "cachecheck-r3",
      "cachecheck-r4",
    ]);
    expect(report.cache).toMatchObject({
      status: "confirmed",
      rounds: expect.any(Array),
      completed_rounds: 5,
      logical_rounds: 5,
      request_attempts: 6,
      request_profiles_used: ["custom"],
      required_warm_rounds: 4,
    });
    expect(report.cache.rounds).toHaveLength(5);
  });

  it("retries one successful HTTP response with an invalid cache payload shape", async () => {
    const attempts = new Map();
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        protocol: "anthropic",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        const attempt = attempts.get(payload.stage) ?? 0;
        attempts.set(payload.stage, attempt + 1);
        if (payload.stage === "cachecheck-r1" && attempt === 0) {
          return {
            ...anthropicRelay(payload),
            usage: {},
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cacheEvidenceFields: [],
            bodyText: "{}",
          };
        }
        const round = Number(payload.stage.slice(-1));
        return {
          ...anthropicRelay(payload),
          usage: { input_tokens: 10, output_tokens: 5 },
          cacheCreationInputTokens: round === 0 ? 1000 : 0,
          cacheReadInputTokens: round === 0 ? 0 : 1000,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(attempts.get("cachecheck-r1")).toBe(2);
    expect(report.cache).toMatchObject({
      status: "confirmed",
      completed_rounds: 5,
      request_attempts: 6,
    });
  });

  it("keeps the upstream reason when a 200 cache error envelope persists", async () => {
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        protocol: "anthropic",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        return {
          ...anthropicRelay(payload),
          usage: {},
          bodyText: JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "cache channel unavailable" },
          }),
        };
      }),
    );

    expect(report.cache).toMatchObject({
      status: "failed",
      completed_rounds: 0,
      request_attempts: 2,
      failure_detail: "cache channel unavailable",
    });
  });

  it("classifies a persistent non-JSON cache response", async () => {
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        protocol: "anthropic",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        return {
          ...anthropicRelay(payload),
          usage: {},
          bodyText: "not-json",
        };
      }),
    );

    expect(report.cache).toMatchObject({
      status: "failed",
      completed_rounds: 0,
      request_attempts: 2,
      failure_detail: "invalid_json_response",
    });
  });

  it("classifies a persistent cache protocol-shape mismatch", async () => {
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        protocol: "anthropic",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        return {
          ...anthropicRelay(payload),
          usage: {},
          bodyText: JSON.stringify({ ok: true }),
        };
      }),
    );

    expect(report.cache).toMatchObject({
      status: "failed",
      completed_rounds: 0,
      request_attempts: 2,
      failure_detail: "invalid_protocol_response",
    });
  });

  it("runs real Fable cache observations without inventing a comparable Fable baseline", async () => {
    const requests = [];
    let cacheRound = 0;
    const report = await runModelDetection(
      detectionInput({ checks: { cache: true, liveKnowledge: false } }),
      dependencies(async (payload) => {
        requests.push(payload);
        const relay = anthropicRelay(payload);
        if (!payload.stage.startsWith("cachecheck-r")) return relay;
        cacheRound += 1;
        return {
          ...relay,
          cacheCreationInputTokens: cacheRound === 1 ? 1000 : 0,
          cacheReadInputTokens: cacheRound === 1 ? 0 : 1000,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(requests.filter((request) => request.stage.startsWith("cachecheck-r"))).toHaveLength(5);
    expect(report.cache).toMatchObject({
      requested: true,
      applicable: true,
      status: "confirmed",
      comparison: "reference-only",
      compatibility_score: null,
      baseline: { model: "claude-opus-4-8", source: "official-alias" },
    });
  });

  it("returns the public Opus 4.8 weighted cache comparison through the API", async () => {
    const cacheInputs = [35, 77, 119, 161, 203];
    const cacheRequests = [];
    let cacheRound = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        const relay = anthropicRelay(payload);
        if (!payload.stage.startsWith("cachecheck-r")) return relay;
        cacheRequests.push(payload);
        const inputTokens = cacheInputs[cacheRound];
        cacheRound += 1;
        return {
          ...relay,
          usage: { input_tokens: inputTokens, output_tokens: 11 },
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheEvidenceFields: [],
        };
      }),
    );
    expect(report.cache).toMatchObject({
      status: "unobserved",
      comparison: "compared",
      compatibility_score: 0,
      reference_weighted_tokens: 10218.3,
      measured_weighted_tokens: 870,
      overall_multiplier: 0.085,
      average_hit_rate: null,
      comparison_hit_rate: 0,
      comparison_assumption: "missing_usage_treated_as_zero",
      request_template_version: "public-cache-custom-2026-06-18-r5",
    });
    expect(cacheRequests).toHaveLength(5);
    expect(cacheRequests[0].headers.authorization).toBe("Bearer sk-test-only");
    expect(cacheRequests[0].headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(cacheRequests[0].body.system)).toHaveLength(493);
    expect(JSON.stringify(cacheRequests[0].body.tools)).toHaveLength(14892);
    expect(JSON.stringify(cacheRequests[0].body)).toHaveLength(15871);
    expect(report.cache.rounds[0]).toMatchObject({
      weighted_tokens: 90,
      multiplier: 0.012,
      assessment: "abnormally-low",
      cache_write_delta_percent: -100,
    });
  });

  it("runs independent five-round cache sequences and aggregates complete runs by median", async () => {
    const baseline = [
      { input: 2, output: 14, cache_creation: 5822, cache_read: 0 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5822 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5867 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5912 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5957 },
    ];
    const scales = [1, 2, 1];
    const markers = [];
    let cacheRequest = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        cacheRuns: 3,
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        const runIndex = Math.floor(cacheRequest / 5);
        const roundIndex = cacheRequest % 5;
        if (roundIndex === 0) {
          const marker = JSON.stringify(payload.body).match(/\[cache_test_run: ([0-9a-z]+)\]/)?.[1];
          markers.push(marker);
        }
        cacheRequest += 1;
        const reference = baseline[roundIndex];
        const scale = scales[runIndex];
        return {
          ...anthropicRelay(payload),
          usage: { input_tokens: reference.input * scale, output_tokens: reference.output * scale },
          cacheCreationInputTokens: reference.cache_creation * scale,
          cacheReadInputTokens: reference.cache_read * scale,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(cacheRequest).toBe(15);
    expect(new Set(markers).size).toBe(3);
    expect(report.request.checks).toMatchObject({ cache: true, cache_runs: 3 });
    expect(report.cache).toMatchObject({
      requested_runs: 3,
      completed_runs: 3,
      aggregation: "median",
      status: "confirmed",
      compatibility_score: 100,
      overall_multiplier: 1,
      request_attempts: 15,
    });
    expect(report.cache.rounds).toHaveLength(5);
    expect(report.cache.runs).toHaveLength(3);
    expect(report.cache.runs.map((run) => run.run)).toEqual([1, 2, 3]);
    expect(report.cache.runs.map((run) => run.compatibility_score)).toEqual([100, 50, 100]);
    expect(report.cache.runs.every((run) => run.rounds.length === 5 && run.logical_rounds === 5)).toBe(true);
  });

  it("marks complete groups with mixed cache evidence as unconfirmed while preserving the median", async () => {
    const baseline = [
      { input: 2, output: 14, cache_creation: 5822, cache_read: 0 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5822 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5867 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5912 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5957 },
    ];
    let cacheRequest = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        cacheRuns: 2,
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        const runIndex = Math.floor(cacheRequest / 5);
        const roundIndex = cacheRequest % 5;
        cacheRequest += 1;
        const reference = baseline[roundIndex];
        return {
          ...anthropicRelay(payload),
          usage: { input_tokens: reference.input, output_tokens: reference.output },
          cacheCreationInputTokens: runIndex === 0 ? reference.cache_creation : 0,
          cacheReadInputTokens: runIndex === 0 ? reference.cache_read : 0,
          cacheEvidenceFields: runIndex === 0
            ? ["cache_creation_input_tokens", "cache_read_input_tokens"]
            : [],
        };
      }),
    );

    expect(report.cache).toMatchObject({
      requested_runs: 2,
      completed_runs: 2,
      aggregation: "median",
      status: "unconfirmed",
      compatibility_score: 50,
      comparison_assumption: "missing_usage_treated_as_zero",
      average_hit_rate: null,
    });
    expect(report.cache.runs.map((run) => run.status)).toEqual(["confirmed", "unobserved"]);
  });

  it("suppresses aggregate token metrics when a complete group returns no metering fields", async () => {
    const baseline = [
      { input: 2, output: 14, cache_creation: 5822, cache_read: 0 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5822 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5867 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5912 },
      { input: 2, output: 14, cache_creation: 45, cache_read: 5957 },
    ];
    let cacheRequest = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        cacheRuns: 2,
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        const runIndex = Math.floor(cacheRequest / 5);
        const roundIndex = cacheRequest % 5;
        cacheRequest += 1;
        const relay = anthropicRelay(payload);
        if (runIndex === 1) {
          const body = JSON.parse(relay.bodyText);
          delete body.usage;
          return {
            ...relay,
            usage: {},
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cacheEvidenceFields: [],
            bodyText: JSON.stringify(body),
          };
        }
        const reference = baseline[roundIndex];
        return {
          ...relay,
          usage: { input_tokens: reference.input, output_tokens: reference.output },
          cacheCreationInputTokens: reference.cache_creation,
          cacheReadInputTokens: reference.cache_read,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(report.cache).toMatchObject({
      requested_runs: 2,
      completed_runs: 2,
      status: "unconfirmed",
      metering_observed: true,
      metering_complete: false,
      compatibility_score: null,
      measured_weighted_tokens: null,
      overall_multiplier: null,
      comparison_hit_rate: null,
      total_cache_read_tokens: null,
      total_cache_write_tokens: null,
    });
    expect(report.cache.runs.map((run) => run.metering_observed)).toEqual([true, false]);
  });

  it("suppresses a single cache run's aggregate measurements when one round omits usage", async () => {
    let cacheRound = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        const relay = anthropicRelay(payload);
        const currentRound = cacheRound;
        cacheRound += 1;
        if (currentRound !== 2) {
          return {
            ...relay,
            usage: { input_tokens: 2, output_tokens: 14 },
            cacheCreationInputTokens: currentRound === 0 ? 5822 : 45,
            cacheReadInputTokens: currentRound === 0 ? 0 : 5822 + (currentRound - 1) * 45,
            cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
          };
        }
        const body = JSON.parse(relay.bodyText);
        delete body.usage;
        return {
          ...relay,
          usage: {},
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheEvidenceFields: [],
          bodyText: JSON.stringify(body),
        };
      }),
    );

    expect(report.cache).toMatchObject({
      completed_rounds: 5,
      metering_observed: true,
      metering_complete: false,
      compatibility_score: null,
      measured_weighted_tokens: null,
      overall_multiplier: null,
      comparison_hit_rate: null,
      total_cache_read_tokens: null,
      total_cache_write_tokens: null,
    });
  });

  it("does not treat a partial usage object as complete token metering", async () => {
    let cacheRound = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        const relay = anthropicRelay(payload);
        const currentRound = cacheRound;
        cacheRound += 1;
        if (currentRound !== 2) return relay;
        const body = JSON.parse(relay.bodyText);
        body.usage = { input_tokens: 2 };
        return {
          ...relay,
          usage: { input_tokens: 2 },
          cacheCreationInputTokens: 45,
          cacheReadInputTokens: 5867,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
          bodyText: JSON.stringify(body),
        };
      }),
    );

    expect(report.cache).toMatchObject({
      metering_observed: true,
      metering_complete: false,
      comparison_assumption: null,
      compatibility_score: null,
      measured_weighted_tokens: null,
      overall_multiplier: null,
    });
    expect(report.cache.rounds[2]).toMatchObject({
      metering_observed: true,
      metering_complete: false,
      input_tokens: 2,
      output_tokens: 0,
      weighted_tokens: null,
      multiplier: null,
      assessment: null,
      input_delta_percent: null,
      output_delta_percent: null,
      cache_write_delta_percent: null,
      cache_read_delta_percent: null,
    });
  });

  it("stops repeated cache validation after an incomplete sequence and suppresses aggregate metrics", async () => {
    let cacheRequest = 0;
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        cacheRuns: 3,
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        cacheRequest += 1;
        if (cacheRequest === 6 || cacheRequest === 7) {
          return {
            ...anthropicRelay(payload),
            status: 429,
            bodyText: JSON.stringify({ error: { message: "Too many requests" } }),
          };
        }
        const round = (cacheRequest - 1) % 5;
        return {
          ...anthropicRelay(payload),
          usage: { input_tokens: 2, output_tokens: 14 },
          cacheCreationInputTokens: round === 0 ? 5822 : 45,
          cacheReadInputTokens: round === 0 ? 0 : 5822 + (round - 1) * 45,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(cacheRequest).toBe(7);
    expect(report.cache).toMatchObject({
      requested_runs: 3,
      completed_runs: 1,
      aggregation: "median",
      status: "incomplete",
      compatibility_score: null,
      average_hit_rate: null,
      overall_multiplier: null,
      request_attempts: 7,
    });
    expect(report.cache.runs).toHaveLength(2);
    expect(report.cache.runs.map((run) => run.status)).toEqual(["confirmed", "failed"]);
  });

  it("switches to the Claude Code request profile and baseline after a custom 4xx", async () => {
    const cacheRequests = [];
    let claudeCodeRound = 0;
    const claudeCodeBaseline = [
      { input: 2, output: 18, cache_creation: 31390, cache_read: 0 },
      { input: 2, output: 18, cache_creation: 303, cache_read: 31390 },
      { input: 2, output: 18, cache_creation: 303, cache_read: 31693 },
      { input: 2, output: 18, cache_creation: 303, cache_read: 31996 },
      { input: 2, output: 18, cache_creation: 303, cache_read: 32299 },
    ];
    const report = await runModelDetection(
      detectionInput({
        model: "claude-opus-4-8",
        checks: { cache: true, liveKnowledge: false },
      }),
      dependencies(async (payload) => {
        if (!payload.stage.startsWith("cachecheck-r")) return anthropicRelay(payload);
        cacheRequests.push(payload);
        if (!payload.headers["x-claude-code-session-id"]) {
          return {
            ...anthropicRelay(payload),
            status: 400,
            bodyText: JSON.stringify({ error: { message: "unsupported request shape" } }),
          };
        }
        const baseline = claudeCodeBaseline[claudeCodeRound++];
        return {
          ...anthropicRelay(payload),
          usage: { input_tokens: baseline.input, output_tokens: baseline.output },
          cacheCreationInputTokens: baseline.cache_creation,
          cacheReadInputTokens: baseline.cache_read,
          cacheEvidenceFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
        };
      }),
    );

    expect(cacheRequests).toHaveLength(6);
    expect(cacheRequests[0].headers["x-claude-code-session-id"]).toBeUndefined();
    expect(cacheRequests[1].headers["x-claude-code-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(cacheRequests[1].body.thinking).toEqual({ type: "adaptive" });
    expect(cacheRequests[1].body.metadata.user_id).toContain(cacheRequests[1].headers["x-claude-code-session-id"]);
    expect(report.cache).toMatchObject({
      request_profile: "claude_code",
      request_template_version: "public-cache-claude-code-2026-05-29-r5",
      comparison: "compared",
      compatibility_score: 100,
      reference_weighted_tokens: 53950.3,
      measured_weighted_tokens: 53950.3,
      overall_multiplier: 1,
      average_hit_rate: 99.1,
      completed_rounds: 5,
      logical_rounds: 5,
      request_attempts: 6,
      request_profiles_used: ["custom", "claude_code"],
      required_warm_rounds: 4,
    });
  });

  it("forwards an abort signal to probes and stops before another core request", async () => {
    const controller = new AbortController();
    const seenSignals = [];
    let calls = 0;
    await expect(runModelDetection(
      detectionInput({ model: "gpt-5.6", protocol: "openai-chat" }),
      {
        ...dependencies(async (payload, options) => {
          calls += 1;
          seenSignals.push(options?.signal);
          controller.abort();
          return openaiRelay(payload);
        }),
        signal: controller.signal,
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    expect(seenSignals).toEqual([controller.signal]);
  });

  it("does not convert a live-knowledge abort into an unavailable report", async () => {
    const liveDependencies = dependencies(async (payload) => {
      if (payload.stage !== "api-live_knowledge") return openaiRelay(payload);
      const error = new Error("client disconnected");
      error.name = "AbortError";
      throw error;
    });
    liveDependencies.getLiveKnowledgeSnapshot = async () => ({
      sourceDate: "2026-07-16",
      sourceUrl: "https://example.test/live-snapshot",
      snapshotId: "live-abort-test",
      requiredCorrect: 1,
      questions: [{ id: "title", kind: "text", prompt: "Title?", expected: "Example title", aliases: ["example title"] }],
    });

    await expect(runModelDetection(
      detectionInput({ model: "gpt-5.6", checks: { cache: false, liveKnowledge: true } }),
      liveDependencies,
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("OpenAPI document", () => {
  it("documents detector and upstream keys as separate credentials", () => {
    const document = createOpenApiDocument("http://127.0.0.1:6722");
    expect(document.info.title).toBe("kk 模型检测 API");
    expect(document.paths["/api/v1/detections"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/api/v1/attachments"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/api/v1/attachments/{attachmentId}"].delete.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components.securitySchemes.webSession).toBeUndefined();
    expect(document.paths["/api/v1/detections"].post.requestBody.required).toBe(true);
    expect(document.paths["/api/v1/detections"].post.responses["415"]).toBeDefined();
    expect(document.components.schemas.DetectionRequest.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ required: ["upstream_api_key"] }),
      expect.objectContaining({ required: ["api_key"] }),
    ]));
    expect(document.components.schemas.DetectionRequest.properties.api_key).toMatchObject({ deprecated: true, writeOnly: true });
    expect(document.components.schemas.ModelPreset.required).toEqual(expect.arrayContaining(["profile_model", "probe_family", "aliases"]));
    expect(document.components.schemas.Check.properties.id.description).toContain("stage_identity");
    expect(document.components.schemas.DetectionReport.required).toContain("score");
    expect(document.components.schemas.DetectionReport.properties.score.description).toContain("Canonical report score");
    expect(document.components.schemas.DetectionReport.properties.scores.required).toContain("primary_basis");
    expect(document.components.schemas.DetectionReport.properties.scores.required).toEqual(expect.arrayContaining([
      "public_observable",
      "private_signature_adjustment",
      "private_signature_status",
      "signature_evidence_status",
    ]));
    expect(document.components.schemas.DetectionReport.properties.scores.properties.private_signature_status.enum).toContain("unavailable");
    expect(document.components.schemas.DetectionReport.properties.scores.properties.signature_evidence_status.enum).toContain("envelope_compatible");
    expect(document.components.schemas.DetectionReport.properties.channel.properties.kind.enum).toContain("google-unknown");
    expect(document.components.schemas.DetectionReport.properties.channel.properties.kind.enum).toContain("possible-vertex-or-bedrock");
    expect(document.components.schemas.CacheReport.properties.status.enum).toContain("unobserved");
    expect(document.components.schemas.CacheReport.properties.request_attempts).toMatchObject({ minimum: 0 });
    expect(document.components.schemas.CacheReport.properties.request_profiles_used.items.enum).toEqual(["custom", "claude_code"]);
    expect(document.components.schemas.CacheReport.properties.required_warm_rounds).toMatchObject({ minimum: 0, maximum: 4 });
    expect(document.components.schemas.CacheReport.properties.observed_warm_rounds).toMatchObject({ minimum: 0, maximum: 4 });
    expect(document.components.schemas.CacheReport.properties.metering_complete.type).toEqual("boolean");
    expect(document.components.schemas.CacheRound.required).toContain("metering_complete");
    expect(document.components.schemas.CacheRound.properties.metering_complete.type).toEqual("boolean");
    expect(document.components.schemas.CacheRound.properties.weighted_tokens.type).toEqual(["number", "null"]);
    expect(document.components.schemas.DetectionRequest.properties.checks.properties.cache_runs).toMatchObject({ minimum: 1, maximum: 3, default: 1 });
    expect(document.components.schemas.CacheReport.properties.aggregation.enum).toEqual(["single", "median"]);
    expect(document.components.schemas.CacheReport.properties.runs.items.$ref).toBe("#/components/schemas/CacheReport");
    expect(document.components.schemas.DetectionReport.properties.live_knowledge.properties.source_answers_sent_to_model.const).toBe(false);
    expect(document.components.schemas.DetectionReport.properties.live_knowledge.properties.source_cache_status.enum).toEqual(["miss", "hit", "stale", null]);
    expect(document.components.schemas.DetectionReport.properties.live_knowledge.properties.status.enum).toContain("skipped");
    expect(document.components.schemas.DetectionReport.properties.live_knowledge.properties.reason.description).toContain("core_unavailable");
    expect(document.components.schemas.DetectionReport.properties.scoring_reference.required).toEqual(expect.arrayContaining(["probeConstantsBundle", "probeConstantsSha256"]));
    expect(document.components.schemas.DetectionReport.properties.profile.properties.request_fingerprint.enum).toEqual(["official-public", "local-generic"]);
    expect(document.paths["/api/v1/attachments"].post.requestBody.content["multipart/form-data"]).toBeDefined();
    expect(document.paths["/api/v1/attachments"].post.responses["201"].content["application/json"].schema.properties.items.items.$ref)
      .toBe("#/components/schemas/UploadedAttachment");
    expect(document.paths["/upload/{filename}"].get.responses["200"].content["application/octet-stream"]).toBeDefined();
    expect(document.components.schemas.UploadedAttachment.properties.url).toBeDefined();
    expect(document.paths["/api/v1/attachments/{attachmentId}"].delete.responses["409"]).toBeDefined();
    expect(document.components.schemas.DetectionRequest.properties.attachments.items.$ref).toBe("#/components/schemas/AttachmentReference");
    expect(document.components.schemas.AttachmentReference.properties.expected_intent.writeOnly).toBe(true);
    expect(document.components.schemas.AttachmentAnalysis.properties.affects_primary_score.const).toBe(false);
    expect(document.paths["/api/v1/installations/report"].post.responses["204"]).toBeDefined();
    expect(document.paths["/api/v1/installations/stats"].get.responses["200"]).toBeDefined();
    expect(document.paths["/api/v1/installations/stream"].get.responses["200"].content["text/event-stream"]).toBeDefined();
  });
});
