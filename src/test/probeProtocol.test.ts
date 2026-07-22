import { describe, expect, it } from "vitest";
import { modelMatchesRequested, resolveEndpoint } from "@/lib/probeProtocol";

describe("resolveEndpoint", () => {
  it("uses Chat Completions for GPT models in auto mode, matching the official verifier", () => {
    expect(resolveEndpoint("https://api.openai.com", "gpt-5.6-sol")).toEqual({
      endpoint: "https://api.openai.com/v1/chat/completions",
      mode: "openai-chat",
    });
  });

  it("defaults GPT relay endpoints to Chat Completions for compatibility", () => {
    expect(resolveEndpoint("https://relay.example/v1", "gpt-5.6-sol")).toEqual({
      endpoint: "https://relay.example/v1/chat/completions",
      mode: "openai-chat",
    });
  });

  it("uses the selected evaluation profile when a custom model name resembles another provider", () => {
    expect(resolveEndpoint("https://relay.example/v1", "claude-custom-route", "auto", "gpt-5.6-sol")).toEqual({
      endpoint: "https://relay.example/v1/chat/completions",
      mode: "openai-chat",
    });
    expect(resolveEndpoint("https://relay.example/v1", "gpt-custom-route", "auto", "claude-opus-4-8")).toEqual({
      endpoint: "https://relay.example/v1/messages",
      mode: "anthropic",
    });
  });

  it("normalizes a custom bare host like the official verifier", () => {
    expect(resolveEndpoint("api.openai.com", "gpt-5.5")).toEqual({
      endpoint: "https://api.openai.com/v1/chat/completions",
      mode: "openai-chat",
    });
  });

  it("honors explicit protocol selection and normalizes existing paths", () => {
    expect(resolveEndpoint("https://relay.example/v1/chat/completions", "gpt-4.1", "openai-responses")).toEqual({
      endpoint: "https://relay.example/v1/responses",
      mode: "openai-responses",
    });
  });

  it("supports arbitrary custom model IDs on custom OpenAI and Anthropic addresses", () => {
    expect(resolveEndpoint("https://relay.example/v1", "vendor/private-model", "openai-chat")).toEqual({
      endpoint: "https://relay.example/v1/chat/completions",
      mode: "openai-chat",
    });
    expect(resolveEndpoint("https://relay.example/v1", "vendor/private-model", "anthropic")).toEqual({
      endpoint: "https://relay.example/v1/messages",
      mode: "anthropic",
    });
  });

  it("uses an explicit custom protocol even when the model name resembles another family", () => {
    expect(resolveEndpoint("https://relay.example/v1", "claude-private", "openai-responses")).toEqual({
      endpoint: "https://relay.example/v1/responses",
      mode: "openai-responses",
    });
    expect(resolveEndpoint("https://relay.example/v1", "gpt-private", "anthropic")).toEqual({
      endpoint: "https://relay.example/v1/messages",
      mode: "anthropic",
    });
  });

  it("keeps Claude endpoints on Anthropic Messages in auto mode", () => {
    expect(resolveEndpoint("https://api.anthropic.com/v1/messages", "claude-opus-4-6")).toEqual({
      endpoint: "https://api.anthropic.com/v1/messages",
      mode: "anthropic",
    });
  });

  it("routes GPT Image models to the image generations endpoint", () => {
    expect(resolveEndpoint("https://relay.example/v1", "gpt-image-2")).toEqual({
      endpoint: "https://relay.example/v1/images/generations",
      mode: "openai-images",
    });
  });

  it("routes GLM models through the OpenAI-compatible chat protocol", () => {
    expect(resolveEndpoint("https://relay.example", "glm-5.2")).toEqual({
      endpoint: "https://relay.example/v1/chat/completions",
      mode: "openai-chat",
    });
  });

  it("routes Gemini through the native generateContent protocol", () => {
    expect(resolveEndpoint("https://generativelanguage.googleapis.com", "gemini-3.1-pro-preview")).toEqual({
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
      mode: "google-generative",
    });
  });

  it("honors an explicit OpenAI path even when the model name looks like Gemini", () => {
    expect(resolveEndpoint("https://relay.example/v1/chat/completions", "gemini-3.1-pro-preview")).toEqual({
      endpoint: "https://relay.example/v1/chat/completions",
      mode: "openai-chat",
    });
  });

  it("preserves complete Vertex model routes and replaces only the model segment", () => {
    expect(resolveEndpoint(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent?alt=sse",
      "gemini-3.1-pro-preview",
    )).toEqual({
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview:generateContent?alt=sse",
      mode: "google-generative",
    });
  });

  it("does not infer provider protocols from lookalike hostnames and preserves query strings", () => {
    expect(resolveEndpoint("https://api.openai.com.evil.example/v1?key=ignored", "claude-private")).toEqual({
      endpoint: "https://api.openai.com.evil.example/v1/messages?key=ignored",
      mode: "anthropic",
    });
    expect(resolveEndpoint("https://api.openai.com/v1?project=demo", "gpt-5.5")).toEqual({
      endpoint: "https://api.openai.com/v1/chat/completions?project=demo",
      mode: "openai-chat",
    });
  });

  it("builds documented Vertex publisher routes and preserves Anthropic rawPredict", () => {
    expect(resolveEndpoint(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1",
      "gemini-3.1-pro-preview",
      "auto",
    )).toEqual({
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview:generateContent",
      mode: "google-generative",
    });
    expect(resolveEndpoint(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic",
      "vendor-gemini-alias",
      "google-generative",
    )).toEqual({
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/vendor-gemini-alias:generateContent",
      mode: "google-generative",
    });
    expect(resolveEndpoint(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/claude-opus-4-8:rawPredict",
      "claude-opus-4-8",
      "auto",
    )).toEqual({
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/claude-opus-4-8:rawPredict",
      mode: "anthropic",
    });
    expect(resolveEndpoint(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1",
      "vendor-claude-alias",
      "auto",
      "claude-opus-4-8",
    )).toEqual({
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/vendor-claude-alias:rawPredict",
      mode: "anthropic",
    });
    expect(resolveEndpoint(
      "https://generativelanguage.googleapis.com/v1beta",
      "vendor-ai-studio-model",
      "auto",
      "claude-opus-4-8",
    )).toEqual({
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/vendor-ai-studio-model:generateContent",
      mode: "google-generative",
    });
  });
});

describe("modelMatchesRequested", () => {
  it("accepts exact models and dated snapshots without collapsing distinct model variants", () => {
    expect(modelMatchesRequested("gpt-4.1", "gpt-4.1-2025-04-14")).toBe(true);
    expect(modelMatchesRequested("gpt-5.6", "gpt-5.6-sol")).toBe(false);
    expect(modelMatchesRequested("gemini-3.1-pro-preview", "gemini-3.1-pro-preview-2026-06-01")).toBe(true);
    expect(modelMatchesRequested("gemini-3.1-pro-preview", "gemini-3.1-pro-preview-fast")).toBe(false);
    expect(modelMatchesRequested("claude-opus-4-8", "claude-opus-4-8-20250514")).toBe(true);
    expect(modelMatchesRequested("claude-opus-4-6", "claude-opus-4-6[1m]")).toBe(true);
    expect(modelMatchesRequested("claude-opus-4-6", "claude-4-6-opus-fast")).toBe(true);
    expect(modelMatchesRequested("claude-fable-5", "claude-5-fable")).toBe(true);
    expect(modelMatchesRequested("claude-opus-4-7", "claude-opus-4-7-fast")).toBe(true);
    expect(modelMatchesRequested("claude-opus-4-8", "claude-opus-4-8-evil")).toBe(false);
    expect(modelMatchesRequested("claude-opus-4-8", "claude-opus-4-7-20250514")).toBe(false);
    expect(modelMatchesRequested("claude-fable-5", "claude-fable-5-evil")).toBe(false);
    expect(modelMatchesRequested("claude-fable-5", "claude-fable-5-20260714")).toBe(true);
    expect(modelMatchesRequested("claude-fable-5[fast]", "claude-fable-5")).toBe(true);
    expect(modelMatchesRequested("fable5", "claude-fable-5")).toBe(true);
  });

  it("accepts provider version suffixes for GPT and Gemini without accepting another family", () => {
    expect(modelMatchesRequested("gpt-5.5", "gpt-5.5-chat-latest")).toBe(true);
    expect(modelMatchesRequested("gemini-3.1-pro-preview", "gemini-3.1-pro-preview-001")).toBe(true);
    expect(modelMatchesRequested("gemini-3.1-pro-preview", "gemini-2.5-pro")).toBe(false);
  });

  it("rejects substituted model families", () => {
    expect(modelMatchesRequested("gpt-5.6-sol", "gpt-4o-mini")).toBe(false);
  });

  it("accepts a canonical response for an unknown relay alias only when a profile is explicit", () => {
    expect(modelMatchesRequested("vendor-fable-v9", "claude-fable-5", "claude-fable-5")).toBe(true);
    expect(modelMatchesRequested("vendor-fable-v9", "claude-fable-5")).toBe(false);
    expect(modelMatchesRequested("gpt-5.6-sol", "claude-fable-5", "claude-fable-5")).toBe(false);
  });
});
