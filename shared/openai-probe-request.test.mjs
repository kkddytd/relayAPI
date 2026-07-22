import { describe, expect, it } from "vitest";
import {
  buildOpenAiChatProbeBody,
  buildOpenAiResponsesProbeBody,
} from "./openai-probe-request.mjs";

describe("shared OpenAI probe requests", () => {
  it("uses the Responses message-array shape and low reasoning effort", () => {
    const messages = [{ role: "user", content: "test" }];
    expect(buildOpenAiResponsesProbeBody({ model: "gpt-5.6-sol", messages })).toEqual({
      model: "gpt-5.6-sol",
      input: messages,
      max_output_tokens: 10240,
      reasoning: { effort: "low" },
      store: false,
    });
  });

  it("keeps chat sampling fields compatible with reasoning and non-reasoning models", () => {
    const messages = [{ role: "user", content: "test" }];
    expect(buildOpenAiChatProbeBody({ model: "gpt-4.1", messages })).toMatchObject({ temperature: 0 });
    expect(buildOpenAiChatProbeBody({ model: "o4-mini", messages })).not.toHaveProperty("temperature");
  });
});
