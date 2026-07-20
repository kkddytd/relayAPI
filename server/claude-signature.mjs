const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_PROTOBUF_DEPTH = 4;

function normalizeModel(value) {
  return String(value ?? "").trim().toLowerCase();
}

function decodeCanonicalBase64(value) {
  const input = String(value ?? "");
  if (!input || input.length % 4 === 1 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(input)) {
    return null;
  }

  // A signature may use either Base64 or Base64URL, but a mixed alphabet is
  // not a canonical encoding and Node's permissive decoder would accept it.
  const usesStandardAlphabet = /[+/]/.test(input);
  const usesUrlAlphabet = /[-_]/.test(input);
  if (usesStandardAlphabet && usesUrlAlphabet) return null;

  const hasPadding = input.endsWith("=");
  const unpadded = input.replace(/=+$/, "");
  const normalized = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  let decoded;
  try {
    decoded = Buffer.from(normalized, "base64");
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > MAX_SIGNATURE_BYTES) return null;

  const canonicalPadded = decoded.toString("base64");
  const canonicalUnpadded = canonicalPadded.replace(/=+$/, "");
  if (hasPadding) {
    const normalizedPadded = input.replace(/-/g, "+").replace(/_/g, "/");
    return normalizedPadded === canonicalPadded ? decoded : null;
  }
  return canonicalUnpadded === normalized ? decoded : null;
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  for (; cursor < buffer.length && cursor < offset + 10; cursor += 1) {
    const byte = buffer[cursor];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (cursor > offset && byte === 0) throw new Error("non-canonical protobuf varint");
      return { value, nextOffset: cursor + 1 };
    }
    shift += 7n;
  }
  throw new Error("unterminated protobuf varint");
}

function parseProtobufMessage(buffer, depth = 0) {
  if (!Buffer.isBuffer(buffer) || depth > MAX_PROTOBUF_DEPTH) {
    throw new Error("invalid protobuf message");
  }

  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const fieldOffset = offset;
    const tag = readVarint(buffer, offset);
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x07n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber < 1) {
      throw new Error("invalid protobuf field number");
    }

    if (wireType === 0) {
      const item = readVarint(buffer, offset);
      offset = item.nextOffset;
      fields.push({ fieldNumber, wireType, value: item.value, fieldOffset });
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error("truncated protobuf fixed64");
      const value = buffer.subarray(offset, offset + 8);
      offset += 8;
      fields.push({ fieldNumber, wireType, value, fieldOffset });
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.nextOffset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > buffer.length) {
        throw new Error("truncated protobuf bytes field");
      }
      const value = buffer.subarray(offset, offset + byteLength);
      offset += byteLength;
      fields.push({ fieldNumber, wireType, value, fieldOffset });
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error("truncated protobuf fixed32");
      const value = buffer.subarray(offset, offset + 4);
      offset += 4;
      fields.push({ fieldNumber, wireType, value, fieldOffset });
      continue;
    }
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
  return fields;
}

function oneField(fields, fieldNumber, wireType) {
  const matches = fields.filter((field) => field.fieldNumber === fieldNumber && field.wireType === wireType);
  return matches.length === 1 ? matches[0] : null;
}

function validateFieldShape(fields, fieldNumber, wireType, label, issues, optional = false) {
  const matches = fields.filter((field) => field.fieldNumber === fieldNumber);
  if (matches.length === 0) {
    if (!optional) issues.push(`missing ${label}`);
    return;
  }
  if (matches.length !== 1 || matches[0].wireType !== wireType) {
    issues.push(`duplicate or unexpected wire type for ${label}`);
  }
}

function bigintToSafeNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function decodeAscii(value) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.some((byte) => byte < 0x20 || byte > 0x7e)) {
    return null;
  }
  return value.toString("ascii");
}

function parseClaudeThinkingEnvelope(decoded) {
  const issues = [];
  let outer;
  try {
    outer = parseProtobufMessage(decoded);
  } catch (error) {
    return {
      parsed: false,
      complete: false,
      issues: [error instanceof Error ? error.message : "invalid protobuf envelope"],
    };
  }

  const envelopeField = oneField(outer, 2, 2);
  const terminalField = oneField(outer, 3, 0);
  const versionField = oneField(outer, 1, 0);
  validateFieldShape(outer, 1, 0, "Claude outer version field", issues, true);
  validateFieldShape(outer, 2, 2, "Claude outer envelope field", issues);
  validateFieldShape(outer, 3, 0, "Claude envelope terminal marker", issues);
  if (terminalField && terminalField.value !== 1n) issues.push("invalid Claude envelope terminal marker");
  if (!envelopeField) {
    return { parsed: true, complete: false, issues };
  }

  let envelope;
  try {
    envelope = parseProtobufMessage(envelopeField.value, 1);
  } catch (error) {
    return {
      parsed: true,
      complete: false,
      version: versionField ? bigintToSafeNumber(versionField.value) : 0,
      issues: [...issues, error instanceof Error ? error.message : "invalid inner protobuf envelope"],
    };
  }

  const metadataField = oneField(envelope, 1, 2);
  const nonceA = oneField(envelope, 2, 2);
  const nonceB = oneField(envelope, 3, 2);
  const authenticationBlock = oneField(envelope, 4, 2);
  const encryptedPayload = oneField(envelope, 5, 2);
  validateFieldShape(envelope, 1, 2, "Claude metadata field", issues);
  validateFieldShape(envelope, 2, 2, "Claude first nonce field", issues);
  validateFieldShape(envelope, 3, 2, "Claude second nonce field", issues);
  validateFieldShape(envelope, 4, 2, "Claude authentication block field", issues);
  validateFieldShape(envelope, 5, 2, "Claude encrypted payload field", issues);
  if (!nonceA || nonceA.value.length !== 12) issues.push("unexpected first nonce length");
  if (!nonceB || nonceB.value.length !== 12) issues.push("unexpected second nonce length");
  if (!authenticationBlock || authenticationBlock.value.length !== 48) issues.push("unexpected authentication block length");
  if (!encryptedPayload || encryptedPayload.value.length === 0) issues.push("missing encrypted thinking payload");
  if (!metadataField) {
    return {
      parsed: true,
      complete: false,
      version: versionField ? bigintToSafeNumber(versionField.value) : 0,
      encryptedPayloadBytes: encryptedPayload?.value.length ?? null,
      issues,
    };
  }

  let metadata;
  try {
    metadata = parseProtobufMessage(metadataField.value, 2);
  } catch (error) {
    return {
      parsed: true,
      complete: false,
      version: versionField ? bigintToSafeNumber(versionField.value) : 0,
      encryptedPayloadBytes: encryptedPayload?.value.length ?? null,
      issues: [...issues, error instanceof Error ? error.message : "invalid Claude metadata"],
    };
  }

  const keyVersionField = oneField(metadata, 1, 0);
  const channelField = oneField(metadata, 2, 0);
  const schemaVersionField = oneField(metadata, 3, 0);
  const authenticator = oneField(metadata, 5, 2);
  const modelField = oneField(metadata, 6, 2);
  const variantField = oneField(metadata, 7, 0);
  const payloadTypeField = oneField(metadata, 8, 2);
  const sessionField = oneField(metadata, 11, 2);
  const model = decodeAscii(modelField?.value);
  const payloadType = decodeAscii(payloadTypeField?.value);
  const sessionId = decodeAscii(sessionField?.value);
  const outerVersion = versionField ? bigintToSafeNumber(versionField.value) : 0;
  const keyVersion = keyVersionField ? bigintToSafeNumber(keyVersionField.value) : null;
  const schemaVersion = schemaVersionField ? bigintToSafeNumber(schemaVersionField.value) : null;
  const channelValue = channelField ? bigintToSafeNumber(channelField.value) : null;
  const variant = variantField ? bigintToSafeNumber(variantField.value) : null;

  validateFieldShape(metadata, 1, 0, "Claude key-version field", issues);
  validateFieldShape(metadata, 2, 0, "Claude channel field", issues, true);
  validateFieldShape(metadata, 3, 0, "Claude schema-version field", issues);
  validateFieldShape(metadata, 5, 2, "Claude authenticator field", issues);
  validateFieldShape(metadata, 6, 2, "Claude model metadata field", issues);
  validateFieldShape(metadata, 7, 0, "Claude envelope variant field", issues);
  validateFieldShape(metadata, 8, 2, "Claude payload type field", issues);
  validateFieldShape(metadata, 11, 2, "Claude session identifier field", issues, true);
  if (keyVersionField && keyVersion !== 15) issues.push("unsupported Claude key version");
  if (schemaVersionField && schemaVersion !== 2) issues.push("unsupported Claude schema version");
  if (outerVersion !== 0 && outerVersion !== 2) issues.push("unsupported Claude outer envelope version");
  if (!authenticator || authenticator.value.length !== 64) issues.push("unexpected authenticator length");
  if (!model || !/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(model)) issues.push("invalid Claude model metadata");
  if (payloadType !== "thinking") issues.push("unexpected Claude payload type");
  if (variantField && variant !== 0 && variant !== 1) issues.push("unsupported Claude envelope variant");
  if (channelField && channelValue !== 1) issues.push("unsupported Claude channel marker");
  if (sessionField && (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))) {
    issues.push("invalid Claude session identifier");
  }

  return {
    parsed: true,
    complete: issues.length === 0,
    format: "claude-thinking-protobuf-v1",
    version: outerVersion,
    keyVersion,
    schemaVersion,
    model: model?.toLowerCase() ?? null,
    channelPresent: Boolean(channelField),
    channelValue,
    variant,
    payloadType,
    sessionId,
    encryptedPayloadBytes: encryptedPayload?.value.length ?? null,
    issues,
  };
}

function emptyInspection(reason, overrides = {}) {
  return {
    signatureIsValidBase64: null,
    signatureVerdict: "UNKNOWN",
    signatureCompatibilityVerdict: "UNKNOWN",
    signatureCompatibilityReason: reason,
    signatureFormulaCompatible: false,
    sigModelName: null,
    signatureEnvelopeModel: null,
    signatureEnvelopeMatchesRequested: false,
    signatureEnvelopeChannelPresent: false,
    signatureEnvelopeChannelValue: null,
    signatureEnvelopeVersion: null,
    signatureEnvelopeKeyVersion: null,
    signatureEnvelopeSchemaVersion: null,
    signatureEnvelopeVariant: null,
    signatureEnvelopePayloadType: null,
    signatureEnvelopeSessionId: null,
    signatureEnvelopeEncryptedPayloadBytes: null,
    signatureFormat: null,
    signatureStructureIssues: [],
    signatureReason: reason,
    signatureStructurallyParsed: false,
    ...overrides,
  };
}

/**
 * Parses only the public wire structure carried in a Claude signature_delta.
 * Anthropic documents this value as opaque and does not publish an offline
 * verification key. Parsed model/channel fields are therefore diagnostics,
 * not authenticated provenance, and must never become a cryptographic PASS.
 */
export function inspectClaudeSignatureEnvelope({ signature, requestedModel }) {
  const value = String(signature ?? "");
  if (!value) return emptyInspection("no signature_delta observed");

  const decoded = decodeCanonicalBase64(value);
  if (!decoded) {
    return emptyInspection("signature_delta is not canonical Base64/Base64URL", {
      signatureIsValidBase64: false,
      signatureVerdict: "FAIL",
      signatureCompatibilityVerdict: "FAIL",
    });
  }

  const envelope = parseClaudeThinkingEnvelope(decoded);
  const requested = normalizeModel(requestedModel);
  const matchesRequestedModel = Boolean(envelope.complete && requested && envelope.model === requested);
  const signatureCompatibilityVerdict = envelope.complete
    ? envelope.channelPresent
      ? "PARTIAL"
      : "PASS"
    : "UNKNOWN";
  const signatureCompatibilityReason = envelope.complete
    ? envelope.channelPresent
      ? `complete Claude protobuf envelope with channel=${envelope.channelValue ?? "unknown"}; structurally consistent with a Vertex/Bedrock-style proxy`
      : "complete Claude protobuf envelope with no channel marker; structurally consistent with a direct Anthropic response"
    : envelope.parsed
      ? "Claude protobuf envelope is incomplete or uses an unsupported structure"
      : "signature_delta does not contain a parseable Claude protobuf envelope";
  const reason = envelope.complete
    ? matchesRequestedModel
      ? "parsed Claude thinking envelope matches the requested model; cryptographic verdict unavailable"
      : "parsed Claude thinking envelope reports a different/internal model; cryptographic verdict unavailable"
    : envelope.parsed
      ? "valid Base64 with an incomplete or unsupported Claude protobuf envelope"
      : "valid Base64 without a parseable Claude protobuf envelope";

  return emptyInspection(reason, {
    signatureIsValidBase64: true,
    signatureCompatibilityVerdict,
    signatureCompatibilityReason,
    signatureFormulaCompatible: envelope.complete === true,
    signatureEnvelopeModel: envelope.model ?? null,
    signatureEnvelopeMatchesRequested: matchesRequestedModel,
    signatureEnvelopeChannelPresent: envelope.channelPresent ?? false,
    signatureEnvelopeChannelValue: envelope.channelValue ?? null,
    signatureEnvelopeVersion: envelope.version ?? null,
    signatureEnvelopeKeyVersion: envelope.keyVersion ?? null,
    signatureEnvelopeSchemaVersion: envelope.schemaVersion ?? null,
    signatureEnvelopeVariant: envelope.variant ?? null,
    signatureEnvelopePayloadType: envelope.payloadType ?? null,
    signatureEnvelopeSessionId: envelope.sessionId ?? null,
    signatureEnvelopeEncryptedPayloadBytes: envelope.encryptedPayloadBytes ?? null,
    signatureFormat: envelope.format ?? null,
    signatureStructureIssues: envelope.issues ?? [],
    signatureStructurallyParsed: envelope.complete === true,
  });
}
