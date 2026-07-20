import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  publicAttachmentRecord,
  receiveAttachmentUpload,
  receiveAttachmentUploadWithFields,
} from "./attachments.mjs";
import { createAppStorage } from "./storage.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kangkang-attachments-"));
  temporaryDirectories.push(directory);
  return directory;
}

function multipartRequest(files, fields = {}) {
  const boundary = "----kangkang-arbitrary-upload-boundary";
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n`,
    ));
    chunks.push(file.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const request = Readable.from(body);
  request.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length),
  };
  return request;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("arbitrary attachment uploads", () => {
  it("streams unknown binary types without extension or content validation", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "attachment-test-key" });
    const binary = Buffer.from([0, 255, 17, 34, 0, 128, 65, 66, 67, 10]);
      const second = Buffer.from("plain bytes are accepted too", "utf8");
    try {
      const records = await receiveAttachmentUpload(multipartRequest([
        { name: "payload.unknown-extension", type: "application/x-anything", content: binary },
        { name: "任意附件.未知", type: "application/octet-stream", content: second },
      ]), { storage, ownerScope: "api:test-owner" });

      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        ownerScope: "api:test-owner",
        originalName: "payload.unknown-extension",
        mediaType: "application/x-anything",
        sizeBytes: binary.length,
      });
      expect(fs.readFileSync(records[0].storagePath)).toEqual(binary);
      expect(fs.readFileSync(records[1].storagePath)).toEqual(second);
      expect(records[1].originalName).toBe("任意附件.未知");
      expect(path.basename(records[0].storagePath)).toBe(records[0].originalName);
      expect(path.basename(records[1].storagePath)).toBe(records[1].originalName);
      expect(path.dirname(records[0].storagePath)).toContain(storage.attachmentHistoryDirectory);
      expect(path.dirname(records[1].storagePath)).toContain(storage.attachmentHistoryDirectory);
      expect(fs.readFileSync(path.join(storage.uploadDirectory, records[0].originalName))).toEqual(binary);
      expect(fs.readFileSync(path.join(storage.uploadDirectory, records[1].originalName))).toEqual(second);
      expect(publicAttachmentRecord(records[0])).toEqual(expect.objectContaining({
        id: records[0].id,
        name: "payload.unknown-extension",
        url: "/upload/payload.unknown-extension",
        size_bytes: binary.length,
      }));
    } finally {
      storage.close();
    }
  });

  it("rejects only a multipart request that contains no file", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "attachment-test-key" });
    try {
      await expect(receiveAttachmentUpload(multipartRequest([]), { storage, ownerScope: "local" }))
        .rejects.toThrow("attachment_file_required");
      expect(fs.readdirSync(storage.attachmentsDirectory)).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it("returns multipart metadata alongside files without trusting caller attachment IDs", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "attachment-test-key" });
    const callerId = "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const requestMetadata = JSON.stringify({
      model: "gpt-test",
      attachments: [{ id: callerId, mode: "understand", instruction: "Explain this code" }],
    });
    try {
      const uploaded = await receiveAttachmentUploadWithFields(multipartRequest([
        {
          name: "worker.py",
          type: "application/octet-stream",
          content: Buffer.from("def run():\n    return 'ready'\n"),
        },
      ], { request: requestMetadata }), { storage, ownerScope: "local" });

      expect(uploaded.fields).toEqual({ request: requestMetadata });
      expect(uploaded.records).toHaveLength(1);
      expect(uploaded.records[0].id).toMatch(/^att_[a-f0-9]{32}$/);
      expect(uploaded.records[0].id).not.toBe(callerId);
      expect(path.basename(uploaded.records[0].storagePath)).toBe("worker.py");
      expect(fs.readFileSync(path.join(storage.uploadDirectory, "worker.py"), "utf8")).toContain("def run()");
      expect(fs.readFileSync(uploaded.records[0].storagePath, "utf8")).toContain("def run()");
    } finally {
      storage.close();
    }
  });

  it("rolls back every database row and directory when a multi-file insert fails", async () => {
    const dataDirectory = temporaryDirectory();
    const baseStorage = createAppStorage({ dataDirectory, encryptionKey: "attachment-test-key" });
    const storage = {
      ...baseStorage,
      createAttachments(records) {
        return baseStorage.createAttachments([
          records[0],
          { ...records[1], id: records[0].id },
        ]);
      },
    };
    try {
      await expect(receiveAttachmentUpload(multipartRequest([
        { name: "first.bin", type: "application/octet-stream", content: Buffer.from("first") },
        { name: "second.bin", type: "application/octet-stream", content: Buffer.from("second") },
      ]), { storage, ownerScope: "local" })).rejects.toThrow();

      expect(fs.readdirSync(baseStorage.attachmentsDirectory)).toEqual([]);
      expect(fs.readdirSync(baseStorage.attachmentHistoryDirectory)).toEqual([]);
      const database = new Database(baseStorage.databasePath, { readonly: true });
      expect(database.prepare("SELECT count(*) AS count FROM attachments").get().count).toBe(0);
      database.close();
    } finally {
      baseStorage.close();
    }
  });

  it("keeps duplicate original names independent while publishing the newest root file", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "attachment-test-key" });
    try {
      const first = await receiveAttachmentUpload(multipartRequest([
        { name: "same.js", type: "text/javascript", content: Buffer.from("first") },
      ]), { storage, ownerScope: "local" });
      const second = await receiveAttachmentUpload(multipartRequest([
        { name: "same.js", type: "text/javascript", content: Buffer.from("second") },
      ]), { storage, ownerScope: "local" });

      expect(first[0].storagePath).not.toBe(second[0].storagePath);
      expect(path.basename(first[0].storagePath)).toBe("same.js");
      expect(path.basename(second[0].storagePath)).toBe("same.js");
      expect(fs.readFileSync(first[0].storagePath, "utf8")).toBe("first");
      expect(fs.readFileSync(second[0].storagePath, "utf8")).toBe("second");
      expect(fs.readFileSync(path.join(storage.uploadDirectory, "same.js"), "utf8")).toBe("second");

      expect(storage.deleteAttachment(first[0].id)).toMatchObject({ deleted: true });
      expect(fs.existsSync(first[0].storagePath)).toBe(false);
      expect(fs.readFileSync(path.join(storage.uploadDirectory, "same.js"), "utf8")).toBe("second");
      expect(fs.existsSync(second[0].storagePath)).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("preserves a filename that matches the former hidden-directory name", async () => {
    const dataDirectory = temporaryDirectory();
    const storage = createAppStorage({ dataDirectory, encryptionKey: "attachment-test-key" });
    try {
      const [record] = await receiveAttachmentUpload(multipartRequest([
        { name: ".history", type: "text/plain", content: Buffer.from("exact hidden-style filename") },
      ]), { storage, ownerScope: "local" });

      expect(record.originalName).toBe(".history");
      expect(path.basename(record.storagePath)).toBe(".history");
      expect(fs.readFileSync(path.join(storage.uploadDirectory, ".history"), "utf8")).toBe("exact hidden-style filename");
      expect(path.dirname(record.storagePath)).toContain(storage.attachmentHistoryDirectory);
    } finally {
      storage.close();
    }
  });
});
