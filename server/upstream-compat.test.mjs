import { describe, expect, it } from "vitest";
import { nextAnthropicCompatibilityRetry } from "./upstream-compat.mjs";

describe("Anthropic upstream compatibility retries", () => {
  it("preserves the first invalid-beta response by default", () => {
    expect(nextAnthropicCompatibilityRetry({
      status: 400,
      responseBody: "ValidationException: invalid beta flag",
      headers: { "Anthropic-Beta": "effort-2025-11-24", "x-api-key": "secret" },
      body: { model: "claude-opus-4-8" },
    })).toBeNull();
  });

  it("removes the beta header only for an explicitly enabled operational retry", () => {
    const retry = nextAnthropicCompatibilityRetry({
      status: 400,
      responseBody: "ValidationException: invalid beta flag",
      headers: { "Anthropic-Beta": "effort-2025-11-24", "x-api-key": "secret" },
      body: { model: "claude-opus-4-8" },
      allowCompatibilityRetry: true,
    });

    expect(retry).toMatchObject({ reason: "removed-anthropic-beta", body: { model: "claude-opus-4-8" } });
    expect(retry.headers["Anthropic-Beta"]).toBeUndefined();
    expect(retry.headers["x-api-key"]).toBe("secret");
  });

  it("preserves an output_config rejection as scoring evidence", () => {
    expect(nextAnthropicCompatibilityRetry({
      status: 400,
      responseBody: "ValidationException: output_config.format: Extra inputs are not permitted",
      headers: { "x-api-key": "secret" },
      body: { model: "claude-opus-4-8", output_config: { format: { type: "json_schema" } } },
      applied: ["removed-anthropic-beta"],
      allowCompatibilityRetry: true,
    })).toBeNull();
  });

  it("does not retry unrelated validation errors", () => {
    expect(nextAnthropicCompatibilityRetry({
      status: 400,
      responseBody: "ValidationException: invalid model identifier",
      headers: { "anthropic-beta": "effort-2025-11-24" },
      body: { model: "missing-model" },
      allowCompatibilityRetry: true,
    })).toBeNull();
  });
});
