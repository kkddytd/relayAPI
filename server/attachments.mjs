import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Busboy from "busboy";
import { attachmentBasename } from "./storage.mjs";

export function attachmentViewUrl(value) {
  const name = attachmentBasename(value);
  return `/upload/${encodeURIComponent(name)}`;
}

function removeArtifact(filePath) {
  try {
    fs.rmSync(filePath, { force: true, recursive: true });
  } catch {
    // An incomplete upload is already unusable without its database row.
  }
}

export function receiveAttachmentUpload(req, { storage, ownerScope, signal } = {}) {
  return receiveAttachmentUploadInternal(req, { storage, ownerScope, signal }).then((result) => result.records);
}

export function receiveAttachmentUploadWithFields(req, { storage, ownerScope, signal } = {}) {
  return receiveAttachmentUploadInternal(req, { storage, ownerScope, signal });
}

function receiveAttachmentUploadInternal(req, { storage, ownerScope, signal } = {}) {
  if (!storage) throw new Error("attachment_storage_required");
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: req.headers, defParamCharset: "utf8" });
    } catch {
      reject(Object.assign(new Error("invalid_multipart_request"), { code: "invalid_multipart_request" }));
      return;
    }

    const pending = [];
    const artifacts = [];
    const records = [];
    const fields = {};
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      for (const filePath of artifacts) removeArtifact(filePath);
      reject(error instanceof Error ? error : new Error("attachment_upload_failed"));
    };
    const onAbort = () => {
      parser.destroy(new Error("attachment_upload_aborted"));
      fail(Object.assign(new Error("attachment_upload_aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    parser.on("field", (name, value) => {
      fields[name] = value;
    });
    parser.on("file", (_fieldName, file, info) => {
      const id = `att_${randomUUID().replace(/-/g, "")}`;
      const originalName = attachmentBasename(typeof info?.filename === "string" && info.filename ? info.filename : "attachment");
      const historyDirectory = storage.attachmentHistoryDirectory || path.join(storage.dataDirectory, ".attachment-history");
      const artifactDirectory = path.join(historyDirectory, id);
      const storagePath = path.join(artifactDirectory, originalName);
      fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      // Track the private per-upload directory so aborted or failed multipart
      // requests cannot leave empty per-upload history entries behind.
      artifacts.push(artifactDirectory);
      const hash = createHash("sha256");
      let sizeBytes = 0;

      const completed = new Promise((resolveFile, rejectFile) => {
        const output = fs.createWriteStream(storagePath, { flags: "wx", mode: 0o600 });
        file.on("data", (chunk) => {
          hash.update(chunk);
          sizeBytes += chunk.length;
        });
        file.once("error", rejectFile);
        output.once("error", rejectFile);
        output.once("finish", () => {
          const record = {
            id,
            ownerScope: ownerScope || "local",
            originalName,
            mediaType: typeof info?.mimeType === "string" && info.mimeType ? info.mimeType : "application/octet-stream",
            storagePath,
            sizeBytes,
            sha256: hash.digest("hex"),
            createdAt: new Date().toISOString(),
          };
          records.push(record);
          resolveFile(record);
        });
        file.pipe(output);
      });
      pending.push(completed);
    });
    parser.once("error", fail);
    parser.once("finish", async () => {
      try {
        const records = await Promise.all(pending);
        if (records.length === 0) {
          fail(Object.assign(new Error("attachment_file_required"), { code: "attachment_file_required" }));
          return;
        }
        if (records.length > 0) {
          storage.createAttachments(records);
          try {
            storage.publishAttachments(records);
          } catch (error) {
            // A publish failure must roll back both SQLite rows and private
            // artifacts; callers should never receive an unusable attachment id.
            storage.deleteAttachments?.(records.map((record) => record.id), ownerScope || "local", { requireUnreferenced: false });
            throw error;
          }
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve({ records, fields });
      } catch (error) {
        fail(error);
      }
    });
    req.pipe(parser);
  });
}

export function publicAttachmentRecord(record) {
  const name = record.original_name ?? record.originalName;
  return {
    id: record.id,
    name,
    url: attachmentViewUrl(name),
    media_type: record.media_type ?? record.mediaType,
    size_bytes: record.size_bytes ?? record.sizeBytes,
    sha256: record.sha256,
    created_at: record.created_at ?? record.createdAt,
  };
}
