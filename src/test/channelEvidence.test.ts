import { describe, expect, it } from "vitest";
import { detectChannelEvidence } from "@/lib/channelEvidence";

const base = {
  mode: "anthropic" as const,
  statuses: [200],
  responseHeaders: [],
  payloads: [],
};

describe("channel evidence", () => {
  it("recognizes direct Bedrock and Vertex hosts with high confidence", () => {
    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      finalUrls: ["https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude/messages"],
    })).toMatchObject({ kind: "aws-bedrock", confidence: "high", direct: true });

    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://us-central1-aiplatform.googleapis.com",
      finalUrls: ["https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict"],
    })).toMatchObject({ kind: "google-vertex", confidence: "high", direct: true });

    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://bedrock-runtime.cn-north-1.amazonaws.com.cn",
      finalUrls: ["https://bedrock-runtime.cn-north-1.amazonaws.com.cn/model/demo/converse"],
    })).toMatchObject({ kind: "aws-bedrock", confidence: "high", direct: true });
  });

  it("does not call an unauthorized official host a confirmed channel", () => {
    expect(detectChannelEvidence({
      ...base,
      statuses: [401],
      requestedUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      finalUrls: ["https://bedrock-runtime.us-east-1.amazonaws.com/model/demo/converse"],
    })).toMatchObject({ kind: "aws-bedrock", confidence: "medium", direct: false });
  });

  it("does not confirm an official host from a 200 error envelope", () => {
    expect(detectChannelEvidence({
      ...base,
      parseOk: [false],
      requestedUrl: "https://api.anthropic.com",
      finalUrls: ["https://api.anthropic.com/v1/messages"],
    })).toMatchObject({ kind: "anthropic-direct", confidence: "medium", direct: false });
  });

  it("does not call mixed final hosts an official direct channel", () => {
    const evidence = detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: [
        "https://api.anthropic.com/v1/messages",
        "https://relay.example.com/v1/messages",
      ],
    });
    expect(evidence).toMatchObject({ kind: "relay-or-unknown", confidence: "none", direct: false });
  });

  it("does not treat a relay redirecting to an official host as direct proof", () => {
    const evidence = detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: ["https://api.anthropic.com/v1/messages"],
    });
    expect(evidence).toMatchObject({ kind: "anthropic-direct", confidence: "medium", direct: false });
    expect(evidence.signals.join(" ")).toContain("requested relay path");
  });

  it("does not claim to identify a hidden relay channel", () => {
    const evidence = detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: ["https://relay.example.com/v1/messages"],
    });
    expect(evidence).toMatchObject({
      kind: "relay-or-unknown",
      confidence: "none",
      direct: false,
    });
    expect(evidence.signals).toContain("requested host is not an official provider hostname");
  });

  it("uses native provider markers only as medium evidence when the host is hidden", () => {
    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: ["https://relay.example.com/v1/messages"],
      responseHeaders: [{ "x-amzn-bedrock-trace": "abc" }],
    })).toMatchObject({ kind: "aws-bedrock", confidence: "medium", direct: false });

    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: ["https://relay.example.com/v1beta/models/demo:generateContent"],
      payloads: [{
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 12 },
      }],
    })).toMatchObject({ kind: "google-unknown", confidence: "low", direct: false });
  });

  it("does not mistake a generic AWS request id for Bedrock evidence", () => {
    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: ["https://relay.example.com/v1/messages"],
      responseHeaders: [{ "x-amzn-requestid": "generic-aws-request" }],
    })).toMatchObject({ kind: "relay-or-unknown", confidence: "none", direct: false });
  });

  it("treats msg_bdrk_ as low-confidence Bedrock evidence behind a relay", () => {
    const evidence = detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: ["https://relay.example.com/v1/messages"],
      messageIds: ["msg_bdrk_example1234567890"],
    });
    expect(evidence).toMatchObject({ kind: "aws-bedrock", confidence: "low", direct: false });
    expect(evidence.signals.join(" ")).toContain("forgeable");
  });

  it("reports a parsed Claude channel=1 marker as an ambiguous Vertex/Bedrock proxy", () => {
    const evidence = detectChannelEvidence({
      ...base,
      requestedUrl: "https://relay.example.com",
      finalUrls: ["https://relay.example.com/v1/messages"],
      signatureChannelMarkers: [{ present: true, value: 1, structurallyParsed: true }],
    });
    expect(evidence).toMatchObject({
      kind: "vertex-or-bedrock-proxy",
      confidence: "low",
      direct: false,
    });
    expect(evidence.signals.join(" ")).toContain("channel=1");
  });

  it("does not let a channel=1 marker confirm an otherwise official direct path", () => {
    const evidence = detectChannelEvidence({
      ...base,
      requestedUrl: "https://api.anthropic.com",
      finalUrls: ["https://api.anthropic.com/v1/messages"],
      signatureChannelMarkers: [{ present: true, value: 1, structurallyParsed: true }],
    });
    expect(evidence).toMatchObject({ kind: "anthropic-direct", confidence: "medium", direct: false });
    expect(evidence.signals.join(" ")).toContain("channel=1");
  });

  it("keeps Kiro markers explicitly low-confidence", () => {
    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://kiro-gateway.example.com",
      finalUrls: ["https://kiro-gateway.example.com/v1/messages"],
    })).toMatchObject({ kind: "kiro-like", confidence: "low", direct: false });

    expect(detectChannelEvidence({
      ...base,
      requestedUrl: "https://q.us-east-1.amazonaws.com",
      finalUrls: ["https://q.us-east-1.amazonaws.com/assistant"],
    })).toMatchObject({ kind: "kiro-like", confidence: "low", direct: false });
  });
});
