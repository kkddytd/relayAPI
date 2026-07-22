import { describe, expect, it } from "vitest";
import { resolveEndpoint } from "../src/lib/probeProtocol.ts";
import { resolveDetectionEndpoint } from "./detection-api.mjs";

describe("browser and API endpoint parity", () => {
  const cases = [
    ["https://relay.example/v1", "claude-custom", "auto", "gpt-5.6-sol"],
    ["https://relay.example/v1/responses?trace=1", "gpt-5.5", "auto", "gpt-5.5"],
    ["https://openrouter.ai/api/v1", "private-model", "auto", "claude-opus-4-8"],
    ["https://generativelanguage.googleapis.com/v1beta", "gemini-3.1-pro-preview", "auto", "gemini-3.1-pro-preview"],
    ["https://generativelanguage.googleapis.com/v1beta", "vendor-ai-studio-model", "auto", "claude-opus-4-8"],
    ["https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1", "gemini-3.1-pro-preview", "auto", "gemini-3.1-pro-preview"],
    ["https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1", "vendor-claude-alias", "auto", "claude-opus-4-8"],
    ["https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic", "claude-opus-4-8", "anthropic", "claude-opus-4-8"],
    ["https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic", "vendor-gemini-alias", "google-generative", "gemini-3.1-pro-preview"],
    ["https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/old:streamRawPredict?alt=sse", "claude-opus-4-8", "auto", "claude-opus-4-8"],
    ["https://relay.example/v1", "custom-image-route", "auto", "gpt-image-2"],
  ];

  it.each(cases)("resolves %s with the same model and route", (baseUrl, model, protocol, profileModel) => {
    const browser = resolveEndpoint(baseUrl, model, protocol, profileModel);
    expect(resolveDetectionEndpoint(baseUrl, model, protocol, profileModel)).toEqual({
      protocol: browser.mode,
      endpoint: browser.endpoint,
    });
  });
});
