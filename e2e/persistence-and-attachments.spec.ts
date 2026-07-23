import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, request as playwrightRequest, test } from "@playwright/test";

let upstreamServer: http.Server;
let upstreamUrl = "";
const upstreamRequestBodies: string[] = [];
const upstreamRequestRoutes: string[] = [];

function trustedWebHeaders(address: string) {
  return {
    "x-kangkang-trusted-web": "kk-e2e-trusted-web",
    "x-forwarded-for": address,
  };
}

function multipartDetectionBody(request: Record<string, unknown>, files: Array<{
  name: string;
  mimeType: string;
  buffer: Buffer;
}>) {
  const boundary = `----kk-e2e-${Date.now().toString(16)}`;
  const chunks = [Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="request"\r\n\r\n' +
    `${JSON.stringify(request)}\r\n`,
  )];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.mimeType}\r\n\r\n`,
    ));
    chunks.push(file.buffer, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    data: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

test.beforeAll(async () => {
  upstreamServer = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      const requestText = Buffer.concat(chunks).toString("utf8");
      upstreamRequestBodies.push(requestText);
      upstreamRequestRoutes.push(request.url || "");
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("/chat/completions")) {
        let requestPayload: { model?: string } = {};
        try {
          requestPayload = JSON.parse(requestText) as { model?: string };
        } catch {
          // The fixture returns the normal malformed-response path below.
        }
        const attachmentAnalysis = requestText.includes("Attachment-derived material:") ||
          requestText.includes("attachment-understanding check");
        const selectedModelMissedAttachment = attachmentAnalysis && requestPayload.model === "e2e-text-only-model";
        response.end(JSON.stringify({
          id: "chatcmpl-e2e-attachment",
          model: "e2e-code-model",
          choices: [{
            message: {
              role: "assistant",
              content: selectedModelMissedAttachment
                ? JSON.stringify({
                    observable_content: "No image was provided.",
                    extracted_text: "",
                    likely_purpose: "",
                    evidence: [],
                    alternatives: [],
                    confidence: 0,
                    limitations: [],
                  })
                : attachmentAnalysis
                ? JSON.stringify({
                    observable_content: "Source code or structured configuration",
                    extracted_text: "Code fixture",
                    likely_purpose: "Demonstrate attachment intent analysis",
                    evidence: ["Readable source text was supplied"],
                    alternatives: [],
                    confidence: 94,
                    limitations: [],
                  })
                : "OK",
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }));
        return;
      }
      if (request.url?.includes("/messages")) {
        const attachmentAnalysis = requestText.includes("attachment-understanding check");
        response.end(JSON.stringify({
          id: "msg_e2e_attachment",
          type: "message",
          role: "assistant",
          model: "e2e-anthropic-model",
          content: [{
            type: "text",
            text: attachmentAnalysis
              ? JSON.stringify({
                  observable_content: "No image was provided.",
                  extracted_text: "",
                  likely_purpose: "",
                  evidence: [],
                  alternatives: [],
                  confidence: 0,
                  limitations: [],
                })
              : "OK",
          }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        }));
        return;
      }
      response.end(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: Buffer.from("e2e-image-result").toString("base64") }],
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once("error", reject);
    upstreamServer.listen(0, "127.0.0.1", resolve);
  });
  const address = upstreamServer.address();
  if (!address || typeof address === "string") throw new Error("Unable to start the E2E upstream fixture");
  upstreamUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!upstreamServer?.listening) return;
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

test("the web attachment picker accepts every file type", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "附件识别检查" })).toBeVisible();
  const input = page.locator('input[type="file"]');
  await expect(input).not.toHaveAttribute("accept");
  await input.setInputFiles({
    name: "payload.no-known-extension",
    mimeType: "application/x-arbitrary-test",
    buffer: Buffer.from([0, 255, 10, 65, 66, 67]),
  });
  await expect(page.getByText("payload.no-known-extension", { exact: true })).toBeVisible();
  await expect(page.getByText(/只验证模型是否收到并读取附件/)).toBeVisible();
});

test("the attachment API stores arbitrary bytes in the dedicated directory", async ({ request }) => {
  const payload = Buffer.from([0, 255, 1, 2, 3, 4, 13, 10, 88]);
  const response = await request.post("/api/v1/attachments", {
    multipart: {
      files: {
        name: "api-upload.unrestricted",
        mimeType: "application/x-completely-unknown",
        buffer: payload,
      },
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  expect(body).toMatchObject({
    ok: true,
    items: [expect.objectContaining({
      name: "api-upload.unrestricted",
      url: "/upload/api-upload.unrestricted",
      media_type: "application/x-completely-unknown",
      size_bytes: payload.length,
    })],
  });
  const viewResponse = await request.get(body.items[0].url);
  expect(viewResponse.status()).toBe(200);
  expect(await viewResponse.body()).toEqual(payload);
  const attachmentId = body.items[0].id;
  expect(attachmentId).toMatch(/^att_[a-f0-9]{32}$/);
  const database = new Database(path.join(process.env.E2E_DATA_DIR || "", "kangkang.sqlite"), { readonly: true });
  const stored = database.prepare("SELECT storage_path FROM attachments WHERE id = ?").get(attachmentId) as { storage_path: string };
  database.close();
  const storedPath = stored.storage_path;
  expect(path.dirname(storedPath)).toContain(path.join(process.env.E2E_DATA_DIR || "", ".attachment-history"));
  expect(path.basename(storedPath)).toBe("api-upload.unrestricted");
  expect(fs.readFileSync(storedPath)).toEqual(payload);
  expect(fs.readFileSync(path.join(process.env.E2E_DATA_DIR || "", "upload", "api-upload.unrestricted"))).toEqual(payload);
});

test("multipart detection accepts code files without caller attachment IDs", async ({ request }) => {
  const names = ["worker.py", "handler.php", "client.js", "config.json"];
  const files = [
    { name: names[0], mimeType: "application/octet-stream", buffer: Buffer.from("def run():\n    return 'python intent'\n") },
    { name: names[1], mimeType: "application/octet-stream", buffer: Buffer.from("<?php function run() { return 'php intent'; }") },
    { name: names[2], mimeType: "application/octet-stream", buffer: Buffer.from("export const intent = 'javascript intent';\n") },
    { name: names[3], mimeType: "application/octet-stream", buffer: Buffer.from(JSON.stringify({ intent: "json configuration" })) },
  ];
  const body = multipartDetectionBody({
    base_url: upstreamUrl,
    upstream_api_key: "e2e-upstream-key",
    model: "e2e-code-model",
    protocol: "openai-chat",
    rounds: 1,
    checks: { cache: false, live_knowledge: false },
    attachments: names.map(() => ({ mode: "understand", instruction: "Identify the file's purpose" })),
  }, files);

  const response = await request.post("/api/v1/detections", body);
  expect(response.status()).toBe(200);
  const responseText = await response.text();
  expect(responseText).not.toContain("att_");
  const report = JSON.parse(responseText);
  expect(report.request.attachments).toEqual(names.map((name) => ({ name, mode: "understand" })));
  expect(report.attachment_analysis).toMatchObject({
    requested: true,
    scored: false,
    affects_primary_score: false,
    recognition_status: "recognized",
    recognition_total: names.length,
    recognized_count: names.length,
    completed: names.length,
    total: names.length,
  });
  expect(report.attachment_analysis.items).toEqual(names.map((name) => expect.objectContaining({
    attachment_id: name,
    name,
    status: "completed",
    recognition_status: "recognized",
    recognition_reason: "model_returned_grounded_attachment_observation",
    delivery_mode: "extracted",
  })));

  const database = new Database(path.join(process.env.E2E_DATA_DIR || "", "kangkang.sqlite"), { readonly: true });
  const placeholders = names.map(() => "?").join(", ");
  const stored = database.prepare(
    `SELECT original_name, storage_path FROM attachments WHERE original_name IN (${placeholders})`,
  ).all(...names) as Array<{ original_name: string; storage_path: string }>;
  database.close();
  expect(stored).toHaveLength(names.length);
  expect(stored.map((item) => item.original_name).sort()).toEqual([...names].sort());
  expect(stored.every((item) => path.dirname(item.storage_path).startsWith(path.join(process.env.E2E_DATA_DIR || "", ".attachment-history")))).toBe(true);
  for (const item of stored) {
    expect(path.basename(item.storage_path)).toBe(item.original_name);
    expect(fs.existsSync(item.storage_path)).toBe(true);
    expect(fs.existsSync(path.join(process.env.E2E_DATA_DIR || "", "upload", item.original_name))).toBe(true);
  }
});

test("multipart detection sends inferred PNG input to the model as native Base64", async ({ request }) => {
  const imageBytes = Buffer.from("one-step-native-image-fixture", "utf8");
  upstreamRequestBodies.length = 0;
  const body = multipartDetectionBody({
    base_url: upstreamUrl,
    upstream_api_key: "e2e-upstream-key",
    model: "e2e-image-understanding-model",
    protocol: "openai-chat",
    rounds: 1,
    checks: { cache: false, live_knowledge: false },
    attachments: [{ mode: "understand", instruction: "Identify the image intent" }],
  }, [{
    name: "intent-diagram.png",
    mimeType: "application/octet-stream",
    buffer: imageBytes,
  }]);

  const response = await request.post("/api/v1/detections", body);
  expect(response.status()).toBe(200);
  const responseText = await response.text();
  expect(responseText).not.toContain("att_");
  const report = JSON.parse(responseText);
  expect(report.attachment_analysis.items[0]).toMatchObject({
    attachment_id: "intent-diagram.png",
    name: "intent-diagram.png",
    status: "completed",
    delivery_mode: "native",
    coverage_percent: 100,
  });
  const expectedDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
  expect(upstreamRequestBodies.some((requestBody) => requestBody.includes(expectedDataUrl))).toBe(true);
});

test("attachment analysis reports the actual visual fallback model", async ({ request }) => {
  upstreamRequestBodies.length = 0;
  upstreamRequestRoutes.length = 0;
  const body = multipartDetectionBody({
    base_url: upstreamUrl,
    upstream_api_key: "e2e-upstream-key",
    model: "e2e-text-only-model",
    protocol: "anthropic",
    rounds: 1,
    checks: { cache: false, live_knowledge: false },
    attachments: [{ mode: "understand", instruction: "Identify the image intent" }],
  }, [{
    name: "fallback-artwork.png",
    mimeType: "image/png",
    buffer: Buffer.from("one-step-native-image-fixture", "utf8"),
  }]);

  const response = await request.post("/api/v1/web/attachment-analysis", body);
  expect(response.status()).toBe(200);
  const report = (await response.json()).attachment_analysis;
  expect(report).toMatchObject({
    status: "completed",
    recognition_status: "recognized",
    recognition_total: 1,
    recognized_count: 1,
    completed: 1,
    total: 1,
  });
  expect(report.items[0]).toMatchObject({
    name: "fallback-artwork.png",
    requested_model: "e2e-text-only-model",
    analysis_model: "e2e-vision-model",
    model_fallback: true,
    model_fallback_reason: "selected_model_did_not_observe_attachment",
    requested_protocol: "anthropic",
    analysis_protocol: "openai-chat",
    protocol_fallback: true,
    protocol_fallback_reason: "visual_route_did_not_observe_attachment",
    analysis_attempts: 5,
    status: "completed",
    recognition_status: "recognized",
    recognition_reason: "model_returned_grounded_attachment_observation",
    delivery_mode: "native",
  });
  const attachmentRequests = upstreamRequestBodies
    .map((requestBody, index) => ({ body: requestBody, route: upstreamRequestRoutes[index] }));
  expect(attachmentRequests.map((item) => ({ route: item.route, model: JSON.parse(item.body).model }))).toEqual([
    { route: "/v1/messages", model: "e2e-text-only-model" },
    { route: "/v1/messages", model: "e2e-vision-model" },
    { route: "/v1/messages", model: "e2e-vision-model" },
    { route: "/v1/messages", model: "e2e-vision-model" },
    { route: "/v1/chat/completions", model: "e2e-vision-model" },
  ]);
});

test("trusted Web sessions isolate attachments and preserve UTF-8 filenames", async ({ baseURL }) => {
  const ownerA = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: trustedWebHeaders("203.0.113.10"),
  });
  const ownerB = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: trustedWebHeaders("203.0.113.11"),
  });
  try {
    const uploaded = await ownerA.post("/api/v1/web/attachment-analysis", multipartDetectionBody({
      base_url: upstreamUrl,
      upstream_api_key: "isolated-owner-key",
      model: "e2e-code-model",
      protocol: "openai-chat",
      rounds: 1,
      checks: { cache: false, live_knowledge: false },
      attachments: [{ mode: "understand" }],
    }, [{
      name: "任意附件.未知",
      mimeType: "application/x-unrestricted",
      buffer: Buffer.from([0, 255, 7, 8, 9]),
    }]));
    expect(uploaded.status()).toBe(200);
    expect(uploaded.headers()["set-cookie"]).toContain("kk_web_session=");
    const body = await uploaded.json();
    expect(body.attachments[0]).toMatchObject({ name: "任意附件.未知" });

    const attachmentId = body.attachments[0].id;
    expect((await ownerB.delete(`/api/v1/web/attachments/${attachmentId}`)).status()).toBe(404);
    expect((await ownerA.delete(`/api/v1/web/attachments/${attachmentId}`)).status()).toBe(200);
  } finally {
    await ownerA.dispose();
    await ownerB.dispose();
  }
});

test("trusted Web sessions isolate history, clearing, and retesting", async ({ baseURL }) => {
  const ownerA = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: trustedWebHeaders("203.0.113.20"),
  });
  const ownerB = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: trustedWebHeaders("203.0.113.21"),
  });
  try {
    await ownerA.get("/api/v1/web/history");
    await ownerB.get("/api/v1/web/history");
    const created = await ownerA.post("/api/v1/web/history", {
      data: {
        request: {
          base_url: upstreamUrl,
          upstream_api_key: "isolated-owner-key",
          model: "gpt-image-2",
          protocol: "openai-images",
          rounds: 1,
          checks: { cache: false, cache_runs: 1, live_knowledge: false },
        },
        result: {
          id: "#OWNER-A",
          status: "completed",
          score: 77,
          kind: "image",
          authenticity: {
            verdict: "unverifiable",
            evidenceLevel: "insufficient",
            reason: "insufficient-evidence",
            verifierScope: "quality-only",
          },
          checks: [],
        },
      },
    });
    expect(created.status()).toBe(201);
    const runId = (await created.json()).item.storageId;

    expect((await ownerA.get("/api/v1/web/history")).json()).resolves.toMatchObject({
      items: [expect.objectContaining({ storageId: runId, model: "gpt-image-2" })],
    });
    expect((await ownerB.get("/api/v1/web/history")).json()).resolves.toMatchObject({ items: [] });
    expect((await ownerB.post(`/api/v1/web/history/${runId}/retry`)).status()).toBe(404);
    expect((await ownerB.delete("/api/v1/web/history")).status()).toBe(200);
    expect((await ownerA.get("/api/v1/web/history")).json()).resolves.toMatchObject({
      items: [expect.objectContaining({ storageId: runId })],
    });

    const publicDetection = await ownerA.post("/api/v1/detections", { data: {} });
    expect(publicDetection.status()).toBe(503);
    expect(await publicDetection.json()).toMatchObject({ error: { code: "detector_api_not_configured" } });
    await ownerA.delete("/api/v1/web/history");
  } finally {
    await ownerA.dispose();
    await ownerB.dispose();
  }
});

test("installation reports update the web counter over SSE", async ({ page, request }) => {
  const before = await request.get("/api/v1/installations/stats").then((response) => response.json());
  await page.goto("/");
  const counter = page.locator('[title="客户端安装上报"]');
  await expect(counter).toContainText(String(before.total));

  const headers = { "idempotency-key": `relayapi-e2e-${Date.now()}` };
  const report = await request.post("/api/v1/installations/report", { headers });
  const replay = await request.post("/api/v1/installations/report", { headers });
  expect(report.status()).toBe(204);
  expect(replay.status()).toBe(204);
  await expect(counter).toContainText(String(before.total + 1));
});

test("SQLite history hides the key and supports one-click retesting", async ({ page, request }) => {
  const upstreamKey = "e2e-history-key-must-never-be-displayed";
  await request.delete("/api/v1/web/history");
  const created = await request.post("/api/v1/web/history", {
    data: {
      request: {
        base_url: upstreamUrl,
        upstream_api_key: upstreamKey,
        model: "gpt-image-2",
        protocol: "openai-images",
        rounds: 1,
        checks: { cache: false, cache_runs: 1, live_knowledge: false },
      },
      result: {
        id: "#E2E-STORED",
        status: "completed",
        score: 88,
        kind: "image",
        authenticity: {
          verdict: "unverifiable",
          evidenceLevel: "insufficient",
          reason: "insufficient-evidence",
          verifierScope: "quality-only",
        },
        checks: [],
      },
    },
  });
  expect(created.status()).toBe(201);
  expect(await created.text()).not.toContain(upstreamKey);

  await page.goto("/");
  const storedRow = page.getByRole("button").filter({ hasText: "gpt-image-2" }).first();
  await expect(storedRow).toBeVisible();
  await storedRow.click();
  await page.getByRole("button", { name: "一键复测" }).click();
  await expect(page.getByText("复测", { exact: true })).toBeVisible();
  await expect(page.getByText(upstreamKey, { exact: true })).toHaveCount(0);

  const historyResponse = await request.get("/api/v1/web/history");
  const historyText = await historyResponse.text();
  expect(historyText).not.toContain(upstreamKey);
  const history = JSON.parse(historyText);
  expect(history.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "web", model: "gpt-image-2", score: 88 }),
    expect.objectContaining({ source: "retest", model: "gpt-image-2", score: 100 }),
  ]));

  const databasePath = path.join(process.env.E2E_DATA_DIR || "", "kangkang.sqlite");
  expect(fs.existsSync(databasePath), `Expected E2E database at ${databasePath}`).toBe(true);
  const database = new Database(databasePath, { readonly: true });
  const encryptedRequests = database.prepare("SELECT request_ciphertext FROM detection_runs").all();
  database.close();
  expect(JSON.stringify(encryptedRequests)).not.toContain(upstreamKey);
});
