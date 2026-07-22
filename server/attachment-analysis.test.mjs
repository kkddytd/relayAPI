import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { analyzeAttachments, isUngroundedAttachmentAnalysis, parseAttachmentAnalysis, verifyExpectedIntent } from "./attachment-analysis.mjs";
import { createAppStorage } from "./storage.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kangkang-analysis-"));
  temporaryDirectories.push(directory);
  return directory;
}

function storeAttachment(storage, { id, name, mediaType, content, ownerScope = "local" }) {
  const directory = path.join(storage.attachmentsDirectory, id);
  const originalDirectory = path.join(directory, "original");
  fs.mkdirSync(path.join(directory, "derived"), { recursive: true });
  fs.mkdirSync(originalDirectory, { recursive: true });
  const storagePath = path.join(originalDirectory, "attachment");
  fs.writeFileSync(storagePath, content);
  storage.createAttachment({
    id,
    ownerScope,
    originalName: name,
    mediaType,
    storagePath,
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    createdAt: new Date().toISOString(),
  });
}

function openAiAnalysisResponse(analysis) {
  return {
    status: 200,
    bodyText: JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(analysis) } }],
    }),
  };
}

function openAiTextResponse(text) {
  return {
    status: 200,
    bodyText: JSON.stringify({
      choices: [{ message: { role: "assistant", content: text } }],
    }),
  };
}

function anthropicAnalysisResponse(analysis) {
  return {
    status: 200,
    bodyText: JSON.stringify({
      id: "msg_attachment_fixture",
      content: [{ type: "text", text: JSON.stringify(analysis) }],
    }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("attachment understanding", () => {
  it("uses the minimal recognition shape and never turns it into a score", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_10000000000000000000000000000001";
    storeAttachment(storage, {
      id,
      name: "sample.json",
      mediaType: "application/json",
      content: Buffer.from('{"kind":"fixture"}', "utf8"),
    });
    try {
      const parsed = parseAttachmentAnalysis(JSON.stringify({
        attachment_received: true,
        attachment_type: "structured_data",
        observation: "Readable JSON text was supplied.",
        confidence: 100,
      }));
      expect(parsed).toMatchObject({
        ok: true,
        analysis: {
          attachment_received: true,
          attachment_type: "structured_data",
          observation: "Readable JSON text was supplied.",
        },
      });
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async () => openAiAnalysisResponse({
          attachment_received: true,
          attachment_type: "structured_data",
          observation: "Readable JSON text was supplied.",
          confidence: 100,
        }),
      });
      expect(report).toMatchObject({
        status: "completed",
        recognition_status: "recognized",
        recognition_total: 1,
        recognized_count: 1,
        scored: false,
        affects_primary_score: false,
      });
      expect(report.items[0]).toMatchObject({
        status: "completed",
        recognition_status: "recognized",
        recognition_reason: "model_returned_grounded_attachment_observation",
      });
    } finally {
      storage.close();
    }
  });

  it("always sends attachment instructions to the model", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_10000000000000000000000000000002";
    storeAttachment(storage, {
      id,
      name: "instruction.txt",
      mediaType: "text/plain",
      content: Buffer.from("model-visible attachment", "utf8"),
    });
    const instruction = "Confirm that the attached text is readable.";
    let probeCalls = 0;
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand", instruction }],
        storage,
        ownerScope: "local",
        probe: async (request) => {
          probeCalls += 1;
          expect(JSON.stringify(request.body)).toContain(instruction);
          return openAiAnalysisResponse({
            attachment_received: true,
            attachment_type: "text",
            observation: "The attachment contains model-visible text.",
          });
        },
      });

      expect(probeCalls).toBe(1);
      expect(report.items[0]).toMatchObject({
        status: "completed",
        recognition_status: "recognized",
        recognition_reason: "model_returned_grounded_attachment_observation",
      });
    } finally {
      storage.close();
    }
  });

  it("accepts legacy JSON while rejecting self-introductions and incomplete objects", () => {
    const valid = {
      observable_content: "Ink painting with a sword",
      extracted_text: "Sword-like calligraphy",
      likely_purpose: "Decorative martial-arts artwork",
      evidence: ["Black ink strokes"],
      alternatives: [],
      confidence: 88,
      limitations: [],
    };
    expect(parseAttachmentAnalysis(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toMatchObject({
      ok: true,
      analysis: valid,
    });
    expect(parseAttachmentAnalysis("I'm Claude, an AI assistant made by Anthropic.")).toMatchObject({
      ok: false,
      analysis: null,
      error: "attachment_invalid_analysis_structure",
    });
    expect(parseAttachmentAnalysis("{}")).toMatchObject({ ok: false, analysis: null });
    expect(parseAttachmentAnalysis(JSON.stringify({ attachment_type: "image", observation: "A picture." }))).toMatchObject({
      ok: false,
      analysis: null,
    });
    expect(parseAttachmentAnalysis("I can help you with that attachment.")).toMatchObject({
      ok: false,
      analysis: null,
    });
    expect(isUngroundedAttachmentAnalysis({
      observable_content: "",
      extracted_text: "",
      likely_purpose: "",
      evidence: [],
      alternatives: [],
      confidence: 0,
      limitations: [],
    })).toBe(true);
    expect(isUngroundedAttachmentAnalysis({
      attachment_received: true,
      attachment_type: "image",
      observation: "I'm Claude, an AI assistant made by Anthropic.",
      evidence: [],
    })).toBe(true);
    expect(isUngroundedAttachmentAnalysis({
      attachment_received: true,
      attachment_type: "image",
      observation: "I'm Claude, an AI assistant made by Anthropic.",
      extracted_text: "I'm Claude, an AI assistant made by Anthropic.",
      evidence: [],
    })).toBe(true);
    expect(isUngroundedAttachmentAnalysis({
      attachment_received: true,
      attachment_type: "unknown",
      observation: "",
      evidence: {},
    })).toBe(true);
    expect(isUngroundedAttachmentAnalysis({
      attachment_received: true,
      attachment_type: "image",
      observation: "",
      evidence: [],
    })).toBe(true);
    expect(isUngroundedAttachmentAnalysis({
      observable_content: "I'm Claude, an AI assistant made by Anthropic.",
      extracted_text: "I'm Claude, an AI assistant made by Anthropic.",
      likely_purpose: "An identity-message screenshot",
      evidence: ["The sentence is visible in the attachment"],
      alternatives: [],
      confidence: 95,
      limitations: [],
    })).toBe(false);
    expect(isUngroundedAttachmentAnalysis({
      attachment_received: true,
      attachment_type: "image",
      observation: "No image was provided.",
      observable_content: "No image was provided.",
      extracted_text: "",
      likely_purpose: "",
      evidence: [],
      alternatives: [],
      confidence: 0,
      limitations: [],
    })).toBe(true);
  });

  it("treats negated evidence as a conflict and normalizes common intent synonyms", () => {
    expect(verifyExpectedIntent("支付失败截图", {
      observable_content: "这不是支付失败截图，而是支付成功页面",
      extracted_text: "",
      likely_purpose: "展示成功付款结果",
      evidence: [],
    })).toMatchObject({ status: "no-match", reason: "negation-conflict" });

    expect(verifyExpectedIntent("用户登录身份认证页面", {
      observable_content: "用户登陆身份认证页面",
      extracted_text: "",
      likely_purpose: "用于账号登录",
      evidence: [],
    })).toMatchObject({ status: "match" });
  });

  it("keeps the expected intent server-side and outside the primary score", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_11111111111111111111111111111111";
    const hiddenExpectedIntent = "hidden payment failure reference 8472";
    storeAttachment(storage, {
      id,
      name: "opaque.payload",
      mediaType: "application/x-private-binary",
      content: Buffer.from([0, 1, 2, 3, 80, 65, 89, 76, 79, 65, 68, 255]),
    });
    const requests = [];
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{
          id,
          mode: "verify",
          instruction: "Explain the observable content and likely purpose",
          expected_intent: hiddenExpectedIntent,
        }],
        storage,
        ownerScope: "local",
        probe: async (request) => {
          requests.push(request);
          return openAiAnalysisResponse({
            observable_content: "An application error record",
            extracted_text: "Payment failed",
            likely_purpose: hiddenExpectedIntent,
            evidence: ["The visible status says Payment failed"],
            alternatives: [],
            confidence: 92,
            limitations: ["Only sampled binary evidence was available"],
          });
        },
      });

      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).not.toContain(hiddenExpectedIntent);
      expect(JSON.stringify(requests[0])).not.toContain("expected_intent");
      expect(JSON.stringify(requests[0])).toContain("First sampled bytes");
      expect(report).toMatchObject({
        requested: true,
        status: "completed",
        scored: false,
        affects_primary_score: false,
        completed: 1,
        total: 1,
      });
      expect(report.items[0]).toMatchObject({
        delivery_mode: "byte-summary",
        verification: { status: "match", matched_ratio: 1 },
      });
    } finally {
      storage.close();
    }
  });

  it("falls back to a byte summary when an upstream rejects native image input", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_22222222222222222222222222222222";
    storeAttachment(storage, {
      id,
      name: "untrusted-image.dat",
      mediaType: "image/png",
      content: Buffer.from("not actually a decoded image; uploads are not inspected", "utf8"),
    });
    const requests = [];
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async (request) => {
          requests.push(request);
          if (requests.length === 1) return { status: 415, bodyText: "{}" };
          return openAiAnalysisResponse({
            observable_content: "A byte-level file summary",
            extracted_text: "not actually a decoded image",
            likely_purpose: "Unknown binary test fixture",
            evidence: ["Printable strings are present"],
            alternatives: [],
            confidence: 60,
            limitations: ["Native image decoding was rejected"],
          });
        },
      });

      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0].body)).toContain("data:image/png;base64,");
      expect(JSON.stringify(requests[1].body)).not.toContain("data:image/png;base64,");
      expect(report.items[0]).toMatchObject({
        status: "completed",
        recognition_status: "not-recognized",
        recognition_reason: "native_visual_payload_unavailable",
        delivery_mode: "byte-summary",
        fallback_from_native: true,
      });
    } finally {
      storage.close();
    }
  });

  it("optimizes only the model-bound copy when an image exceeds common relay limits", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_22222222222222222222222222222223";
    const pixels = randomBytes(1200 * 1200 * 3);
    const original = await sharp(pixels, { raw: { width: 1200, height: 1200, channels: 3 } })
      .tiff({ compression: "none" })
      .toBuffer();
    expect(original.length).toBeGreaterThan(4 * 1024 * 1024);
    storeAttachment(storage, {
      id,
      name: "large-original.tiff",
      mediaType: "image/tiff",
      content: original,
    });
    let transmitted = null;
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async (request) => {
          const imagePart = request.body.messages[1].content.find((part) => part.type === "image_url");
          expect(imagePart.image_url.url.startsWith("data:image/webp;base64,")).toBe(true);
          transmitted = Buffer.from(imagePart.image_url.url.split(",")[1], "base64");
          return openAiAnalysisResponse({
            observable_content: "A complete image",
            extracted_text: "",
            likely_purpose: "Image analysis fixture",
            evidence: ["The image remained available to the model"],
            alternatives: [],
            confidence: 90,
            limitations: [],
          });
        },
      });

      expect(transmitted).not.toBeNull();
      expect(transmitted.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(transmitted.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(fs.readFileSync(storage.getAttachment(id).storage_path)).toEqual(original);
      expect(report.items[0]).toMatchObject({
        status: "completed",
        delivery_mode: "native",
        native_optimized: true,
        transmitted_media_type: "image/webp",
        transmitted_size_bytes: transmitted.length,
      });
    } finally {
      storage.close();
    }
  }, 30_000);

  it("converts nonstandard image formats before sending them as native image input", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_22222222222222222222222222222224";
    const original = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 180, g: 20, b: 40 },
      },
    }).png().toBuffer();
    storeAttachment(storage, {
      id,
      name: "small.avif",
      mediaType: "application/octet-stream",
      content: original,
    });
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async (request) => {
          const imagePart = request.body.messages[1].content.find((part) => part.type === "image_url");
          expect(imagePart.image_url.url.startsWith("data:image/webp;base64,")).toBe(true);
          return openAiAnalysisResponse({
            attachment_received: true,
            attachment_type: "image",
            observation: "A small image was supplied.",
            confidence: 90,
          });
        },
      });

      expect(report.items[0]).toMatchObject({
        status: "completed",
        delivery_mode: "native",
        transmitted_media_type: "image/webp",
        native_optimized: true,
      });
    } finally {
      storage.close();
    }
  });

  it("uses the Vertex Anthropic request version for attachment analysis", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_22222222222222222222222222222225";
    storeAttachment(storage, {
      id,
      name: "vertex-image.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    let request;
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/claude-test:rawPredict",
          upstreamApiKey: "vertex-token",
          model: "claude-test",
          profileModel: null,
          protocol: "anthropic",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async (value) => {
          request = value;
          return anthropicAnalysisResponse({
            attachment_received: true,
            attachment_type: "image",
            observation: "A supplied image was visible.",
            confidence: 90,
          });
        },
      });

      expect(request.body).toMatchObject({ anthropic_version: "vertex-2023-10-16" });
      expect(request.headers.authorization).toBe("Bearer vertex-token");
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(report.items[0]).toMatchObject({ status: "completed", analysis_protocol: "anthropic" });
    } finally {
      storage.close();
    }
  });

  it("retries a non-structured model response with the attachment and only completes after valid JSON", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_23333333333333333333333333333333";
    storeAttachment(storage, {
      id,
      name: "artwork.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    const requests = [];
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async (request) => {
          requests.push(request);
          if (requests.length === 1) return openAiTextResponse("I'm Claude, an AI assistant made by Anthropic.");
          return openAiAnalysisResponse({
            observable_content: "A monochrome ink artwork with a sword",
            extracted_text: "Chinese calligraphy",
            likely_purpose: "Decorative martial-arts artwork",
            evidence: ["A sword and sweeping ink strokes are visible"],
            alternatives: [],
            confidence: 91,
            limitations: [],
          });
        },
      });

      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].body)).toContain("previous response did not contain a valid attachment-analysis JSON object");
      expect(JSON.stringify(requests[1].body)).toContain("data:image/png;base64,");
      expect(report).toMatchObject({ status: "completed", completed: 1, total: 1 });
      expect(report.items[0]).toMatchObject({
        status: "completed",
        delivery_mode: "native",
        format_retry: true,
        analysis: { likely_purpose: "Decorative martial-arts artwork" },
        error: null,
      });
    } finally {
      storage.close();
    }
  });

  it("retries a structured response that incorrectly claims no attachment was supplied", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_25555555555555555555555555555555";
    storeAttachment(storage, {
      id,
      name: "artwork.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    let attempts = 0;
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async () => {
          attempts += 1;
          return openAiAnalysisResponse(attempts === 1 ? {
            observable_content: "No attachment was supplied in this request.",
            extracted_text: "",
            likely_purpose: "",
            evidence: [],
            alternatives: [],
            confidence: 0,
            limitations: [],
          } : {
            observable_content: "A sword rendered in black ink",
            extracted_text: "Chinese calligraphy",
            likely_purpose: "Decorative martial-arts artwork",
            evidence: ["The sword crosses broad ink strokes"],
            alternatives: [],
            confidence: 90,
            limitations: [],
          });
        },
      });

      expect(attempts).toBe(2);
      expect(report.items[0]).toMatchObject({
        status: "completed",
        format_retry: true,
        analysis: { observable_content: "A sword rendered in black ink" },
      });
    } finally {
      storage.close();
    }
  });

  it("uses a configured visual model when the selected model does not receive the native attachment", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_28888888888888888888888888888888";
    storeAttachment(storage, {
      id,
      name: "artwork.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    const requestedModels = [];
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "claude-fable-5",
          profileModel: "claude-fable-5",
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        fallbackModels: ["claude-opus-4-8"],
        storage,
        ownerScope: "local",
        probe: async (request) => {
          requestedModels.push(request.body.model);
          if (request.body.model === "claude-fable-5") {
            return openAiAnalysisResponse({
              observable_content: "No image was provided.",
              extracted_text: "",
              likely_purpose: "",
              evidence: [],
              alternatives: [],
              confidence: 0,
              limitations: [],
            });
          }
          return openAiAnalysisResponse({
            observable_content: "A monochrome ink artwork with a sword",
            extracted_text: "Chinese calligraphy",
            likely_purpose: "Decorative martial-arts artwork",
            evidence: ["A sword crosses the central brush strokes"],
            alternatives: [],
            confidence: 92,
            limitations: [],
          });
        },
      });

      expect(requestedModels).toEqual(["claude-fable-5", "claude-opus-4-8"]);
      expect(report).toMatchObject({ status: "completed", completed: 1, total: 1 });
      expect(report.items[0]).toMatchObject({
        status: "completed",
        requested_model: "claude-fable-5",
        analysis_model: "claude-opus-4-8",
        model_fallback: true,
        model_fallback_reason: "selected_model_did_not_observe_attachment",
        format_retry: false,
        analysis: { likely_purpose: "Decorative martial-arts artwork" },
      });
    } finally {
      storage.close();
    }
  });

  it("switches protocol after repeated visual-route misses and reports every attempt", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_29999999999999999999999999999999";
    storeAttachment(storage, {
      id,
      name: "artwork.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    const requests = [];
    const missing = {
      observable_content: "No image was provided.",
      extracted_text: "",
      likely_purpose: "",
      evidence: [],
      alternatives: [],
      confidence: 0,
      limitations: [],
    };
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "claude-fable-5",
          profileModel: "claude-fable-5",
          protocol: "anthropic",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        fallbackModels: ["claude-opus-4-8"],
        fallbackProtocols: ["openai-chat"],
        fallbackAttempts: 3,
        storage,
        ownerScope: "local",
        probe: async (request) => {
          requests.push({ mode: request.mode, model: request.body.model });
          if (request.mode === "anthropic") return anthropicAnalysisResponse(missing);
          return openAiAnalysisResponse({
            observable_content: "A monochrome ink artwork with a sword",
            extracted_text: "Chinese calligraphy",
            likely_purpose: "Decorative martial-arts artwork",
            evidence: ["A sword crosses the central brush strokes"],
            alternatives: [],
            confidence: 92,
            limitations: [],
          });
        },
      });

      expect(requests).toEqual([
        { mode: "anthropic", model: "claude-fable-5" },
        { mode: "anthropic", model: "claude-opus-4-8" },
        { mode: "anthropic", model: "claude-opus-4-8" },
        { mode: "anthropic", model: "claude-opus-4-8" },
        { mode: "openai-chat", model: "claude-opus-4-8" },
      ]);
      expect(report.items[0]).toMatchObject({
        status: "completed",
        requested_model: "claude-fable-5",
        analysis_model: "claude-opus-4-8",
        requested_protocol: "anthropic",
        analysis_protocol: "openai-chat",
        model_fallback: true,
        protocol_fallback: true,
        protocol_fallback_reason: "visual_route_did_not_observe_attachment",
        analysis_attempts: 5,
        format_retry: true,
        analysis: { observable_content: "A monochrome ink artwork with a sword" },
      });
    } finally {
      storage.close();
    }
  });

  it("rejects a schema-wrapped self-introduction unless the attachment evidence contains it", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const rejectedId = "att_26666666666666666666666666666666";
    const groundedId = "att_27777777777777777777777777777777";
    storeAttachment(storage, {
      id: rejectedId,
      name: "artwork.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    storeAttachment(storage, {
      id: groundedId,
      name: "identity-screenshot.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    const selfIntroduction = {
      observable_content: "I'm Claude, an AI assistant made by Anthropic.",
      extracted_text: "",
      likely_purpose: "",
      evidence: [],
      alternatives: [],
      confidence: 0,
      limitations: [],
    };
    let attempts = 0;
    try {
      const rejected = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id: rejectedId, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async () => {
          attempts += 1;
          return openAiAnalysisResponse(selfIntroduction);
        },
      });

      expect(attempts).toBe(2);
      expect(rejected.items[0]).toMatchObject({
        status: "failed",
        analysis: null,
        format_retry: true,
        error: "attachment_not_observed_by_model",
      });

      const grounded = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id: groundedId, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async () => openAiAnalysisResponse({
          ...selfIntroduction,
          extracted_text: "I'm Claude, an AI assistant made by Anthropic.",
          likely_purpose: "An identity-message screenshot",
          evidence: ["The quoted sentence is visibly rendered in the image"],
          confidence: 95,
        }),
      });

      expect(grounded.items[0]).toMatchObject({
        status: "completed",
        analysis: { extracted_text: "I'm Claude, an AI assistant made by Anthropic." },
        format_retry: false,
      });
    } finally {
      storage.close();
    }
  });

  it("fails cleanly when the model repeats plain text instead of treating it as observed content", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_24444444444444444444444444444444";
    storeAttachment(storage, {
      id,
      name: "artwork.png",
      mediaType: "image/png",
      content: Buffer.from("native-image-test", "utf8"),
    });
    let attempts = 0;
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        probe: async () => {
          attempts += 1;
          return openAiTextResponse("I'm Claude, an AI assistant made by Anthropic.");
        },
      });

      expect(attempts).toBe(2);
      expect(report).toMatchObject({ status: "failed", completed: 0, total: 1 });
      expect(report.items[0]).toMatchObject({
        status: "failed",
        analysis: null,
        format_retry: true,
        error: "attachment_invalid_analysis_structure",
      });
      expect(report.items[0].raw_response).toBe("I'm Claude, an AI assistant made by Anthropic.");
    } finally {
      storage.close();
    }
  });

  it("sends source, structured data, dotfiles, and extensionless text as extracted text", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const fixtures = [
      {
        id: "att_30000000000000000000000000000001",
        name: "worker.py",
        mediaType: "application/octet-stream",
        marker: "PY_SOURCE_MARKER",
        content: "def execute():\n    return 'PY_SOURCE_MARKER'\n",
      },
      {
        id: "att_30000000000000000000000000000002",
        name: "handler.php",
        mediaType: "application/octet-stream",
        marker: "PHP_SOURCE_MARKER",
        content: "<?php function execute() { return 'PHP_SOURCE_MARKER'; }",
      },
      {
        id: "att_30000000000000000000000000000003",
        name: "client.js",
        mediaType: "application/octet-stream",
        marker: "JS_SOURCE_MARKER",
        content: "export const intent = 'JS_SOURCE_MARKER';\n",
      },
      {
        id: "att_30000000000000000000000000000004",
        name: "config.json",
        mediaType: "application/octet-stream",
        marker: "JSON_SOURCE_MARKER",
        content: JSON.stringify({ intent: "JSON_SOURCE_MARKER" }),
      },
      {
        id: "att_30000000000000000000000000000005",
        name: ".env",
        mediaType: "application/octet-stream",
        marker: "DOTENV_SOURCE_MARKER",
        content: "APP_PURPOSE=DOTENV_SOURCE_MARKER\n",
      },
      {
        id: "att_30000000000000000000000000000006",
        name: "entrypoint",
        mediaType: "application/octet-stream",
        marker: "EXTENSIONLESS_SOURCE_MARKER",
        content: "#!/bin/sh\necho EXTENSIONLESS_SOURCE_MARKER\n",
      },
    ];
    for (const fixture of fixtures) {
      storeAttachment(storage, {
        id: fixture.id,
        name: fixture.name,
        mediaType: fixture.mediaType,
        content: Buffer.from(fixture.content, "utf8"),
      });
    }
    const requests = [];
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: fixtures.map(({ id }) => ({ id, mode: "understand" })),
        storage,
        ownerScope: "local",
        probe: async (request) => {
          requests.push(request);
          return openAiAnalysisResponse({
            observable_content: "Source code or structured data",
            extracted_text: "source",
            likely_purpose: "Test fixture",
            evidence: [],
            alternatives: [],
            confidence: 90,
            limitations: [],
          });
        },
      });

      expect(requests).toHaveLength(fixtures.length);
      fixtures.forEach((fixture, index) => {
        expect(JSON.stringify(requests[index].body)).toContain(fixture.marker);
      });
      expect(report.items).toHaveLength(fixtures.length);
      expect(report.items.every((item) => item.delivery_mode === "extracted")).toBe(true);
      expect(report.items.every((item) => item.coverage_percent === 100)).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("renders a PDF preview for OpenAI Chat and reuses it across response repair", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_40000000000000000000000000000001";
    storeAttachment(storage, {
      id,
      name: "report.pdf",
      mediaType: "application/pdf",
      content: Buffer.from("%PDF-1.7 test fixture", "utf8"),
    });
    const preview = await sharp({
      create: {
        width: 240,
        height: 160,
        channels: 3,
        background: { r: 245, g: 245, b: 245 },
      },
    }).webp().toBuffer();
    const requests = [];
    let renderCalls = 0;
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "gpt-test",
          profileModel: null,
          protocol: "openai-chat",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        pdfRenderer: async () => {
          renderCalls += 1;
          return {
            buffer: preview,
            totalPages: 9,
            pageIndexes: [0, 3, 6, 8],
            backend: "graphicsmagick",
          };
        },
        probe: async (request) => {
          requests.push(request);
          const content = request.body.messages[1].content;
          expect(content[0].image_url.url).toMatch(/^data:image\/webp;base64,/);
          expect(content[1].text).toContain("Rendered representative PDF pages 1, 4, 7, 9 of 9");
          if (requests.length === 1) return openAiTextResponse("I can help with the attachment.");
          return openAiAnalysisResponse({
            attachment_received: true,
            attachment_type: "document",
            observation: "Rendered PDF pages are visible.",
            confidence: 95,
          });
        },
      });

      expect(renderCalls).toBe(1);
      expect(requests).toHaveLength(2);
      expect(report.items[0]).toMatchObject({
        status: "completed",
        recognition_status: "recognized",
        delivery_mode: "pdf-preview",
        pdf_preview_generated: true,
        pdf_page_count: 9,
        pdf_preview_pages: [1, 4, 7, 9],
        pdf_preview_backend: "graphicsmagick",
        transmitted_media_type: "image/webp",
        format_retry: true,
      });
    } finally {
      storage.close();
    }
  });

  it("falls back from a rejected native PDF to a rendered image preview", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "analysis-test-key" });
    const id = "att_40000000000000000000000000000002";
    storeAttachment(storage, {
      id,
      name: "native-first.pdf",
      mediaType: "application/pdf",
      content: Buffer.from("%PDF-1.7 native fallback fixture", "utf8"),
    });
    const preview = await sharp({
      create: {
        width: 200,
        height: 120,
        channels: 3,
        background: { r: 250, g: 250, b: 250 },
      },
    }).webp().toBuffer();
    const requests = [];
    let renderCalls = 0;
    try {
      const report = await analyzeAttachments({
        input: {
          baseUrl: "https://api.example.com",
          upstreamApiKey: "upstream-secret",
          model: "claude-test",
          profileModel: null,
          protocol: "anthropic",
        },
        attachmentSpecs: [{ id, mode: "understand" }],
        storage,
        ownerScope: "local",
        pdfRenderer: async () => {
          renderCalls += 1;
          return {
            buffer: preview,
            totalPages: 2,
            pageIndexes: [0, 1],
            backend: "graphicsmagick",
          };
        },
        probe: async (request) => {
          requests.push(request);
          const firstPart = request.body.messages[0].content[0];
          if (requests.length === 1) {
            expect(firstPart.type).toBe("document");
            expect(firstPart.source.media_type).toBe("application/pdf");
            return { status: 415, bodyText: "{}" };
          }
          expect(firstPart.type).toBe("image");
          expect(firstPart.source.media_type).toBe("image/webp");
          return anthropicAnalysisResponse({
            attachment_received: true,
            attachment_type: "document",
            observation: "Two PDF page previews are visible.",
            confidence: 90,
          });
        },
      });

      expect(renderCalls).toBe(1);
      expect(requests).toHaveLength(2);
      expect(report.items[0]).toMatchObject({
        status: "completed",
        delivery_mode: "pdf-preview",
        fallback_from_native: true,
        pdf_preview_generated: true,
        pdf_page_count: 2,
        pdf_preview_pages: [1, 2],
      });
    } finally {
      storage.close();
    }
  });
});
