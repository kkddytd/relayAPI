import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createClientDisconnectController,
  createConcurrencyGate,
  detectionApiAuthorization,
  detectionQueueKey,
  extractAnthropicContentSignatures,
  fetchLiveKnowledgeSnapshot,
  internalProbeUnavailableResult,
  invokeInternalProbe,
  isDirectLanRequest,
  isDirectLoopbackRequest,
  installationReportSourceIp,
  isJsonRequest,
  isPrivateAddress,
  isTrustedWebProxyRequest,
  isTurnstileHostnameAllowed,
  isUpstreamAddressAllowed,
  lastValidForwardedAddress,
  maskCredentialPatterns,
  parseMultipartDetectionRequest,
  publicAttachmentAnalysis,
  readRequestBody,
  readResponseTextWithLimit,
  resolveExistingFileWithinDirectory,
  resolveStaticFile,
  requestSourceKey,
  sanitizeOutboundHeaders,
  serializeBoundedLogEntry,
  signWebSessionId,
  verifyWebSessionToken,
  waitForPromiseWithSignal,
  upstreamQueueKey,
  webDataAuthorization,
} from "./index.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upstream request serialization keys", () => {
  it("maps Bearer and x-api-key credentials for the same host to one queue", () => {
    const bearer = upstreamQueueKey("https://relay.example/v1/messages", { authorization: "Bearer sk-same" });
    const apiKey = upstreamQueueKey("https://relay.example/v1/messages", { "x-api-key": "sk-same" });
    expect(bearer).toBe(apiKey);
    expect(bearer).not.toContain("sk-same");
    expect(upstreamQueueKey("https://other.example/v1/messages", { "x-api-key": "sk-same" })).not.toBe(apiKey);
    expect(upstreamQueueKey("https://relay.example/v1/messages", { "x-api-key": "sk-other" })).not.toBe(apiKey);
  });

  it("uses the same host and credential identity for whole API detections", () => {
    expect(detectionQueueKey("https://relay.example/v1", "Bearer sk-same"))
      .toBe(detectionQueueKey("https://relay.example/v1/messages", "sk-same"));
    expect(detectionQueueKey("https://relay.example/v1", "x-api-key: sk-same"))
      .toBe(detectionQueueKey("https://relay.example/v1/messages", "sk-same"));
  });
});

describe("multipart attachment request privacy", () => {
  it("matches files by order, generates server-owned references, and hides them publicly", () => {
    const records = [
      { id: "att_11111111111111111111111111111111", originalName: "worker.py" },
      { id: "att_22222222222222222222222222222222", originalName: "config.json" },
    ];
    const request = parseMultipartDetectionRequest({
      request: JSON.stringify({
        base_url: "https://relay.example",
        upstream_api_key: "sk-test-only",
        model: "gpt-test",
        attachments: [
          { id: "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mode: "understand", instruction: "Explain code" },
          { mode: "verify", expected_intent: "Configuration data" },
        ],
      }),
    }, records);

    expect(request.attachments).toEqual([
      { id: records[0].id, mode: "understand", instruction: "Explain code" },
      { id: records[1].id, mode: "verify", expected_intent: "Configuration data" },
    ]);
    expect(JSON.stringify(request.attachments)).not.toContain("att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const publicReport = publicAttachmentAnalysis({
      requested: true,
      status: "completed",
      completed: records.length,
      total: records.length,
      items: records.map((record) => ({
        attachment_id: record.id,
        name: record.originalName,
        status: "completed",
        analysis: {
          observable_content: "Readable source material",
          extracted_text: "const fixture = true",
          likely_purpose: "Test fixture",
          evidence: ["Source text was supplied"],
          alternatives: [],
          confidence: 90,
          limitations: [],
        },
      })),
    });
    expect(publicReport.items.map((item) => item.attachment_id)).toEqual(["worker.py", "config.json"]);
    expect(JSON.stringify(publicReport)).not.toContain("att_");
  });

  it("downgrades stale ungrounded attachment results before returning history", () => {
    const publicReport = publicAttachmentAnalysis({
      requested: true,
      status: "completed",
      completed: 1,
      total: 1,
      items: [{
        attachment_id: "att_33333333333333333333333333333333",
        name: "generated-003.png",
        status: "completed",
        raw_response: "I'm Claude, an AI assistant made by Anthropic.",
        analysis: {
          observable_content: "I'm Claude, an AI assistant made by Anthropic.",
          extracted_text: "",
          likely_purpose: "",
          evidence: [],
          alternatives: [],
          confidence: 0,
          limitations: ["The model did not return the requested JSON structure."],
        },
      }],
    });

    expect(publicReport).toMatchObject({
      status: "failed",
      completed: 0,
      total: 1,
      items: [{
        attachment_id: "generated-003.png",
        status: "failed",
        analysis: null,
        error: "attachment_not_observed_by_model",
      }],
    });
    expect(JSON.stringify(publicReport)).not.toContain("I'm Claude");
    expect(JSON.stringify(publicReport)).not.toContain("att_33333333333333333333333333333333");
  });

  it("rejects ambiguous attachment metadata and preserves unknown fields for validation", () => {
    const records = [{ id: "att_11111111111111111111111111111111", originalName: "worker.py" }];
    expect(() => parseMultipartDetectionRequest({
      request: JSON.stringify({ attachments: "worker.py" }),
    }, records)).toThrow("invalid_attachments");
    expect(() => parseMultipartDetectionRequest({
      request: JSON.stringify({ attachments: [] }),
    }, records)).toThrow("attachment_count_mismatch");

    const parsed = parseMultipartDetectionRequest({
      request: JSON.stringify({ attachments: [{ unexpected: true }] }),
    }, records);
    expect(parsed.attachments).toEqual([{ id: records[0].id, unexpected: true }]);
  });
});

describe("upstream address safety", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:a00:1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "64:ff9b:1::808:808",
    "2002:7f00:1::",
    "2001:db8::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "::ffff:808:808",
  ])("allows public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([
    "100.100.100.200",
    "168.63.129.16",
    "169.254.169.254",
    "169.254.170.2",
    "fd00:ec2::254",
    "::ffff:a83f:8110",
    "64:ff9b::a83f:8110",
    "2002:a83f:8110::",
  ])("always blocks cloud metadata address %s, including explicit private mode", (address) => {
    expect(isUpstreamAddressAllowed(address, true)).toBe(false);
  });

  it.each(["127.0.0.1", "10.0.0.5", "100.64.0.2", "192.168.1.5", "fc00::5"])(
    "only permits local development address %s after explicit opt-in",
    (address) => {
      expect(isUpstreamAddressAllowed(address, false)).toBe(false);
      expect(isUpstreamAddressAllowed(address, true)).toBe(true);
    },
  );

  it("still permits public addresses without private mode", () => {
    expect(isUpstreamAddressAllowed("1.1.1.1", false)).toBe(true);
  });
});

describe("outbound header safety", () => {
  it("normalizes ordinary protocol headers", () => {
    expect(sanitizeOutboundHeaders({ "X-Api-Key": "opaque", "Content-Type": "application/json" }))
      .toEqual({ "x-api-key": "opaque", "content-type": "application/json" });
  });

  it.each(["host", "content-length", "connection", "transfer-encoding", "proxy-authorization"])(
    "rejects caller-controlled hop-by-hop header %s",
    (name) => {
      expect(() => sanitizeOutboundHeaders({ [name]: "value" })).toThrow("forbidden_upstream_header");
    },
  );

  it("rejects CRLF header injection", () => {
    expect(() => sanitizeOutboundHeaders({ "x-api-key": "key\r\nx-injected: true" }))
      .toThrow("invalid_upstream_header");
  });
});

describe("non-streaming Anthropic signature extraction", () => {
  it("collects signatures only from thinking blocks and preserves response identity", () => {
    expect(extractAnthropicContentSignatures({
      id: "msg_vertex_example",
      model: "claude-opus-4-8",
      content: [
        { type: "thinking", thinking: "hidden", signature: "c2lnbmF0dXJl" },
        { type: "thinking", thinking: "empty", signature: "" },
        { type: "text", text: "visible", signature: "ignored" },
      ],
    })).toEqual({
      values: ["c2lnbmF0dXJl"],
      emptyCount: 1,
      messageId: "msg_vertex_example",
      model: "claude-opus-4-8",
    });
  });

  it("returns an empty observation for malformed response bodies", () => {
    expect(extractAnthropicContentSignatures(null)).toEqual({
      values: [],
      emptyCount: 0,
      messageId: null,
      model: null,
    });
  });
});

describe("log credential masking", () => {
  it("masks Ark and dotted Zhipu-style credentials in arbitrary text", () => {
    const ark = "ark-1234567890abcdefghij";
    const zhipu = "0123456789abcdef0123456789abcdef.ABCDEFGH12345678";
    const masked = maskCredentialPatterns(`upstream rejected ${ark}; alternate ${zhipu}`);

    expect(masked).not.toContain(ark);
    expect(masked).not.toContain(zhipu);
    expect(masked).toContain("ark-12***ij");
    expect(masked).toContain("012345***78");
  });

  it("also masks credentials embedded in synthetic diagnostics", () => {
    const secret = "ark-abcdefghijklmnopqrstuv";
    const result = internalProbeUnavailableResult(`failed for ${secret}`, 12);

    expect(result.bodyText).not.toContain(secret);
    expect(result).toMatchObject({ ok: true, status: 0, latencyMs: 12 });
  });

  it("masks the exact outbound credential even when its format is unknown", () => {
    const secret = "merchant credential:alpha/2026!";
    const masked = maskCredentialPatterns(`upstream echoed ${secret}`, [secret]);

    expect(masked).not.toContain(secret);
    expect(masked).toBe("upstream echoed [redacted-credential]");
  });
});

describe("loopback exemptions", () => {
  function request(headers = {}) {
    return {
      headers: { host: "127.0.0.1:6722", ...headers },
      socket: { remoteAddress: "127.0.0.1" },
    };
  }

  it("allows a genuine direct loopback request", () => {
    expect(isDirectLoopbackRequest(request())).toBe(true);
  });

  it.each([
    { "x-forwarded-for": "203.0.113.9" },
    { forwarded: "for=203.0.113.9;proto=https" },
    { "x-real-ip": "203.0.113.9" },
  ])("does not grant loopback privileges through a reverse proxy: %o", (headers) => {
    expect(isDirectLoopbackRequest(request(headers))).toBe(false);
  });

  it("requires a local Host header as well as a loopback socket", () => {
    expect(isDirectLoopbackRequest(request({ host: "relay.example" }))).toBe(false);
  });

  it("recognizes only direct private-network requests as LAN requests", () => {
    expect(isDirectLanRequest({
      headers: { host: "10.1.4.12:6722" },
      socket: { remoteAddress: "10.1.4.25" },
    })).toBe(true);
    expect(isDirectLanRequest({
      headers: { host: "10.1.4.12:6722", "x-forwarded-for": "10.1.4.25" },
      socket: { remoteAddress: "10.1.4.25" },
    })).toBe(false);
    expect(isDirectLanRequest({
      headers: { host: "public.example" },
      socket: { remoteAddress: "10.1.4.25" },
    })).toBe(false);
    expect(isDirectLanRequest({
      headers: { host: "10.1.4.12:6722" },
      socket: { remoteAddress: "198.51.100.25" },
    })).toBe(false);
  });

  it("accepts a trusted web proxy token only from a loopback proxy", () => {
    const token = "trusted-proxy-test-token";
    expect(isTrustedWebProxyRequest({
      headers: { "x-kangkang-trusted-web": token, "x-forwarded-for": "203.0.113.20" },
      socket: { remoteAddress: "127.0.0.1" },
    }, token)).toBe(true);
    expect(isTrustedWebProxyRequest({
      headers: { "x-kangkang-trusted-web": "wrong-token" },
      socket: { remoteAddress: "127.0.0.1" },
    }, token)).toBe(false);
    expect(isTrustedWebProxyRequest({
      headers: { "x-kangkang-trusted-web": token },
      socket: { remoteAddress: "198.51.100.25" },
    }, token)).toBe(false);
  });

  it("ignores spoofed forwarding headers from an untrusted direct peer", () => {
    const req = request({ "x-forwarded-for": "1.2.3.4" });
    req.socket.remoteAddress = "198.51.100.25";
    expect(requestSourceKey(req)).toBe("198.51.100.25");
  });

  it("selects the rightmost valid forwarded address instead of a prepended spoof", () => {
    expect(lastValidForwardedAddress("1.2.3.4, 203.0.113.20")).toBe("203.0.113.20");
    expect(lastValidForwardedAddress("not-an-ip")).toBe("");
  });

  it("uses forwarded installation IPs from a loopback reverse proxy", () => {
    expect(installationReportSourceIp(request({ "x-forwarded-for": "198.51.100.30" }))).toBe("198.51.100.30");
    const direct = request({ "x-forwarded-for": "198.51.100.31" });
    direct.socket.remoteAddress = "8.8.4.4";
    expect(installationReportSourceIp(direct)).toBe("8.8.4.4");
  });

  it("uses forwarded installation IPs from a trusted Docker gateway", () => {
    const proxied = request({ "x-forwarded-for": "198.51.100.32" });
    proxied.socket.remoteAddress = "172.18.0.1";
    expect(installationReportSourceIp(proxied)).toBe("198.51.100.32");
    expect(installationReportSourceIp(proxied, false)).toBe("172.18.0.1");
  });

  it("ignores installation forwarding headers from a public direct peer", () => {
    const direct = request({ "x-forwarded-for": "198.51.100.33", "x-real-ip": "198.51.100.34" });
    direct.socket.remoteAddress = "8.8.8.8";
    expect(installationReportSourceIp(direct, true)).toBe("8.8.8.8");
  });
});

describe("programmatic API authorization", () => {
  it("does not accept the trusted Web proxy header as a detector credential", () => {
    const result = detectionApiAuthorization({
      headers: {
        host: "relay.example",
        "x-forwarded-for": "203.0.113.20",
        "x-kangkang-trusted-web": "kk-public-web-via-loopback",
      },
      socket: { remoteAddress: "127.0.0.1" },
    }, ["det_test_key"]);

    expect(result).toMatchObject({ allowed: false, status: 401, code: "invalid_detector_api_key" });
  });

  it("accepts a valid detector Bearer credential", () => {
    const result = detectionApiAuthorization({
      headers: { authorization: "Bearer det_test_key" },
      socket: { remoteAddress: "203.0.113.20" },
    }, ["det_test_key"]);

    expect(result).toMatchObject({ allowed: true, mode: "bearer" });
  });

  it("keeps a valid Bearer owner scope on loopback Web data routes", () => {
    const req = {
      headers: {
        host: "127.0.0.1:6722",
        authorization: "Bearer det_test_key",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    expect(webDataAuthorization(req, {}, { configuredKeys: ["det_test_key"] })).toMatchObject({
      allowed: true,
      mode: "bearer",
      ownerScope: expect.stringMatching(/^api:/),
    });
    delete req.headers.authorization;
    expect(webDataAuthorization(req, {}, { configuredKeys: ["det_test_key"] })).toMatchObject({
      allowed: true,
      mode: "local",
      ownerScope: "local",
    });
  });
});

describe("Turnstile origin binding", () => {
  it("only accepts explicitly configured hostnames", () => {
    expect(isTurnstileHostnameAllowed("localhost")).toBe(true);
    expect(isTurnstileHostnameAllowed("LOCALHOST.")).toBe(true);
    expect(isTurnstileHostnameAllowed("attacker.example")).toBe(false);
  });
});

describe("anonymous Web session signing", () => {
  it("accepts only an untampered session identifier", () => {
    const secret = Buffer.alloc(32, 7);
    const id = "review_session_identifier_1234567890";
    const token = signWebSessionId(id, secret);

    expect(verifyWebSessionToken(token, secret)).toBe(id);
    expect(verifyWebSessionToken(`${token.slice(0, -1)}x`, secret)).toBeNull();
    expect(verifyWebSessionToken(token, Buffer.alloc(32, 8))).toBeNull();
  });
});

describe("request body decoding", () => {
  it.each([
    "application/json",
    "application/json; charset=utf-8",
    "application/problem+json",
  ])("accepts JSON media type %s", (contentType) => {
    expect(isJsonRequest({ headers: { "content-type": contentType } })).toBe(true);
  });

  it.each([undefined, "", "text/plain", "application/x-www-form-urlencoded"])(
    "rejects non-JSON media type %s",
    (contentType) => {
      expect(isJsonRequest({ headers: { "content-type": contentType } })).toBe(false);
    },
  );

  it("rejects an oversized declared body before attaching stream listeners", async () => {
    const req = new EventEmitter();
    req.headers = { "content-length": "2048" };
    req.resume = vi.fn();

    await expect(readRequestBody(req, 1024)).rejects.toMatchObject({ code: "request_body_too_large" });
    expect(req.resume).toHaveBeenCalledOnce();
    expect(req.listenerCount("data")).toBe(0);
  });

  it("allows an explicitly unbounded internal probe body", async () => {
    const req = new EventEmitter();
    req.headers = { "content-length": "2048" };
    req.resume = vi.fn();
    const pending = readRequestBody(req, Number.POSITIVE_INFINITY);

    req.emit("data", Buffer.alloc(2048, 7));
    req.emit("end");

    await expect(pending).resolves.toHaveLength(2048);
  });

  it("preserves UTF-8 characters split across transport chunks", async () => {
    const req = new EventEmitter();
    req.headers = {};
    const encoded = Buffer.from('{"text":"中文"}', "utf8");
    req.resume = vi.fn();
    const pending = readRequestBody(req, 1024);

    req.emit("data", encoded.subarray(0, 10));
    req.emit("data", encoded.subarray(10, 12));
    req.emit("data", encoded.subarray(12));
    req.emit("end");

    await expect(pending).resolves.toBe('{"text":"中文"}');
  });
});

describe("static file boundary", () => {
  it.each(["/.env", "/assets/.secret", "/index.js.map", "/%00invalid", "/..%5csecret.txt"])(
    "rejects sensitive static path %s",
    (urlPath) => {
      expect(resolveStaticFile(urlPath)).toBeNull();
    },
  );

  it("rejects encoded traversal attempts", () => {
    expect(resolveStaticFile("/..%2fpackage.json")).toBeNull();
  });

  it("rejects a symlink whose real target leaves the static root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kangkang-static-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kangkang-static-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    const link = path.join(root, "asset.txt");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, link);
    try {
      expect(resolveExistingFileWithinDirectory(root, link)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("bounded audit logging", () => {
  it("replaces oversized entries with a fixed metadata record", () => {
    const serialized = serializeBoundedLogEntry(
      "probe_response",
      { response: "x".repeat(10_000) },
      512,
      "2026-07-17T00:00:00.000Z",
    );
    const parsed = JSON.parse(serialized);

    expect(parsed).toMatchObject({
      kind: "probe_response",
      truncated: true,
      ts: "2026-07-17T00:00:00.000Z",
    });
    expect(parsed.originalBytes).toBeGreaterThan(512);
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain("x".repeat(100));
  });
});

describe("probe concurrency and cancellation", () => {
  it("limits all callers globally and releases each slot exactly once", () => {
    const gate = createConcurrencyGate(2);
    const releaseFirst = gate.tryAcquire();
    const releaseSecond = gate.tryAcquire();

    expect(releaseFirst).toBeTypeOf("function");
    expect(releaseSecond).toBeTypeOf("function");
    expect(gate.active).toBe(2);
    expect(gate.tryAcquire()).toBeNull();

    releaseFirst();
    releaseFirst();
    expect(gate.active).toBe(1);
    expect(gate.tryAcquire()).toBeTypeOf("function");
  });

  it.each(["aborted", "close"])("aborts upstream work on client %s", (event) => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = false;
    const lifecycle = createClientDisconnectController(req, res);

    (event === "aborted" ? req : res).emit(event);

    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.signal.reason).toMatchObject({ message: "client_disconnected" });
    lifecycle.cleanup();
  });

  it("does not mark a normally completed response as canceled", () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = true;
    const lifecycle = createClientDisconnectController(req, res);

    res.emit("close");

    expect(lifecycle.signal.aborted).toBe(false);
    lifecycle.cleanup();
  });

  it("releases a pending DNS-style operation when the request is canceled", async () => {
    const controller = new AbortController();
    const neverSettles = new Promise(() => {});
    const pending = waitForPromiseWithSignal(neverSettles, controller.signal);

    controller.abort(new Error("client_disconnected"));

    await expect(pending).rejects.toThrow("client_disconnected");
  });
});

describe("bounded fixed-source responses", () => {
  it("reads a response below the configured byte limit", async () => {
    const response = new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });

    await expect(readResponseTextWithLimit(response, 64)).resolves.toBe('{"ok":true}');
  });

  it("rejects a streamed response that exceeds the configured byte limit", async () => {
    const response = new Response("x".repeat(65));

    await expect(readResponseTextWithLimit(response, 64, "live_source_response_too_large"))
      .rejects.toMatchObject({ message: "live_source_response_too_large" });
  });

  it("rejects an oversized declared content length before reading", async () => {
    const response = new Response("small", { headers: { "content-length": "1000" } });

    await expect(readResponseTextWithLimit(response, 64, "live_source_response_too_large"))
      .rejects.toMatchObject({ code: "live_source_response_too_large" });
  });

  it("cancels a live-source fetch when its detection request disconnects", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchLiveKnowledgeSnapshot("2026-07-17", controller.signal);
    controller.abort(new Error("client_disconnected"));

    await expect(pending).rejects.toThrow("client_disconnected");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
});

describe("internal probe degradation", () => {
  it("passes client cancellation through to the internal relay fetch", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })));

    const pending = invokeInternalProbe({ stage: "test" }, { signal: controller.signal });
    controller.abort(new Error("client_disconnected"));

    await expect(pending).rejects.toThrow("client_disconnected");
  });

  it("only forwards the private-target grant supplied by trusted server context", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await invokeInternalProbe({ stage: "test", internalAllowPrivateUpstream: true });
    await invokeInternalProbe({ stage: "test" }, { allowPrivateUpstream: true });

    const untrustedPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const trustedPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(untrustedPayload.internalAllowPrivateUpstream).toBe(false);
    expect(trustedPayload.internalAllowPrivateUpstream).toBe(true);
  });

  it("turns a timeout into an unavailable synthetic probe", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    const result = await invokeInternalProbe({ stage: "test" });

    expect(result).toMatchObject({ ok: true, status: 0 });
    expect(JSON.parse(result.bodyText).error).toMatchObject({
      type: "internal_probe_unavailable",
      message: "internal_probe_timeout",
    });
  });

  it("turns an invalid internal response into an unavailable synthetic probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("invalid JSON")),
    }));

    const result = await invokeInternalProbe({ stage: "test" });

    expect(JSON.parse(result.bodyText).error.message).toBe("internal_probe_invalid_response");
  });

  it("turns an internal 5xx into an unavailable synthetic probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ ok: false, error: "probe_failed" }),
    }));

    const result = await invokeInternalProbe({ stage: "test" });

    expect(result).toMatchObject({ ok: true, status: 0 });
    expect(JSON.parse(result.bodyText).error.message).toBe("probe_failed");
  });
});
