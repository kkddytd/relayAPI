import { expect, request as playwrightRequest, test } from "@playwright/test";

test("API reference is reachable from the shared navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("kk", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "接口说明" }).click();
  await expect(page).toHaveURL(/\/api-docs$/);
  await expect(page.getByRole("heading", { name: "接口说明" })).toBeVisible();
  await expect(page.getByText("POST /api/v1/detections", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /OpenAPI 3.1/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "缓存检测字段" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "实时知识字段" })).toBeVisible();
  await expect(page.getByText("live_knowledge.source_snapshot_fetched", { exact: true })).toBeVisible();
  await expect(page.getByText("live_knowledge.source_cache_status", { exact: true })).toBeVisible();
  await expect(page.getByText("live_knowledge.source_cache_age_seconds", { exact: true })).toBeVisible();
  await expect(page.getByText("live_knowledge.source_answers_sent_to_model", { exact: true })).toBeVisible();
  await expect(page.getByText("live_knowledge.reason", { exact: true })).toBeVisible();
  await expect(page.getByText(/Fable 的 Opus 4\.8 映射仅描述请求规模/)).toBeVisible();
  await expect(page.getByText(/每轮包含输入、输出、缓存创建\/读取/)).toBeVisible();
  await expect(page.getByText("scores.official_compatibility", { exact: true })).toBeVisible();
  await expect(page.getByText("scores.public_observable", { exact: true })).toBeVisible();
  await expect(page.getByText("scores.private_signature_adjustment", { exact: true })).toBeVisible();
  await expect(page.getByText("scores.signature_evidence_status", { exact: true })).toBeVisible();
  await expect(page.getByText("scores.private_signature_status", { exact: true })).toBeVisible();
  await expect(page.getByText("score", { exact: true })).toBeVisible();
  await expect(page.getByText("scores.primary_basis", { exact: true })).toBeVisible();
  await expect(page.getByText("scores.official_result", { exact: true })).toBeVisible();
  await expect(page.getByText("stage_identity", { exact: true })).toBeVisible();
  await expect(page.getByText("upstream_unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("cache.compatibility_score", { exact: true })).toBeVisible();
  await expect(page.getByText("checks.cache_runs", { exact: true })).toBeVisible();
  await expect(page.getByText("cache.requested_runs / completed_runs", { exact: true })).toBeVisible();
  await expect(page.getByText("cache.aggregation", { exact: true })).toBeVisible();
  await expect(page.getByText("cache.runs[]", { exact: true })).toBeVisible();
  await expect(page.getByText("cache.request_attempts", { exact: true })).toBeVisible();
  await expect(page.getByText("cache.request_profiles_used", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "附件检测" })).toBeVisible();
  await expect(page.getByText("上传附件并检测", { exact: true })).toBeVisible();
  await expect(page.getByText("POST /api/v1/attachments", { exact: true })).toHaveCount(0);
  await expect(page.getByText("attachments", { exact: true })).toBeVisible();
  await expect(page.getByText("attachment_analysis", { exact: true })).toBeVisible();
  await expect(page.getByText("POST /api/v1/installations/report", { exact: true })).toBeVisible();
  await expect(page.getByText("curl -X POST 'http://YOUR_SERVER_IP/api/v1/installations/report'", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "检测" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "开始检测" })).toBeVisible();
});

test("cache probing is explicitly opt-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("checkbox", { name: /启用提示缓存检测/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /启用 2026 实时知识检测/ })).not.toBeChecked();
});

test("public API metadata and validation routes return the documented shape", async ({ request }) => {
  const apiIndex = await request.get("/api/v1");
  expect(apiIndex.status()).toBe(200);
  await expect(apiIndex.json()).resolves.toMatchObject({
    ok: true,
    api_version: "v1",
    authentication: "localhost-only",
  });

  const models = await request.get("/api/v1/models");
  expect(models.status()).toBe(200);
  const modelCatalog = await models.json();
  expect(modelCatalog).toMatchObject({
    ok: true,
    api_version: "v1",
    custom_models_supported: true,
  });
  expect(modelCatalog.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "gpt-5.6-sol", profile_model: "gpt-5.6-sol", probe_family: "gpt-official", dedicated: true }),
    expect.objectContaining({ id: "claude-fable-5", profile_model: "claude-fable-5", probe_family: "claude-fable", dedicated: true, aliases: expect.arrayContaining(["claude-5-fable"]) }),
    expect.objectContaining({ id: "o3", probe_family: "gpt-quality", aliases: [] }),
  ]));

  const health = await request.get("/api/v1/health");
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toMatchObject({ ok: true, status: "ok", api_version: "v1" });
  expect(modelCatalog.items.every((item: { aliases?: unknown }) => Array.isArray(item.aliases))).toBe(true);

  const openapi = await request.get("/api/v1/openapi.json");
  expect(openapi.status()).toBe(200);
  const openapiDocument = await openapi.json();
  expect(openapiDocument).toMatchObject({
    openapi: "3.1.0",
    info: { title: "kk 模型检测 API" },
  });
  expect(openapiDocument.components.schemas.CacheReport.properties).toEqual(expect.objectContaining({
    compatibility_score: expect.any(Object),
    reference_weighted_tokens: expect.any(Object),
    measured_weighted_tokens: expect.any(Object),
    overall_multiplier: expect.any(Object),
    average_hit_rate: expect.any(Object),
    completed_rounds: expect.any(Object),
    logical_rounds: expect.any(Object),
    request_attempts: expect.any(Object),
    request_profiles_used: expect.any(Object),
    requested_runs: expect.any(Object),
    completed_runs: expect.any(Object),
    aggregation: expect.any(Object),
    runs: expect.any(Object),
  }));
  expect(openapiDocument.components.schemas.DetectionRequest.properties.checks.properties.cache_runs).toMatchObject({
    minimum: 1,
    maximum: 3,
    default: 1,
  });
  expect(openapiDocument.components.schemas.DetectionReport.properties.scores.properties).toEqual(expect.objectContaining({
    primary: expect.any(Object),
    official_compatibility: expect.any(Object),
    public_observable: expect.any(Object),
    private_signature_adjustment: expect.any(Object),
    private_signature_status: expect.any(Object),
    signature_evidence_status: expect.any(Object),
  }));
  expect(openapiDocument.paths).toEqual(expect.objectContaining({
    "/upload/{filename}": expect.any(Object),
    "/api/v1/attachments": expect.any(Object),
    "/api/v1/installations/report": expect.any(Object),
    "/api/v1/installations/stats": expect.any(Object),
    "/api/v1/installations/stream": expect.any(Object),
  }));
  expect(openapiDocument.components.schemas.AttachmentReference.properties.expected_intent.writeOnly).toBe(true);

  const invalid = await request.post("/api/v1/detections", {
    data: { base_url: "https://relay.example", model: "claude-fable-5" },
  });
  expect(invalid.status()).toBe(400);
  await expect(invalid.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });

  const proxiedWithoutDetectorKey = await request.post("/api/v1/detections", {
    headers: { "x-forwarded-for": "203.0.113.10" },
    data: {
      base_url: "https://relay.example",
      upstream_api_key: "sk-test-only",
      model: "claude-fable-5",
    },
  });
  expect(proxiedWithoutDetectorKey.status()).toBe(503);
  await expect(proxiedWithoutDetectorKey.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "detector_api_not_configured" },
  });
});

test("public Web sessions can open history but cannot call the detector API", async ({ baseURL }) => {
  const publicWeb = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": "203.0.113.90" },
  });
  try {
    const history = await publicWeb.get("/api/v1/web/history");
    expect(history.status()).toBe(200);
    expect(history.headers()["set-cookie"]).toContain("kk_web_session=");

    const detection = await publicWeb.post("/api/v1/detections", {
      data: {
        base_url: "https://relay.example",
        upstream_api_key: "sk-test-only",
        model: "claude-fable-5",
      },
    });
    expect(detection.status()).toBe(503);
    await expect(detection.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "detector_api_not_configured" },
    });
  } finally {
    await publicWeb.dispose();
  }
});

test("API documentation remains within the mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/api-docs");
  await expect(page.getByRole("heading", { name: "接口说明" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
});
