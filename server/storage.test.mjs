import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStorage, credentialFingerprint, sanitizeDisplayUrl } from "./storage.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kangkang-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}

function storeAttachment(storage, { id, ownerScope, createdAt = new Date().toISOString() }) {
  const directory = path.join(storage.attachmentsDirectory, id, "original");
  fs.mkdirSync(directory, { recursive: true });
  const storagePath = path.join(directory, "attachment");
  fs.writeFileSync(storagePath, id);
  storage.createAttachment({
    id,
    ownerScope,
    originalName: `${id}.bin`,
    mediaType: "application/octet-stream",
    storagePath,
    sizeBytes: Buffer.byteLength(id),
    sha256: "0".repeat(64),
    createdAt,
  });
  return storagePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local SQLite storage", () => {
  it("migrates existing history databases to owner-scoped records", () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = path.join(dataDirectory, "legacy.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE detection_runs (
        id TEXT PRIMARY KEY,
        report_id TEXT,
        source TEXT NOT NULL,
        parent_run_id TEXT,
        status TEXT NOT NULL,
        base_url_display TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        profile_model TEXT,
        protocol TEXT NOT NULL DEFAULT 'auto',
        request_ciphertext TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL DEFAULT '[]',
        score REAL,
        verdict TEXT,
        engine_version TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    legacy.close();

    const storage = createAppStorage({ dataDirectory, databasePath, encryptionKey: "migration-test-key" });
    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.prepare("PRAGMA table_info(detection_runs)").all().map((column) => column.name)).toContain("owner_scope");
    migrated.close();
    storage.close();
  });

  it("encrypts the complete retry request and never exposes credentials in public history", () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = path.join(dataDirectory, "history.sqlite");
    const storage = createAppStorage({
      dataDirectory,
      databasePath,
      encryptionKey: "storage-test-encryption-secret",
    });
    const upstreamKey = "upstream-key-that-must-stay-private";
    const detectorKey = "detector-key-that-must-not-be-stored-raw";
    const baseUrl = "https://user:pass@example.com/v1?api_key=query-secret#fragment";
    const request = {
      base_url: baseUrl,
      upstream_api_key: upstreamKey,
      model: "gpt-test",
      protocol: "openai-chat",
      attachments: [{ id: "att_0123456789abcdef0123456789abcdef", mode: "understand" }],
    };

    const runId = storage.createRun({ source: "api", request, reportId: "report-1" });
    storage.finishRun(runId, {
      status: "completed",
      report: { id: "report-1", status: "completed", score: 91, verdict: { value: "consistent" } },
    });
    storage.recordApiRequest({
      runId,
      route: "/api/v1/detections",
      method: "POST",
      statusCode: 200,
      durationMs: 25,
      detectorKeyFingerprint: credentialFingerprint(detectorKey),
    });

    const publicEntry = storage.getRunPublic(runId);
    expect(JSON.stringify(publicEntry)).not.toContain(upstreamKey);
    expect(JSON.stringify(publicEntry)).not.toContain("query-secret");
    expect(publicEntry.base_url_display).toBe("https://example.com/v1");
    expect(publicEntry.attachmentIds).toEqual(["att_0123456789abcdef0123456789abcdef"]);

    const retryEntry = storage.getRunForRetry(runId);
    expect(retryEntry.request).toEqual(request);

    const raw = new Database(databasePath, { readonly: true });
    const storedRun = raw.prepare("SELECT * FROM detection_runs WHERE id = ?").get(runId);
    const storedAudit = raw.prepare("SELECT * FROM api_request_audit WHERE run_id = ?").get(runId);
    expect(storedRun.request_ciphertext).not.toContain(upstreamKey);
    expect(storedRun.request_ciphertext).not.toContain(baseUrl);
    expect(storedRun.request_ciphertext).not.toContain("query-secret");
    expect(JSON.parse(storedRun.request_ciphertext)).toMatchObject({ v: 1 });
    expect(storedAudit.detector_key_fingerprint).toBe(credentialFingerprint(detectorKey));
    expect(storedAudit.detector_key_fingerprint).not.toBe(detectorKey);
    raw.close();

    expect(storage.clearRuns()).toBe(1);
    const auditAfterClear = new Database(databasePath, { readonly: true });
    expect(auditAfterClear.prepare("SELECT run_id FROM api_request_audit").get().run_id).toBeNull();
    auditAfterClear.close();
    storage.close();
  });

  it("requires the same encryption key to retest persisted history", () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = path.join(dataDirectory, "history.sqlite");
    const first = createAppStorage({ dataDirectory, databasePath, encryptionKey: "first-key" });
    const runId = first.createRun({
      source: "web",
      request: { base_url: "https://example.com", upstream_api_key: "secret", model: "gpt-test" },
    });
    first.close();

    const second = createAppStorage({ dataDirectory, databasePath, encryptionKey: "different-key" });
    expect(() => second.getRunForRetry(runId)).toThrow();
    second.close();
  });

  it("isolates history and attachment lifecycle by owner scope", () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "owner-scope-test-key" });
    const attachmentA = "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const attachmentB = "att_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const attachmentAPath = storeAttachment(storage, { id: attachmentA, ownerScope: "web:owner-a" });
    storeAttachment(storage, {
      id: attachmentB,
      ownerScope: "web:owner-b",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const runA = storage.createRun({
      source: "web",
      ownerScope: "web:owner-a",
      request: {
        base_url: "https://a.example",
        upstream_api_key: "owner-a-key",
        model: "gpt-test",
        attachments: [{ id: attachmentA, mode: "understand" }],
      },
    });
    storage.createRun({
      source: "web",
      ownerScope: "web:owner-b",
      request: { base_url: "https://b.example", upstream_api_key: "owner-b-key", model: "gpt-test" },
    });

    expect(storage.listRuns({ ownerScope: "web:owner-a" }).map((row) => row.id)).toEqual([runA]);
    expect(storage.getRunForRetry(runA, "web:owner-b")).toBeNull();
    expect(storage.getAttachment(attachmentA, "web:owner-b")).toBeNull();
    expect(storage.deleteAttachment(attachmentA, "web:owner-a")).toMatchObject({
      deleted: false,
      reason: "attachment_in_use",
    });

    expect(storage.clearRuns("web:owner-b")).toBe(1);
    expect(storage.getRunPublic(runA, "web:owner-a")).not.toBeNull();
    expect(storage.pruneUnreferencedAttachments({
      ownerScope: "web:owner-b",
      olderThan: new Date(),
    })).toBe(1);
    expect(storage.getAttachment(attachmentB, "web:owner-b")).toBeNull();

    expect(storage.clearRuns("web:owner-a")).toBe(1);
    expect(storage.deleteAttachment(attachmentA, "web:owner-a")).toMatchObject({ deleted: true });
    expect(fs.existsSync(attachmentAPath)).toBe(false);
    storage.close();
  });

  it("keeps legacy nested attachment artifacts readable and deletable", () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "legacy-attachment-test-key" });
    const id = "att_cccccccccccccccccccccccccccccccc";
    const legacyDirectory = path.join(storage.legacyAttachmentsDirectory, id, "original");
    const legacyPath = path.join(legacyDirectory, "attachment");
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(legacyPath, "legacy attachment contents");
    storage.createAttachment({
      id,
      ownerScope: "local",
      originalName: "legacy.txt",
      mediaType: "text/plain",
      storagePath: legacyPath,
      sizeBytes: fs.statSync(legacyPath).size,
      sha256: "c".repeat(64),
      createdAt: new Date().toISOString(),
    });

    expect(fs.readFileSync(storage.getAttachment(id).storage_path, "utf8")).toBe("legacy attachment contents");
    expect(storage.deleteAttachment(id)).toMatchObject({ deleted: true });
    expect(fs.existsSync(path.join(storage.legacyAttachmentsDirectory, id))).toBe(false);
    storage.close();
  });

  it("migrates random root storage names and publishes the newest file under its original name", () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = path.join(dataDirectory, "history.sqlite");
    const first = createAppStorage({ dataDirectory, databasePath, encryptionKey: "layout-migration-key" });
    const fixtures = [
      {
        id: "att_dddddddddddddddddddddddddddddddd",
        storageName: "20260718010000-random-one.png",
        content: "older image",
        createdAt: "2026-07-18T01:00:00.000Z",
      },
      {
        id: "att_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        storageName: "20260718020000-random-two.png",
        content: "newer image",
        createdAt: "2026-07-18T02:00:00.000Z",
      },
    ];
    for (const fixture of fixtures) {
      const storagePath = path.join(first.uploadDirectory, fixture.storageName);
      fs.writeFileSync(storagePath, fixture.content);
      first.createAttachment({
        id: fixture.id,
        ownerScope: "local",
        originalName: "generated-003.png",
        mediaType: "image/png",
        storagePath,
        sizeBytes: Buffer.byteLength(fixture.content),
        sha256: createHash("sha256").update(fixture.content).digest("hex"),
        createdAt: fixture.createdAt,
      });
    }
    first.close();

    const reopened = createAppStorage({ dataDirectory, databasePath, encryptionKey: "layout-migration-key" });
    try {
      for (const fixture of fixtures) {
        expect(fs.existsSync(path.join(reopened.uploadDirectory, fixture.storageName))).toBe(false);
        const row = reopened.getAttachment(fixture.id);
        expect(path.dirname(row.storage_path)).toContain(reopened.attachmentHistoryDirectory);
        expect(path.basename(row.storage_path)).toBe("generated-003.png");
        expect(fs.readFileSync(row.storage_path, "utf8")).toBe(fixture.content);
      }
      expect(fs.readFileSync(path.join(reopened.uploadDirectory, "generated-003.png"), "utf8")).toBe("newer image");
    } finally {
      reopened.close();
    }
  });
});

describe("history display sanitization", () => {
  it("removes embedded credentials, query parameters, and fragments", () => {
    expect(sanitizeDisplayUrl("https://name:pass@example.com/v1?key=secret#part")).toBe("https://example.com/v1");
  });
});
