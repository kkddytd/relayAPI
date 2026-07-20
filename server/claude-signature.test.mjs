import { describe, expect, it } from "vitest";
import { inspectClaudeSignatureEnvelope } from "./claude-signature.mjs";
import { claudeSignaturePenalty } from "../shared/official-scoring.mjs";

// Captured from trivial multiplication/hash probes. These opaque fixtures
// contain no API key or plaintext thinking and exercise the provider's actual
// protobuf wire layout rather than only the synthetic shape builder below.
const REAL_DIRECT_FABLE_SIGNATURE =
  "CAIS+QEKiAEIDxgCKkCRVFyOkgz1GYeiLwyB30JsNRGckd0FG+IU08mb8eE4Zr3PkQVv5+MdOk5vHoiDUIFAuRP4lK1ZbXDv8zXX3QdAMg5jbGF1ZGUtZmFibGUtNTgBQgh0aGlua2luZ1okMzQyNjhhZWQtYTJkNS00OTlkLTg3OGQtNmM4NThlMTI0ODA4Egy9XnoDVp4eoxAkjP0aDMMMHT+clns+v52GCiIwUa7D2hyBolKL1XcNtfLN5MWlPlen04qB379OvzPi8Q2x5MWGE/iIDFHGmfuwYB/gKh57oXL6Ye8kpd7CbognxwOlI6k9BJhRFsDu5SOd2JMYAQ==";
const REAL_CHANNEL_ONE_OPUS_SIGNATURE =
  "Eo8HCmMIDxABGAIqQDa2u01kSgkDwIMbSV769hAixJleqlckDLAIcu8xqtof/mQDJSAsYL7sewNKV6xn3yoPlYwP8UvwMdOFpTBHBN0yDWNsYXVkZS1xdWluY2U4AEIIdGhpbmtpbmcSDI7EEfdWDon83iyP/RoMDGKdjMasROqC5tcUIjA646DAp6kwYuc93682oTZaexvwCNI6Kgv+pK4Dq5UcrjqU8FuXx2XqI8M2vbfOyBUq2QUIbZmxZyj2TaiK2AcfEr+S4r1/mqWpaNH/Qj5igwuAqTA2/DxKmUZRY73ft31VOmE38GxWJcD6FCVKFj8wbTJSghaVMSUusXw7NzcesxDsxp1qORb14n0jmEU0rn9M9nxGHdSVugtp6GFXiDj+YgB7FUDHxKnMDsf+zSV8G3dxReVXY2RbMaq/K7RXNQRtRNd4QDCj6f0hNj9x23971AMhq5Vv0at5OlWSCotROConWXAUOY74OCojLSvtFTiJiJzwzYt0+0f3At0IKghn2oHJbx6PkZRi2FFrfY8DX2j1gUi0RReM1WwlDVt8UNSFukMF4USeeW/N+CcpfcZ5G5pz/FVd1Fii6DIJY4ihppMfZkahGnleF4Xz1OAIrClZe2Xbf3+SZgSrU6OABSEOYdSRFleTELj248Pea+tvRvPriz4HIFZZJC++ZAQ65dK7E5K6cDIw6zxWYs8sBaFhjRRoZ0XHzLHB1zXsSq75xAPs8VOc6fNa50UQElSkRgGdLqK3it3wGgUMT7r3lg+4iSuLuPbnP+tPyTHOo38c9pSuLBbmcIPPJICH6BbF0A1D45+y8djBc7PAZ9oGgf9dgEOt1gX0WfDkqnqvACtejGOHqcsDMICZ3eV+Ya2KNGdn7ZUv2CNxV2PVNtLva8jH7OVCi5rbKR2ZxtJYn/it8saw5CcOO++KjZYL3zjk1thpuyizlEf6NMISKPU05x4nZ51k6oNX60xIDA9Usb6EbjVfsHfsg4DyEFjhtryI8X/hLJ1lVUyVJVVs02XSgKwKOiOGQdfWyYpx6qhHJ5pGolCsc4R/AEkrCdu5LlIWPRuY4vu8oDpTacQkQqi6SSRJZRDkFKgbwiGcE3oYaTyw3acTQ5QuJZgqTOAGSGC3SnHiN7dX08cnWztzZvCA1AXeii9bDxbZvD4OF8HIE2Kto+lgwNKDI9xOUT4a0EgLjdErqSeXVhf8PyOxXZsYAQ==";

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function uintField(fieldNumber, value) {
  return Buffer.concat([varint(fieldNumber << 3), varint(value)]);
}

function bytesField(fieldNumber, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "ascii");
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(buffer.length), buffer]);
}

function capturedShape({
  model,
  channel,
  channelAsBytes = false,
  duplicateChannel = false,
  outerVersion,
  keyVersion = 15,
  schemaVersion = 2,
  variant,
  encryptedPayloadBytes,
  sessionId,
}) {
  const metadata = Buffer.concat([
    uintField(1, keyVersion),
    ...(channel === undefined
      ? []
      : channelAsBytes
        ? [bytesField(2, Buffer.from([channel]))]
        : duplicateChannel
          ? [uintField(2, channel), uintField(2, channel)]
          : [uintField(2, channel)]),
    uintField(3, schemaVersion),
    bytesField(5, Buffer.alloc(64, 0xa5)),
    bytesField(6, model),
    uintField(7, variant),
    bytesField(8, "thinking"),
    ...(sessionId ? [bytesField(11, sessionId)] : []),
  ]);
  const envelope = Buffer.concat([
    bytesField(1, metadata),
    bytesField(2, Buffer.alloc(12, 0x11)),
    bytesField(3, Buffer.alloc(12, 0x22)),
    bytesField(4, Buffer.alloc(48, 0x33)),
    bytesField(5, Buffer.alloc(encryptedPayloadBytes, 0x44)),
  ]);
  return Buffer.concat([
    ...(outerVersion === undefined ? [] : [uintField(1, outerVersion)]),
    bytesField(2, envelope),
    uintField(3, 1),
  ]).toString("base64url");
}

describe("Claude signature envelope inspection", () => {
  it("parses a real direct Fable signature fixture as unverified structure", () => {
    expect(inspectClaudeSignatureEnvelope({
      signature: REAL_DIRECT_FABLE_SIGNATURE,
      requestedModel: "claude-fable-5",
    })).toMatchObject({
      signatureIsValidBase64: true,
      signatureVerdict: "UNKNOWN",
      signatureCompatibilityVerdict: "PASS",
      signatureFormulaCompatible: true,
      sigModelName: null,
      signatureEnvelopeModel: "claude-fable-5",
      signatureEnvelopeMatchesRequested: true,
      signatureEnvelopeChannelPresent: false,
      signatureEnvelopeVersion: 2,
      signatureEnvelopeKeyVersion: 15,
      signatureEnvelopeSchemaVersion: 2,
      signatureEnvelopeVariant: 1,
      signatureEnvelopePayloadType: "thinking",
      signatureFormat: "claude-thinking-protobuf-v1",
      signatureStructurallyParsed: true,
    });
  });

  it("parses a real channel=1 Opus signature fixture as unverified structure", () => {
    expect(inspectClaudeSignatureEnvelope({
      signature: REAL_CHANNEL_ONE_OPUS_SIGNATURE,
      requestedModel: "claude-opus-4-8",
    })).toMatchObject({
      signatureIsValidBase64: true,
      signatureVerdict: "UNKNOWN",
      signatureCompatibilityVerdict: "PARTIAL",
      signatureFormulaCompatible: true,
      sigModelName: null,
      signatureEnvelopeModel: "claude-quince",
      signatureEnvelopeMatchesRequested: false,
      signatureEnvelopeChannelPresent: true,
      signatureEnvelopeChannelValue: 1,
      signatureEnvelopeVersion: 0,
      signatureEnvelopeKeyVersion: 15,
      signatureEnvelopeSchemaVersion: 2,
      signatureEnvelopeVariant: 0,
      signatureEnvelopePayloadType: "thinking",
      signatureFormat: "claude-thinking-protobuf-v1",
      signatureStructurallyParsed: true,
    });
  });

  it("parses the captured direct/Fable protobuf shape without claiming verification", () => {
    const result = inspectClaudeSignatureEnvelope({
      signature: capturedShape({
        model: "claude-fable-5",
        outerVersion: 2,
        variant: 1,
        encryptedPayloadBytes: 53,
        sessionId: "34268aed-a2d5-499d-878d-6c858e124808",
      }),
      requestedModel: "claude-fable-5",
    });
    expect(result).toMatchObject({
      signatureIsValidBase64: true,
      signatureVerdict: "UNKNOWN",
      signatureCompatibilityVerdict: "PASS",
      signatureFormulaCompatible: true,
      sigModelName: null,
      signatureEnvelopeModel: "claude-fable-5",
      signatureEnvelopeMatchesRequested: true,
      signatureEnvelopeChannelPresent: false,
      signatureEnvelopeChannelValue: null,
      signatureEnvelopeVersion: 2,
      signatureEnvelopeKeyVersion: 15,
      signatureEnvelopeSchemaVersion: 2,
      signatureEnvelopeVariant: 1,
      signatureEnvelopePayloadType: "thinking",
      signatureEnvelopeSessionId: "34268aed-a2d5-499d-878d-6c858e124808",
      signatureEnvelopeEncryptedPayloadBytes: 53,
      signatureFormat: "claude-thinking-protobuf-v1",
      signatureStructureIssues: [],
      signatureStructurallyParsed: true,
    });
    expect(claudeSignaturePenalty({
      verdict: result.signatureVerdict,
      sigModelName: result.sigModelName,
      expectedFamily: "fable-5",
    })).toBe(6);
  });

  it("parses the captured channel-marker/internal-model protobuf shape", () => {
    expect(inspectClaudeSignatureEnvelope({
      signature: capturedShape({
        model: "claude-quince",
        channel: 1,
        variant: 0,
        encryptedPayloadBytes: 889,
      }),
      requestedModel: "claude-opus-4-8",
    })).toMatchObject({
      signatureVerdict: "UNKNOWN",
      signatureCompatibilityVerdict: "PARTIAL",
      signatureFormulaCompatible: true,
      sigModelName: null,
      signatureEnvelopeModel: "claude-quince",
      signatureEnvelopeMatchesRequested: false,
      signatureEnvelopeChannelPresent: true,
      signatureEnvelopeChannelValue: 1,
      signatureEnvelopeVersion: 0,
      signatureEnvelopeVariant: 0,
      signatureEnvelopeEncryptedPayloadBytes: 889,
      signatureFormat: "claude-thinking-protobuf-v1",
      signatureStructurallyParsed: true,
    });
  });

  it("does not accept a model string hidden in an arbitrary Base64 blob", () => {
    const signature = Buffer.from("claude-opus-4-8\0thinking", "ascii").toString("base64url");
    expect(inspectClaudeSignatureEnvelope({
      signature,
      requestedModel: "claude-opus-4-8",
    })).toMatchObject({
      signatureIsValidBase64: true,
      signatureVerdict: "UNKNOWN",
      signatureCompatibilityVerdict: "UNKNOWN",
      signatureFormulaCompatible: false,
      signatureEnvelopeModel: null,
      signatureStructurallyParsed: false,
    });
  });

  it("rejects non-canonical and malformed Base64", () => {
    expect(inspectClaudeSignatureEnvelope({ signature: "a", requestedModel: "claude-opus-4-8" })).toMatchObject({
      signatureIsValidBase64: false,
      signatureVerdict: "FAIL",
      signatureCompatibilityVerdict: "FAIL",
    });
    expect(inspectClaudeSignatureEnvelope({ signature: "YWJj+_", requestedModel: "claude-opus-4-8" })).toMatchObject({
      signatureIsValidBase64: false,
      signatureVerdict: "FAIL",
    });
    expect(inspectClaudeSignatureEnvelope({ signature: "YQ=", requestedModel: "claude-opus-4-8" })).toMatchObject({
      signatureIsValidBase64: false,
      signatureVerdict: "FAIL",
    });
  });

  it("keeps a truncated protobuf envelope unknown and reports the structural issue", () => {
    const complete = Buffer.from(capturedShape({
      model: "claude-fable-5",
      outerVersion: 2,
      variant: 1,
      encryptedPayloadBytes: 53,
    }), "base64url");
    const truncated = complete.subarray(0, complete.length - 3).toString("base64url");
    const result = inspectClaudeSignatureEnvelope({ signature: truncated, requestedModel: "claude-fable-5" });
    expect(result).toMatchObject({
      signatureIsValidBase64: true,
      signatureVerdict: "UNKNOWN",
      signatureCompatibilityVerdict: "UNKNOWN",
      signatureFormulaCompatible: false,
      signatureStructurallyParsed: false,
    });
    expect(result.signatureStructureIssues.length).toBeGreaterThan(0);
  });

  it("does not give formula credit to unobserved envelope versions or channel values", () => {
    for (const overrides of [
      { outerVersion: 9 },
      { keyVersion: 16 },
      { schemaVersion: 3 },
      { variant: 2 },
      { channel: 2 },
    ]) {
      const result = inspectClaudeSignatureEnvelope({
        signature: capturedShape({
          model: "claude-opus-4-8",
          outerVersion: 2,
          variant: 1,
          encryptedPayloadBytes: 64,
          ...overrides,
        }),
        requestedModel: "claude-opus-4-8",
      });
      expect(result).toMatchObject({
        signatureIsValidBase64: true,
        signatureCompatibilityVerdict: "UNKNOWN",
        signatureFormulaCompatible: false,
        signatureStructurallyParsed: false,
      });
      expect(result.signatureStructureIssues.some((issue) => issue.startsWith("unsupported Claude"))).toBe(true);
    }
  });

  it("rejects duplicate or wrong-wire known protobuf fields instead of hiding channel metadata", () => {
    for (const overrides of [
      { channel: 1, channelAsBytes: true },
      { channel: 1, duplicateChannel: true },
    ]) {
      const result = inspectClaudeSignatureEnvelope({
        signature: capturedShape({
          model: "claude-opus-4-8",
          outerVersion: 2,
          variant: 1,
          encryptedPayloadBytes: 64,
          ...overrides,
        }),
        requestedModel: "claude-opus-4-8",
      });
      expect(result).toMatchObject({
        signatureCompatibilityVerdict: "UNKNOWN",
        signatureFormulaCompatible: false,
        signatureStructurallyParsed: false,
      });
      expect(result.signatureStructureIssues.some((issue) => issue.includes("Claude channel field"))).toBe(true);
    }
  });
});
