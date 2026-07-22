import { expect, test, type Page } from "@playwright/test";
import { OFFICIAL_CLAUDE_PROBE_HEADERS, OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID } from "../shared/official-scoring.mjs";

type ProbeEnvelope = {
  stage: string;
  mode: string;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const CLAUDE_KNOWLEDGE_ANSWERS = [
  ["OpenAI model released on August 7, 2025", "GPT-5"],
  ["summit on August 15, 2025", "Anchorage"],
  ["campus event in Utah", "Charlie Kirk"],
  ["Kamchatka Peninsula", "8.8"],
  ["Japan's first female Prime Minister", "Sanae Takaichi"],
  ["which U.S. state", "Alaska"],
  ["Nobel Prize in Literature", "Laszlo Krasznahorkai"],
  ["Nobel Peace Prize", "Corina Machado"],
  ["Shanghai Cooperation Organization", "Tianjin"],
  ["2025年3月4日特朗普", "20%"],
  ["Belizean general election", "People's United Party"],
  ["7.7-magnitude earthquake", "Myanmar"],
  ["creates woolly mice", "Colossal Biosciences"],
  ["genetic testing company filed", "23andMe"],
  ["97th Academy Awards", "Anora"],
  ["Marine Le Pen", "5"],
  ["24th Prime Minister of Canada", "Mark Carney"],
  ["Zelenskyy meet at Sandringham", "King Charles III"],
] as const;

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
] as const;

function createPassingClaudeKnowledge(body: Record<string, unknown>): string {
  const prompt = JSON.stringify(body);
  const ordered = CLAUDE_KNOWLEDGE_ANSWERS
    .map(([needle, answer]) => ({ index: prompt.indexOf(needle), answer }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  return ordered.map((entry, index) => `${index + 1}|${index === 0 ? entry.answer : "不知道"}`).join("\n");
}

function createPassingGptKnowledge(body: Record<string, unknown>): string {
  const prompt = JSON.stringify(body);
  return GPT_KNOWLEDGE_ANSWERS
    .map(([needle, answer]) => ({ index: prompt.indexOf(needle), answer }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((entry, index) => `${index + 1}|${entry.answer}`)
    .join("\n");
}

function extractPdfProbeText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = Array.isArray((message as { content?: unknown }).content)
      ? (message as { content: unknown[] }).content
      : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const source = (block as { source?: { data?: unknown } }).source;
      if (typeof source?.data !== "string") continue;
      const decoded = Buffer.from(source.data, "base64").toString("latin1");
      const match = decoded.match(/Hvoy\.ai report total \d{6}/);
      if (match) return match[0];
    }
  }
  return "PDF text unavailable";
}

const isCacheProbeStage = (stage: string) => /^cachecheck-r[0-4]$/.test(stage);

async function mockProbeRelay(page: Page, records: ProbeEnvelope[], options: { rejectFirstCache?: boolean; retryFirstCache5xx?: boolean; includeCacheEvidence?: boolean; cacheEvidenceByGroup?: boolean[]; cacheNoEvidenceGrowingUsage?: boolean; cacheErrorAfterRound?: number; rateLimitAll?: boolean; errorEnvelopeAll?: boolean; invalidShapeAll?: boolean; cacheErrorEnvelope?: boolean; partialIdentityError?: boolean; rejectTemperature?: boolean; rejectAllRequests?: boolean; passClaudeTasks?: boolean; passGptQuiz?: boolean; passFableBoundary?: boolean; reportedModel?: string; signaturePartial?: boolean; signatureCryptographicallyVerified?: boolean; signatureEnvelopeCompatible?: boolean; signatureEnvelopeChannel?: number; signatureEnvelopeInternalModel?: string; signatureEnvelopeModelByStage?: Record<string, string>; mainStageSignature?: boolean; omitBodyId?: boolean; compatibilityFallbacks?: string[]; bedrockMessageId?: boolean; rejectStructuredOutput?: boolean; failStage?: string; failStageStatus?: number; sensitiveErrorMessage?: string; delayCacheMs?: number } = {}) {
  let cacheRejected = false;
  let cache5xxRetried = false;
  let cacheRound = 0;
  await page.route("**/__probe", async (route) => {
    const envelope = route.request().postDataJSON() as ProbeEnvelope;
    records.push(envelope);
    if (options.delayCacheMs && isCacheProbeStage(envelope.stage)) {
      await new Promise((resolve) => setTimeout(resolve, options.delayCacheMs));
    }
    const model = typeof envelope.body.model === "string" ? envelope.body.model : "";
    const reportedModel = options.reportedModel ?? model;
    if (options.rejectTemperature && Object.hasOwn(envelope.body, "temperature")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: 400,
          bodyText: JSON.stringify({ error: { message: "temperature is deprecated for this model" } }),
        }),
      });
      return;
    }
    if (options.failStage === envelope.stage || options.rejectAllRequests) {
      const status = options.failStage === envelope.stage ? options.failStageStatus ?? 429 : 400;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status,
          bodyText: JSON.stringify({ error: { message: options.sensitiveErrorMessage ?? (status === 429 ? "Too many requests" : "request parameter is not supported") } }),
        }),
      });
      return;
    }
    if (options.rateLimitAll) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: 429,
          bodyText: JSON.stringify({ error: { type: "channel_all_disabled", message: "Too many requests, please try again later" } }),
        }),
      });
      return;
    }
    if (options.errorEnvelopeAll) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: 200,
          bodyText: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "channel returned an error envelope" } }),
        }),
      });
      return;
    }
    if (options.invalidShapeAll) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status: 200, bodyText: JSON.stringify({ model }) }),
      });
      return;
    }
    if (options.partialIdentityError && envelope.stage === "fable5-model-feature") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: 503,
          bodyText: JSON.stringify({ model: "gpt-4o-mini", error: { message: "temporary upstream failure" } }),
        }),
      });
      return;
    }
    if (options.cacheErrorEnvelope && isCacheProbeStage(envelope.stage)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: 200,
          bodyText: JSON.stringify({ type: "error", error: { message: "cache backend returned an invalid payload" } }),
        }),
      });
      return;
    }
    if (isCacheProbeStage(envelope.stage) && options.cacheErrorAfterRound === Number(envelope.stage.slice(-1))) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: 200,
          bodyText: JSON.stringify({ type: "error", error: { message: "partial cache group failed" } }),
        }),
      });
      return;
    }
    if (options.rejectFirstCache && isCacheProbeStage(envelope.stage) && !cacheRejected && !envelope.headers["x-claude-code-session-id"]) {
      cacheRejected = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: 400,
          bodyText: JSON.stringify({ error: { message: "custom cache profile rejected" } }),
        }),
      });
      return;
    }
    if (options.retryFirstCache5xx && isCacheProbeStage(envelope.stage) && !cache5xxRetried) {
      cache5xxRetried = true;
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "temporary cache backend failure",
        }),
      });
      return;
    }
    if (isCacheProbeStage(envelope.stage)) cacheRound += 1;
    const cacheRoundInGroup = Math.max(0, (cacheRound - 1) % 5);
    const cacheEvidenceEnabled = isCacheProbeStage(envelope.stage) &&
      (options.cacheEvidenceByGroup?.[Math.floor((cacheRound - 1) / 5)] ?? options.includeCacheEvidence ?? false);
    const sequence = records.length;
    const anthropicMessageId = options.bedrockMessageId
      ? `msg_bdrk_${String(sequence).padStart(24, "0")}`
      : `msg_${String(sequence).padStart(24, "0")}`;
    const fableRequest = /fable/i.test(model);
    const signatureStage = envelope.stage === "opus47-sig" || envelope.stage === "stage2" ||
      (options.mainStageSignature && envelope.stage === "opus47-knowledge") ||
      (fableRequest && envelope.stage === "opus47-calc");
    const signatureEnvelopeCompatible = Boolean(options.signatureEnvelopeCompatible && signatureStage);
    const signatureEnvelopeChannelPresent = signatureEnvelopeCompatible && options.signatureEnvelopeChannel !== undefined;
    const signatureEnvelopeModel = options.signatureEnvelopeModelByStage?.[envelope.stage] ?? options.signatureEnvelopeInternalModel ?? reportedModel;
    const structuredOutputRejected = Boolean(
      options.rejectStructuredOutput && envelope.mode === "anthropic" && envelope.stage === "opus47-calc",
    );
    const cacheInputTokens = options.cacheNoEvidenceGrowingUsage ? 35 + (cacheRound - 1) * 42 : 2;
    const cacheOutputTokens = options.cacheNoEvidenceGrowingUsage ? 11 : 8;
    let bodyText = "";

    if (envelope.mode === "anthropic") {
      let text = "OK";
      if (envelope.stage === "stage1") {
        text = JSON.stringify({
          reasoning: "unknown",
          coding: "unknown",
          instruction: "unknown",
          chinese: "unknown",
          knowledge: [],
          memory_ack: "READY",
        });
      } else if (envelope.stage === "stage2") {
        text = options.passClaudeTasks ? createPassingClaudeKnowledge(envelope.body) : "0";
      } else if (envelope.stage === "opus47-knowledge") {
        text = options.passClaudeTasks
          ? createPassingClaudeKnowledge(envelope.body)
          : "1|不知道\n2|不知道\n3|不知道\n4|不知道";
      } else if ((envelope.stage === "opus47-pdf-dynamic" || envelope.stage === "stage3") && (options.passClaudeTasks || options.passFableBoundary)) {
        text = extractPdfProbeText(envelope.body);
      } else if (envelope.stage === "opus47-calc" || envelope.stage === "stage5-calc") {
        const prompt = JSON.stringify(envelope.body).match(/(?:Calculate (\d+) times (\d+)|计算 (\d+) 乘以 (\d+))/);
        const a = Number(prompt?.[1] ?? prompt?.[3] ?? 0);
        const b = Number(prompt?.[2] ?? prompt?.[4] ?? 0);
        text = JSON.stringify({ expression: `${a}*${b}`, result: a * b });
      }

      bodyText = JSON.stringify({
        ...(options.omitBodyId ? {} : { id: anthropicMessageId }),
        model: reportedModel,
        role: "assistant",
        content: [{ type: "text", text }],
        stop_reason: envelope.stage === "fable5-model-feature" ? "refusal" : "end_turn",
        usage: {
          input_tokens: isCacheProbeStage(envelope.stage) ? cacheInputTokens : 20,
          output_tokens: isCacheProbeStage(envelope.stage) ? cacheOutputTokens : 8,
        },
      });
    } else if (envelope.mode === "google-generative") {
      bodyText = JSON.stringify({
        modelVersion: reportedModel,
        candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
      });
    } else {
      bodyText = JSON.stringify({
        id: `chatcmpl-${sequence}`,
        model: reportedModel,
        choices: [{ message: { role: "assistant", content: options.passGptQuiz ? createPassingGptKnowledge(envelope.body) : "1|不知道\n2|不知道\n3|不知道\n4|不知道\n5|不知道" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: structuredOutputRejected ? 400 : 200,
        latencyMs: 12,
        firstChunkLatencyMs: 4,
        usage: {},
        cacheHit: false,
        cacheReadInputTokens: cacheEvidenceEnabled
          ? cacheRoundInGroup === 0 ? 0 : 5822 + (cacheRoundInGroup - 1) * 45
          : 0,
        cacheCreationInputTokens: cacheEvidenceEnabled
          ? cacheRoundInGroup === 0 ? 5822 : 45
          : 0,
        cacheEvidenceFields: cacheEvidenceEnabled
          ? ["cache_read_input_tokens", "cache_creation_input_tokens"]
          : [],
        signatureDeltaTotalLength: envelope.mode === "anthropic" && !structuredOutputRejected && signatureStage ? 128 : 0,
        signatureDeltaCount: envelope.mode === "anthropic" && !structuredOutputRejected && signatureStage ? 1 : 0,
        signatureEmptyCount: 0,
        signatureIsValidBase64: envelope.mode === "anthropic" && !structuredOutputRejected ? true : null,
        signatureVerdict: envelope.mode === "anthropic" && !structuredOutputRejected && signatureStage ? options.signaturePartial ? "PARTIAL" : "PASS" : "UNKNOWN",
        signatureCompatibilityVerdict: envelope.mode === "anthropic" && !structuredOutputRejected && signatureEnvelopeCompatible
          ? signatureEnvelopeChannelPresent ? "PARTIAL" : "PASS"
          : "UNKNOWN",
        signatureCompatibilityReason: signatureEnvelopeCompatible
          ? signatureEnvelopeChannelPresent ? `complete envelope with channel=${options.signatureEnvelopeChannel}` : "complete envelope without channel marker"
          : null,
        signatureFormulaCompatible: signatureEnvelopeCompatible,
        sigModelName: envelope.mode === "anthropic" && !structuredOutputRejected && signatureStage && !options.signaturePartial ? reportedModel : null,
        signatureEnvelopeModel: envelope.mode === "anthropic" && !structuredOutputRejected && signatureStage ? signatureEnvelopeModel : null,
        signatureEnvelopeMatchesRequested: envelope.mode === "anthropic" && !structuredOutputRejected && signatureStage && signatureEnvelopeModel === model,
        signatureEnvelopeChannelPresent,
        signatureEnvelopeChannelValue: signatureEnvelopeChannelPresent ? options.signatureEnvelopeChannel : null,
        signatureFormat: signatureEnvelopeCompatible ? "claude-thinking-protobuf-v1" : null,
        signatureStructureIssues: [],
        signatureStructurallyParsed: signatureEnvelopeCompatible,
        signatureCryptographicallyVerified: options.signatureCryptographicallyVerified === true,
        finalUpstreamUrl: envelope.endpoint,
        upstreamRedirected: false,
        messageId: envelope.mode === "anthropic" && !structuredOutputRejected ? anthropicMessageId : null,
        streamMessageStartModel: envelope.mode === "anthropic" && !structuredOutputRejected ? reportedModel : null,
        streamMessageStartInputTokens: envelope.mode === "anthropic" && !structuredOutputRejected ? isCacheProbeStage(envelope.stage) ? cacheInputTokens : 20 : null,
        streamMessageDeltaInputTokensSamples: [],
        streamOutputTokensSamples: envelope.mode === "anthropic" && !structuredOutputRejected ? [isCacheProbeStage(envelope.stage) ? cacheOutputTokens : 8] : [],
        rawSseEventCount: envelope.mode === "anthropic" && !structuredOutputRejected ? 6 : 0,
        sseEventTypes: envelope.mode === "anthropic" && !structuredOutputRejected ? ["message_start", "message_delta", "message_stop"] : [],
        sseContentTypes: envelope.mode === "anthropic" && !structuredOutputRejected
          ? [
              "stage1",
              "stage2",
              "stage3",
              "stage5-calc",
              "opus47-knowledge",
              "opus47-calc",
              "opus47-sig",
            ].includes(envelope.stage) ? ["thinking", "text"] : ["text"]
          : [],
        requestCompatibilityFallbacks: options.compatibilityFallbacks ?? [],
        bodyText: structuredOutputRejected
          ? JSON.stringify({ error: { type: "invalid_request_error", message: "output_config.format: Extra inputs are not permitted" }, type: "error" })
          : bodyText,
      }),
    });
  });
}

async function configure(page: Page, options: { endpoint: string; protocol: string; model?: string; target?: RegExp; apiKey?: string }) {
  await page.goto("/");
  await page.locator('input[name="api-endpoint-url"]').fill(options.endpoint);
  await page.getByText("sk-...", { exact: true }).click();
  await page.locator('input[name="access-token-input"]').fill(options.apiKey ?? "sk-test-browser-only");
  await page.locator("select").selectOption(options.protocol);
  if (options.target) {
    await page.getByRole("button", { name: options.target }).click();
  }
  if (options.model) {
    await page.locator('input[name="custom-model-id"]').fill(options.model);
  }
}

async function runAndWait(page: Page) {
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect(page.getByText("检测结果", { exact: true })).toBeVisible({ timeout: 45_000 });
}

test("detection starts when crypto.randomUUID is unavailable on an insecure LAN origin", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  });
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records);
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "openai-chat",
    model: "vendor/lan-http-model",
    target: /GLM 5.2/,
  });
  await runAndWait(page);

  expect(records.length).toBeGreaterThan(0);
  await expect(page.getByTestId("quality-score")).toBeVisible();
});

test("custom OpenAI address keeps the exact custom model ID", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records);
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "openai-chat",
    model: "vendor/private-model-v9",
    target: /GLM 5.2/,
  });
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual(["stage1", "stage2"]);
  expect(records[0]).toMatchObject({
    mode: "openai-chat",
    endpoint: "https://relay.example/v1/chat/completions",
  });
  expect(records[0].headers.accept).toBe("text/event-stream");
  expect(records[0].body).toMatchObject({
    stream: true,
    max_completion_tokens: 10240,
    stream_options: { include_usage: true },
  });
  expect(records.every((record) => record.body.model === "vendor/private-model-v9")).toBe(true);
  // The mock intentionally fails every deterministic capability item while
  // returning a well-formed protocol response. Quality-only primary scoring
  // must therefore remain 0 instead of being lifted by protocol diagnostics.
  await expect(page.getByTestId("quality-score")).toContainText("0%");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByTestId("authenticity-verdict").getByText("无法验真", { exact: true })).toBeVisible();
  await expect(page.getByTestId("channel-evidence")).toContainText("请求主机: relay.example");
  await expect(page.getByTestId("channel-evidence")).toContainText("最终主机: relay.example");
  await expect(page.getByTestId("channel-evidence")).toContainText("官网渠道状态: 未确认");
});

test("custom Anthropic address uses a full quality suite and keeps the model ID", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records);
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "anthropic",
    model: "vendor/private-claude-v9",
    target: /Haiku 4.5/,
  });
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual(["stage1", "stage2", "stage3", "stage5-calc"]);
  expect(records.every((record) => record.endpoint === "https://relay.example/v1/messages")).toBe(true);
  expect(records.every((record) => record.body.model === "vendor/private-claude-v9")).toBe(true);
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
});

test("Google protocol preserves an explicitly supplied Bearer credential", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records);
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "google-generative",
    model: "vendor-gemini-route",
    target: /Gemini 3.1 Pro/,
    apiKey: "Bearer google-access-token",
  });
  await runAndWait(page);

  expect(records.length).toBeGreaterThan(0);
  expect(records.every((record) => record.headers.authorization === "Bearer google-access-token")).toBe(true);
  expect(records.every((record) => record.headers["x-goog-api-key"] === undefined)).toBe(true);
});

test("recognized claude-5-fable alias auto-selects and runs the Fable profile", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true });
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "auto",
    model: "claude-5-fable",
  });
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual([
    "opus47-knowledge",
    "opus47-pdf-dynamic",
    "opus47-calc",
    "fable5-model-feature",
  ]);
  expect(records.every((record) => record.body.model === "claude-5-fable")).toBe(true);
  await expect(page.getByText(/已识别为 Fable 5 · 专用探针/)).toBeVisible();
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "consistent");
});

test("an unknown relay alias can use the selected Fable profile without a false identity conflict", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true, reportedModel: "claude-fable-5" });
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "auto",
    model: "vendor-fable-v9",
    target: /Fable 5/,
  });
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual([
    "opus47-knowledge",
    "opus47-pdf-dynamic",
    "opus47-calc",
    "fable5-model-feature",
  ]);
  expect(records.every((record) => record.body.model === "vendor-fable-v9")).toBe(true);
  await expect(page.getByText(/未匹配内置别名，评测使用所选档案 Fable 5 · 专用探针/)).toBeVisible();
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "consistent");
  await expect(page.getByText("身份一致性", { exact: true }).locator("..")).toContainText("一致");
});

test("an echoed unknown custom ID is not treated as a non-Claude replacement", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true, reportedModel: "vendor-fable-v9" });
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "auto",
    model: "vendor-fable-v9",
    target: /Fable 5/,
  });
  await runAndWait(page);

  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByTestId("authenticity-verdict")).toContainText("自定义模型名影响兼容分");
  await expect(page.getByTestId("authenticity-verdict")).not.toContainText("发现矛盾，疑似替换");
  await expect(page.getByText("模型一致性", { exact: true }).locator("..")).toContainText("一致");
});

test("Fable 5 sends the four dedicated stages with compatible request settings", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { includeCacheEvidence: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await expect(page.getByRole("checkbox", { name: /启用提示缓存检测/ })).toBeEnabled();
  await expect(page.getByText(/Fable 执行 5 个真实逻辑轮次/)).toBeVisible();
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual([
    "opus47-knowledge",
    "opus47-pdf-dynamic",
    "opus47-calc",
    "fable5-model-feature",
  ]);
  const qualityRecords = records.slice(0, 4);
  expect(records.every((record) => record.body.model === "claude-fable-5")).toBe(true);
  expect(qualityRecords.every((record) => (record.body.thinking as { type?: string; display?: string })?.type === "adaptive")).toBe(true);
  expect(qualityRecords.every((record) => (record.body.thinking as { display?: string })?.display === "omitted")).toBe(true);
  expect(qualityRecords.every((record) => !Object.hasOwn(record.body, "temperature"))).toBe(true);
  expect(qualityRecords.every((record) => (record.body.output_config as { effort?: string })?.effort === "xhigh")).toBe(true);
  expect(qualityRecords.every((record) => (record.body.metadata as { user_id?: string })?.user_id === OFFICIAL_CLAUDE_PROBE_METADATA_USER_ID)).toBe(true);
  expect(qualityRecords.every((record) => Object.entries(OFFICIAL_CLAUDE_PROBE_HEADERS).every(
    ([name, value]) => record.headers[name] === value,
  ))).toBe(true);
  expect(records[1].headers["anthropic-beta"]).not.toContain("pdfs-2024-09-25");
  expect((records[2].body.output_config as { format?: unknown })?.format).toBeUndefined();
  await expect(page.getByTestId("authenticity-verdict")).not.toHaveAttribute("data-verdict", "verified");
});

test("Fable 5 runs real cache observation without inventing an independent baseline score", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { includeCacheEvidence: true, passClaudeTasks: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await runAndWait(page);

  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(5);
  const report = page.getByTestId("cache-report");
  await expect(report).toContainText("5/5");
  await expect(report).toContainText("五轮完成，4/4 预热轮次确认缓存读取");
  await expect(report).toContainText("参考请求档案: claude-opus-4-8");
  await expect(report).toContainText("没有 Fable 独立官网基线");
  await expect(report).not.toContainText("缓存基线贴合度");
  await expect(report).not.toContainText(/\d+\/100/);
  await page.getByRole("button", { name: /PDF 文档识别/ }).click();
  await expect(page.getByText(/kk report total/)).toBeVisible();
  await expect(page.getByText(/Hvoy/i)).toHaveCount(0);
});

test("Fable cache observation is disabled when the selected protocol is not Anthropic", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records);
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "openai-chat" });
  await page.getByRole("button", { name: /Fable 5/ }).click();

  const cacheToggle = page.getByRole("checkbox", { name: /启用提示缓存检测/ });
  await expect(cacheToggle).toBeDisabled();
  await expect(page.getByText(/当前接口协议不是 Anthropic/)).toBeVisible();
});

test("Fable 5 remains testable when an endpoint rejects deprecated temperature", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { rejectTemperature: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  expect(records.slice(0, 4).every((record) => !Object.hasOwn(record.body, "temperature"))).toBe(true);
  await expect(page.getByTestId("authenticity-verdict")).not.toHaveAttribute("data-upstream-state", "unavailable");
});

test("Fable 5 knowledge abstention is scored as a failed knowledge batch", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passFableBoundary: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  await expect(page.getByRole("button", { name: /近期知识边界.*失败/ })).toBeVisible();
  await expect(page.getByTestId("quality-score")).not.toContainText("100%");
  await expect(page.getByTestId("authenticity-verdict")).not.toHaveAttribute("data-verdict", "verified");
});

test("rate-limited upstream is unavailable, not a model substitution", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { rateLimitAll: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-upstream-state", "unavailable");
  await expect(page.getByTestId("authenticity-verdict")).not.toContainText("发现矛盾，疑似替换");
  expect(records.map((record) => record.stage)).toEqual(["opus47-knowledge"]);
  await expect(page.getByTestId("authenticity-verdict").getByText("上游不可用，无法判定", { exact: true })).toBeVisible();
  await expect(page.getByText("质量分（非真伪）", { exact: true })).toHaveCount(0);
  await expect(page.getByText("提示缓存检测", { exact: true })).toHaveCount(0);
  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(0);
  await expect.poll(async () => page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("api-verifier-history-v1") || "[]");
    const entry = history[0] || {};
    return {
      score: entry.score,
      hasLatency: Object.hasOwn(entry, "latency"),
      hasTokens: Object.hasOwn(entry, "inputTokens") || Object.hasOwn(entry, "outputTokens"),
    };
  })).toEqual({ score: null, hasLatency: false, hasTokens: false });
});

test("a failed required probe makes a partially successful run unscored", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true, failStage: "stage2", failStageStatus: 429 });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Sonnet 4.6/ }).click();
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual(["stage1", "stage2"]);
  await expect(page.getByTestId("quality-score")).toContainText("—");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
});

test("a failed probe model field is not used as identity evidence", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { partialIdentityError: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByTestId("authenticity-verdict")).not.toContainText("发现矛盾，疑似替换");
});

test("HTTP 200 error envelopes are unavailable, not low-quality model evidence", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { errorEnvelopeAll: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-upstream-state", "unavailable");
  await expect(page.getByText(/上游拒绝检测请求，无法判定/).first()).toBeVisible();
  await expect(page.getByText("提示缓存检测", { exact: true })).toHaveCount(0);
  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(0);
});

test("HTTP 200 JSON without the selected protocol shape is unavailable", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { invalidShapeAll: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-upstream-state", "unavailable");
  await expect(page.getByText(/上游拒绝检测请求，无法判定/).first()).toBeVisible();
});

test("a rejected probe renders one concise diagnostic instead of a failed scorecard", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { rejectAllRequests: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual(["opus47-knowledge"]);
  const diagnostic = page.getByTestId("authenticity-verdict");
  await expect(diagnostic).toHaveAttribute("data-upstream-state", "unavailable");
  await expect(diagnostic).toContainText("HTTP 状态");
  await expect(diagnostic).toContainText("400");
  await expect(diagnostic).toContainText("request parameter is not supported");
  await expect(page.getByText("质量分（非真伪）", { exact: true })).toHaveCount(0);
  await expect(page.getByText("模型实时访问能力", { exact: true })).toHaveCount(0);
  await expect(page.getByText("检测完成", { exact: true })).toHaveCount(0);
});

test("upstream diagnostics redact the current key and non-sk provider credentials", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  const sensitiveMessage = "bad sk-test-browser-only ark-secretCredential123 0123456789abcdef0123456789abcdef.ZhipuSecret123";
  await mockProbeRelay(page, records, { rejectAllRequests: true, sensitiveErrorMessage: sensitiveMessage });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await runAndWait(page);

  const diagnostic = page.getByTestId("authenticity-verdict");
  await expect(diagnostic).toContainText("[redacted-key]");
  await expect(diagnostic).not.toContainText("sk-test-browser-only");
  await expect(diagnostic).not.toContainText("ark-secretCredential123");
  await expect(diagnostic).not.toContainText("ZhipuSecret123");
});

test("cache probing falls back to the Claude Code request profile after a non-rate-limit 4xx", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { rejectFirstCache: true, passClaudeTasks: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await runAndWait(page);

  const cacheRecords = records.filter((record) => isCacheProbeStage(record.stage));
  expect(cacheRecords).toHaveLength(6);
  expect(cacheRecords[0].headers.authorization).toBe("Bearer sk-test-browser-only");
  expect(cacheRecords[0].headers["x-api-key"]).toBeUndefined();
  expect(cacheRecords[0].headers["x-claude-code-session-id"]).toBeUndefined();
  expect(cacheRecords[1].headers.authorization).toMatch(/^Bearer /);
  expect(cacheRecords[1].headers["x-api-key"]).toBeUndefined();
  expect(cacheRecords[1].headers["x-claude-code-session-id"]).toBeTruthy();
  expect(cacheRecords[1].body.thinking).toEqual({ type: "adaptive" });
  const customMarker = JSON.stringify(cacheRecords[0].body).match(/\[cache_test_run: (\d{17}[0-9a-z]{3})\]/)?.[1];
  const fallbackMarker = JSON.stringify(cacheRecords[1].body).match(/\[cache_test_run: (\d{17}[0-9a-z]{3})\]/)?.[1];
  expect(customMarker).toBeTruthy();
  expect(fallbackMarker).toBeTruthy();
  expect(fallbackMarker).not.toBe(customMarker);
  await expect(page.getByText(/请求档案: claude_code/)).toBeVisible();
});

test("an unavailable main run still shows the independently requested cache report", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { rateLimitAll: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await runAndWait(page);

  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-upstream-state", "unavailable");
  await expect(page.getByTestId("cache-report")).toBeVisible();
  await expect(page.getByTestId("cache-report")).toContainText("0/5");
  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(2);
});

test("cancelling a detection stops cache retries and later logical rounds", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true, includeCacheEvidence: true, delayCacheMs: 2_000 });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Fable 5/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await page.getByRole("button", { name: "开始检测" }).click();
  await expect.poll(() => records.filter((record) => isCacheProbeStage(record.stage)).length).toBe(1);

  await page.getByRole("button", { name: "取消检测" }).click();
  await expect(page.getByRole("button", { name: "开始检测" })).toBeVisible();
  await page.waitForTimeout(2_300);
  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(1);
});

test("cache probing retries one transient 5xx within the same official round", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { retryFirstCache5xx: true, passClaudeTasks: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await runAndWait(page);

  expect(records.filter((record) => isCacheProbeStage(record.stage)).map((record) => record.stage)).toEqual([
    "cachecheck-r0",
    "cachecheck-r0",
    "cachecheck-r1",
    "cachecheck-r2",
    "cachecheck-r3",
    "cachecheck-r4",
  ]);
  const cacheRecords = records.filter((record) => isCacheProbeStage(record.stage));
  const system = cacheRecords[0].body.system as Array<{ text?: string }>;
  expect((system[0]?.text?.match(/\[cachecheck mode\]/g) ?? [])).toHaveLength(2);
  expect(JSON.stringify(cacheRecords[0].body.system)).toHaveLength(493);
  expect(JSON.stringify(cacheRecords[0].body)).toHaveLength(15_871);
  expect(cacheRecords.every((record) => record.timeoutMs === 45_000 && record.preferredProtocolFlavor === "anthropic_direct")).toBe(true);
  await expect(page.getByTestId("cache-report")).toBeVisible();
  await expect(page.getByText(/缓存检测请求失败/)).toHaveCount(0);
});

test("cache probing stops after a 200 error envelope", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { cacheErrorEnvelope: true, passClaudeTasks: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await runAndWait(page);

  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(2);
  await expect(page.getByText(/缓存检测请求失败/).first()).toBeVisible();
  await expect(page.getByTestId("cache-report")).toContainText("0/5");
});

test("Opus 4.8 cache report matches the public weighted-token formula", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true, cacheNoEvidenceGrowingUsage: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await runAndWait(page);

  const report = page.getByTestId("cache-report");
  await expect(report).toContainText("0/100");
  await expect(report).toContainText("10.22k");
  await expect(report).toContainText("870");
  await expect(report).toContainText("0.09x");
  await expect(report).toContainText("0%");
  await expect(report).toContainText("上游未返回缓存 token 字段");
  await report.getByText("检测详情", { exact: true }).click();
  await expect(report).toContainText("异常偏低");
});

test("mixed completed cache groups are shown as unstable instead of confirmed", async ({ page }) => {
  test.setTimeout(60_000);
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    cacheEvidenceByGroup: [true, false],
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await page.getByLabel("独立验证组数", { exact: true }).selectOption("2");
  await runAndWait(page);

  const report = page.getByTestId("cache-report");
  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(10);
  await expect(report).toContainText("已完成验证组: 2/2");
  await expect(report).toContainText("实际请求次数: 10");
  await expect(report).toContainText("多组缓存证据未稳定");
  await expect(report.getByTestId("cache-multi-run-unconfirmed")).toContainText("至少一组没有持续返回四个预热轮次");
  await expect(report).toContainText("顶部五轮明细为代表组");
});

test("a partial cache group stops later validation groups and keeps its diagnostic", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    includeCacheEvidence: true,
    cacheErrorAfterRound: 1,
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page.getByRole("checkbox", { name: /启用提示缓存检测/ }).check();
  await page.getByLabel("独立验证组数", { exact: true }).selectOption("3");
  await runAndWait(page);

  const report = page.getByTestId("cache-report");
  expect(records.filter((record) => isCacheProbeStage(record.stage))).toHaveLength(3);
  await expect(report).toContainText("已完成验证组: 0/3");
  await expect(report.getByTestId("cache-multi-run-warning")).toBeVisible();
  await report.getByText("第 1 组", { exact: true }).click();
  await expect(report).toContainText("partial cache group failed");
});

test("supported GPT 5.6 variants use the public quiz while unsupported GPT profiles stay quality-only", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passGptQuiz: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "openai-chat" });
  await page.getByRole("button", { name: /GPT 5.6 Sol/ }).click();
  await runAndWait(page);
  expect(records.map((record) => record.stage)).toEqual(["gpt-quiz"]);
  expect(records[0].body).toMatchObject({ model: "gpt-5.6-sol", max_completion_tokens: 10240, stream: true });
  await expect(page.getByTestId("quality-score")).toContainText("100%");
  await expect(page.getByTestId("quality-score")).toContainText("主评测分");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "consistent");

  records.length = 0;
  await page.getByRole("button", { name: "GPT 5.6 OpenAI 仅质量" }).click();
  await runAndWait(page);
  expect(records.map((record) => record.stage)).toEqual(["stage1", "stage2"]);
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByText("仅质量与兼容性检测", { exact: true })).toBeVisible();
});

test("a custom GPT echo keeps the public score without becoming substitution evidence", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passGptQuiz: true, reportedModel: "vendor-gpt-v9" });
  await configure(page, {
    endpoint: "https://relay.example/v1",
    protocol: "openai-chat",
    model: "vendor-gpt-v9",
    target: /GPT 5.5/,
  });
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("64%");
  await expect(page.getByTestId("behavior-score")).toHaveCount(0);
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByTestId("authenticity-verdict")).toContainText("自定义模型名影响兼容分");
  await expect(page.getByTestId("authenticity-verdict")).not.toContainText("发现矛盾，疑似替换");
});

test("an unexpected Gemini minimal-variant error returns an unscored incomplete result", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { failStage: "gemini-minimal", failStageStatus: 400 });
  await configure(page, {
    endpoint: "https://generativelanguage.googleapis.com",
    protocol: "google-generative",
    target: /Gemini 3.1 Pro/,
  });
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual(["gemini-medium", "gemini-minimal"]);
  await expect(page.getByTestId("quality-score")).toContainText("—");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByText(/HTTP 400/)).toHaveCount(0);
});

test("Sonnet 5 uses the current adaptive-omitted xhigh profile", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Sonnet 5/ }).click();
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual(["stage1", "stage2", "stage3", "stage5-calc"]);
  expect(records.every((record) => (record.body.thinking as { type?: string; display?: string })?.type === "adaptive")).toBe(true);
  expect(records.every((record) => (record.body.thinking as { display?: string })?.display === "omitted")).toBe(true);
  expect(records.every((record) => (record.body.output_config as { effort?: string })?.effort === "xhigh")).toBe(true);
  expect(records[3].body.output_config).toMatchObject({ effort: "xhigh", format: { type: "json_schema" } });
  // A relay-provided PASS without cryptographic verification is normalized to
  // UNKNOWN, so it receives no private-signature credit and remains a warning.
  await expect(page.getByTestId("quality-score")).toContainText("90%");
  await expect(page.getByTestId("score-breakdown")).toContainText(
    "公开可观测项 100% - 私有签名证据缺口 10 = 主分 90%",
  );
  await expect(page.getByRole("button", { name: /签名信封兼容性.*protobuf 签名信封兼容性/ })).toBeVisible();
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "consistent");
});

test("Sonnet 5 uses a complete stage signature envelope for the public score", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    signatureEnvelopeCompatible: true,
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Sonnet 5/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("100%");
  await expect(page.getByRole("button", { name: /签名信封兼容性.*protobuf 签名信封兼容性/ })).toBeVisible();
  await expect(page.getByTestId("authenticity-verdict")).not.toHaveAttribute("data-verdict", "verified");
});

test("Opus 4.8 uses a complete direct signature envelope without claiming cryptographic identity", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    signatureEnvelopeCompatible: true,
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("100%");
  await expect(page.getByRole("button", { name: /签名信封兼容性.*protobuf 签名信封兼容性/ })).toBeVisible();
  await expect(page.getByTestId("authenticity-verdict")).not.toHaveAttribute("data-verdict", "verified");
});

test("Opus 4.8 applies a channel-marked PARTIAL envelope without treating it as identity proof", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    signatureEnvelopeCompatible: true,
    signatureEnvelopeChannel: 1,
    signatureEnvelopeInternalModel: "claude-quince",
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await runAndWait(page);

  expect(records.map((record) => record.stage)).toEqual([
    "opus47-knowledge",
    "opus47-pdf-dynamic",
    "opus47-calc",
    "opus47-sig",
  ]);
  expect(records[2].body.output_config).toMatchObject({
    format: { type: "json_schema" },
  });
  // A channel-marked protobuf envelope retains the public four-point penalty,
  // but does not make a hidden relay cryptographically attributable.
  await expect(page.getByTestId("quality-score")).toContainText("96%");
  await expect(page.getByTestId("quality-score")).toContainText("主评测分");
  await expect(page.getByTestId("behavior-score")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /签名信封兼容性.*部分合格/ })).toBeVisible();
  await expect(page.getByText("疑似 Vertex / Bedrock 代理", { exact: true })).toBeVisible();
  await expect(page.getByTestId("authenticity-verdict")).not.toHaveAttribute("data-verdict", "verified");
});

test("an Opus profile with a complete Sonnet envelope is reported as a structural conflict", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    signatureEnvelopeCompatible: true,
    signatureEnvelopeInternalModel: "claude-sonnet-5",
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("34%");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "suspicious");
  await expect(page.getByRole("button", { name: /签名信封兼容性.*失败/ })).toBeVisible();
});

test("an Opus stage-fingerprint cap is not labeled as model substitution", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true, mainStageSignature: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("34%");
  await expect(page.getByTestId("behavior-score")).toHaveCount(0);
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "unverifiable");
  await expect(page.getByTestId("authenticity-verdict")).toContainText("阶段指纹异常，建议复测");
  await expect(page.getByTestId("authenticity-verdict")).not.toContainText("发现矛盾，疑似替换");
});

test("a direct profile signature suppresses the unstable frontier stage cap", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    mainStageSignature: true,
    signatureEnvelopeCompatible: true,
    signatureEnvelopeModelByStage: {
      "opus47-knowledge": "claude-sonnet-5",
      "opus47-sig": "claude-opus-4-8",
    },
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("100%");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "consistent");
  await expect(page.getByTestId("authenticity-verdict")).not.toContainText("阶段指纹异常，建议复测");
  await expect(page.getByTestId("authenticity-verdict")).not.toContainText("发现矛盾，疑似替换");
});

test("Opus 4.8 applies the public 77 formula to generic Bedrock-style evidence", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, {
    passClaudeTasks: true,
    signatureEnvelopeCompatible: true,
    signatureEnvelopeChannel: 1,
    signatureEnvelopeInternalModel: "claude-quince",
    compatibilityFallbacks: ["removed-anthropic-beta"],
    bedrockMessageId: true,
    rejectStructuredOutput: true,
  });
  await configure(page, { endpoint: "https://bedrock-relay.example", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("77%");
  await expect(page.getByTestId("quality-score")).toContainText("主评测分");
  await expect(page.getByTestId("behavior-score")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /PDF 文档识别.*通过/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /签名信封兼容性.*部分合格/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /结构化输出.*失败/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /协议一致性.*部分匹配/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /消息 ID 格式.*不一致/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /请求兼容模式.*已移除上游不支持/ })).toBeVisible();
  await expect(page.getByText("AWS Bedrock", { exact: true })).toBeVisible();
  await expect(page.getByTestId("authenticity-verdict")).not.toHaveAttribute("data-verdict", "verified");
});

test("standard Claude scoring uses the current thinking and family checks", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Sonnet 4.6/ }).click();
  await runAndWait(page);

  expect(records.slice(0, 4).map((record) => record.stage)).toEqual(["stage1", "stage2", "stage3", "stage5-calc"]);
  await expect(page.getByTestId("quality-score")).toContainText("90%");
  await expect(page.getByTestId("authenticity-verdict")).toHaveAttribute("data-verdict", "consistent");
});

test("an optional probe with no upstream response is omitted instead of lowering the score", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true, failStage: "stage3", failStageStatus: 0 });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Sonnet 4.6/ }).click();
  await runAndWait(page);

  expect(records.slice(0, 4).map((record) => record.stage)).toEqual(["stage1", "stage2", "stage3", "stage5-calc"]);
  await expect(page.getByTestId("quality-score")).toContainText("90%");
  await expect(page.getByRole("button", { name: /PDF 文档识别.*部分匹配/ })).toBeVisible();
});

test("single-score Claude result stays clear without mobile overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { passClaudeTasks: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "anthropic" });
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await runAndWait(page);

  await expect(page.getByTestId("quality-score")).toContainText("主评测分");
  await expect(page.getByTestId("behavior-score")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /PDF 文档识别.*通过/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /结构化输出.*通过/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("custom controls remain usable without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator('input[name="api-endpoint-url"]')).toBeVisible();
  await expect(page.locator('input[name="custom-model-id"]')).toBeVisible();
  await expect(page.locator("select")).toBeVisible();

  const layout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
});

test("history strips API keys from endpoint query strings while requests keep them", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records);
  await configure(page, {
    endpoint: "https://relay.example/v1?key=sk-query-secret",
    protocol: "openai-chat",
    model: "vendor/private-model-v9",
  });
  await runAndWait(page);

  expect(records[0]?.endpoint).toContain("?key=sk-query-secret");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("api-verifier-history-v1") || "[]"));
  expect(stored[0]?.endpoint).toBe("https://relay.example/v1");
  expect(JSON.stringify(stored)).not.toContain("sk-query-secret");
});

test("live knowledge check stays separate from the fixed quality score", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records);
  await page.route("**/__live-knowledge", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        schemaVersion: 2,
        snapshotId: "wikimedia-test-2026",
        generatedAt: "2026-07-14T00:00:00.000Z",
        sourceDate: "2026-07-14",
        sourceName: "Wikimedia featured feed (English)",
        sourceUrl: "https://example.invalid/live",
        sourceRevision: "test",
        requiredCorrect: 3,
        cache: { status: "hit", ageSeconds: 2, ttlSeconds: 900 },
        questions: [
          { id: "one", prompt: "What title?", kind: "text", expected: "OK", aliases: ["OK"], sourcePath: "test" },
          { id: "two", prompt: "What title?", kind: "text", expected: "OK", aliases: ["OK"], sourcePath: "test" },
          { id: "three", prompt: "What title?", kind: "text", expected: "OK", aliases: ["OK"], sourcePath: "test" },
          { id: "four", prompt: "What year?", kind: "number", expected: "2016", aliases: ["2016"], sourcePath: "test" },
        ],
      }),
    });
  });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "openai-chat", model: "vendor/private-model-v9" });
  await page.getByLabel("启用 2026 实时知识检测").check();
  await runAndWait(page);

  expect(records.at(-1)?.stage).toBe("live-knowledge");
  await expect(page.getByTestId("live-knowledge-report")).toBeVisible();
  await expect(page.getByTestId("live-knowledge-report")).toContainText("2026-07-14");
  await expect(page.getByTestId("live-knowledge-report")).toContainText("hit");
  await expect(page.getByTestId("live-knowledge-report")).toContainText("模型未提供实时数据");
});

test("live knowledge explains when core probes are unavailable", async ({ page }) => {
  const records: ProbeEnvelope[] = [];
  await mockProbeRelay(page, records, { rateLimitAll: true });
  await configure(page, { endpoint: "https://relay.example/v1", protocol: "openai-chat", model: "vendor/private-model-v9" });
  await page.getByLabel("启用 2026 实时知识检测").check();
  await runAndWait(page);

  await expect(page.getByTestId("live-knowledge-report")).toBeVisible();
  await expect(page.getByTestId("live-knowledge-report")).toContainText("核心探针不可用，已跳过实时知识请求");
  expect(records.some((record) => record.stage === "live-knowledge")).toBe(false);
});

test("probe relay rejects a JSON null request cleanly", async ({ request }) => {
  const response = await request.post("/__probe", {
    headers: { "content-type": "application/json" },
    data: "null",
  });
  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ ok: false, error: "invalid_request" });
});
