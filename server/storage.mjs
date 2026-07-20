import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { HISTORY_ENCRYPTION_KEY } from "./constants.mjs";

const ENCRYPTION_VERSION = 1;

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Some mounted filesystems do not expose POSIX permissions.
  }
}

function normalizeConfiguredKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "")) {
      return decoded;
    }
  } catch {
    // Fall back to deriving a fixed-length key from the configured secret.
  }
  return createHash("sha256").update(raw).digest();
}

function loadEncryptionKey(configuredKey) {
  const explicit = normalizeConfiguredKey(configuredKey);
  if (explicit) return explicit;
  if (!String(process.env.HISTORY_ENCRYPTION_KEY || "").trim()) {
    process.env.HISTORY_ENCRYPTION_KEY = HISTORY_ENCRYPTION_KEY;
  }
  const environment = normalizeConfiguredKey(process.env.HISTORY_ENCRYPTION_KEY);
  if (environment) return environment;
  return normalizeConfiguredKey(HISTORY_ENCRYPTION_KEY);
}

function encryptJson(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: ENCRYPTION_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

function decryptJson(value, key) {
  const envelope = JSON.parse(value);
  if (envelope?.v !== ENCRYPTION_VERSION) throw new Error("unsupported_history_encryption_version");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function sanitizeDisplayUrl(raw) {
  try {
    const value = String(raw || "").trim();
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function credentialFingerprint(value) {
  const normalized = String(value || "").trim();
  return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}

// Keep the user's basename intact while preventing multipart path components
// from escaping the upload directory.  A path can never contain a NUL byte,
// so use the same neutral fallback for an empty or otherwise unusable name.
export function attachmentBasename(value) {
  const normalized = String(value || "attachment").replace(/\\/g, "/");
  const basename = path.basename(normalized);
  return basename && basename !== "." && basename !== ".." && !basename.includes("\0")
    ? basename
    : "attachment";
}

export function createAppStorage({ rootDirectory, dataDirectory, databasePath: configuredDatabasePath, encryptionKey } = {}) {
  const root = path.resolve(rootDirectory || process.cwd());
  const dataDir = path.resolve(dataDirectory || process.env.DATA_DIR || path.join(root, "data"));
  ensurePrivateDirectory(dataDir);
  const attachmentsDirectory = path.join(dataDir, "upload");
  const attachmentHistoryDirectory = path.join(dataDir, ".attachment-history");
  const legacyAttachmentsDirectory = path.join(dataDir, "attachments");
  ensurePrivateDirectory(attachmentsDirectory);
  ensurePrivateDirectory(attachmentHistoryDirectory);
  // Keep the previous directory readable so existing history remains retestable.
  ensurePrivateDirectory(legacyAttachmentsDirectory);

  const key = loadEncryptionKey(encryptionKey);
  const databasePath = path.resolve(configuredDatabasePath || process.env.SQLITE_PATH || path.join(dataDir, "kangkang.sqlite"));
  ensurePrivateDirectory(path.dirname(databasePath));
  const db = new Database(databasePath);
  try {
    fs.chmodSync(databasePath, 0o600);
  } catch {
    // Ignore permission changes unsupported by the current filesystem.
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS detection_runs (
      id TEXT PRIMARY KEY,
      report_id TEXT,
      source TEXT NOT NULL,
      owner_scope TEXT NOT NULL DEFAULT 'local',
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
      completed_at TEXT,
      FOREIGN KEY(parent_run_id) REFERENCES detection_runs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS detection_runs_created_at_idx
      ON detection_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS detection_runs_source_idx
      ON detection_runs(source, created_at DESC);

    CREATE TABLE IF NOT EXISTS api_request_audit (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      route TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      error_code TEXT,
      duration_ms INTEGER NOT NULL,
      detector_key_fingerprint TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES detection_runs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS api_request_audit_created_at_idx
      ON api_request_audit(created_at DESC);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      original_name TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      storage_path TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS attachments_created_at_idx
      ON attachments(created_at DESC);
  `);
  const runColumns = new Set(db.prepare("PRAGMA table_info(detection_runs)").all().map((column) => column.name));
  if (!runColumns.has("owner_scope")) {
    db.exec("ALTER TABLE detection_runs ADD COLUMN owner_scope TEXT NOT NULL DEFAULT 'local'");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS detection_runs_owner_created_at_idx
      ON detection_runs(owner_scope, created_at DESC);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(1, new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(2, new Date().toISOString());

  const insertRun = db.prepare(`
    INSERT INTO detection_runs (
      id, report_id, source, owner_scope, parent_run_id, status, base_url_display, model,
      profile_model, protocol, request_ciphertext, attachment_ids_json, created_at
    ) VALUES (
      @id, @reportId, @source, @ownerScope, @parentRunId, @status, @baseUrlDisplay, @model,
      @profileModel, @protocol, @requestCiphertext, @attachmentIdsJson, @createdAt
    )
  `);
  const updateRun = db.prepare(`
    UPDATE detection_runs SET
      report_id = COALESCE(@reportId, report_id),
      status = @status,
      score = @score,
      verdict = @verdict,
      engine_version = @engineVersion,
      result_json = @resultJson,
      error_code = @errorCode,
      error_message = @errorMessage,
      completed_at = @completedAt
    WHERE id = @id
  `);
  const insertAudit = db.prepare(`
    INSERT INTO api_request_audit (
      id, run_id, route, method, status_code, error_code, duration_ms,
      detector_key_fingerprint, created_at
    ) VALUES (
      @id, @runId, @route, @method, @statusCode, @errorCode, @durationMs,
      @detectorKeyFingerprint, @createdAt
    )
  `);
  const insertAttachment = db.prepare(`
    INSERT INTO attachments (
      id, owner_scope, original_name, media_type, storage_path, size_bytes, sha256, created_at
    ) VALUES (
      @id, @ownerScope, @originalName, @mediaType, @storagePath, @sizeBytes, @sha256, @createdAt
    )
  `);
  const insertAttachments = db.transaction((records) => {
    for (const record of records) insertAttachment.run(record);
  });
  const deleteAttachmentRow = db.prepare("DELETE FROM attachments WHERE id = ?");
  const updateAttachmentStoragePath = db.prepare("UPDATE attachments SET storage_path = ? WHERE id = ?");

  function runAttachmentIds(ownerScope = null) {
    const rows = ownerScope
      ? db.prepare("SELECT attachment_ids_json FROM detection_runs WHERE owner_scope = ?").all(ownerScope)
      : db.prepare("SELECT attachment_ids_json FROM detection_runs").all();
    return new Set(rows.flatMap((row) => parseJson(row.attachment_ids_json, [])).filter(Boolean));
  }

  function attachmentArtifact(row) {
    const storagePath = path.resolve(row.storage_path);
    const historyBase = path.resolve(attachmentHistoryDirectory);
    const historyRelative = path.relative(historyBase, storagePath);
    if (historyRelative && historyRelative !== ".." && !historyRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(historyRelative)) {
      const [historyId] = historyRelative.split(path.sep);
      if (!historyId || historyId === "." || historyId === "..") throw new Error("unsafe_attachment_storage_path");
      // Never remove the history root itself: one attachment owns one child.
      return path.join(historyBase, historyId);
    }
    for (const base of [attachmentsDirectory, legacyAttachmentsDirectory]) {
      const resolvedBase = path.resolve(base);
      const relative = path.relative(resolvedBase, storagePath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const [topLevelEntry] = relative.split(path.sep);
      return path.dirname(storagePath) === resolvedBase
        ? storagePath
        : path.join(resolvedBase, topLevelEntry);
    }
    throw new Error("unsafe_attachment_storage_path");
  }

  function attachmentVisiblePath(row) {
    return path.join(attachmentsDirectory, attachmentBasename(row.original_name ?? row.originalName));
  }

  function sha256File(filePath) {
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
  }

  function fileMatchesRecord(filePath, row, sourcePath = null) {
    try {
      const candidate = fs.statSync(filePath);
      if (!candidate.isFile()) return false;
      if (sourcePath) {
        try {
          const source = fs.statSync(sourcePath);
          if (candidate.dev === source.dev && candidate.ino === source.ino) return true;
        } catch {
          // A previous cleanup may have removed the private source. The
          // immutable size/hash metadata is still sufficient for a copy.
        }
      }
      if (Number(candidate.size) !== Number(row.size_bytes ?? row.sizeBytes)) return false;
      return sha256File(filePath) === String(row.sha256 || "");
    } catch {
      return false;
    }
  }

  function hasNewerSameNameAttachment(row) {
    const name = attachmentBasename(row.original_name ?? row.originalName);
    const newer = db.prepare("SELECT 1 FROM attachments WHERE original_name = ? AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1")
      .get(name, row.created_at ?? row.createdAt, row.created_at ?? row.createdAt, row.id);
    return Boolean(newer);
  }

  function cleanupAttachmentArtifact(row, { allowVisibleCleanup = !hasNewerSameNameAttachment(row) } = {}) {
    const storagePath = path.resolve(row.storage_path ?? row.storagePath);
    const visiblePath = attachmentVisiblePath(row);
    // A same-name upload may have replaced the public file already. Only
    // remove it when it is still this record's hardlink/copy.
    if (allowVisibleCleanup && fileMatchesRecord(visiblePath, row, storagePath)) fs.rmSync(visiblePath, { force: true });
    const artifact = attachmentArtifact({ ...row, storage_path: storagePath });
    fs.rmSync(artifact, { recursive: true, force: true });
  }

  function publishAttachment(record) {
    const sourcePath = path.resolve(record.storagePath ?? record.storage_path);
    const visiblePath = attachmentVisiblePath(record);
    const temporaryPath = path.join(attachmentsDirectory, `.publish-${record.id}-${randomUUID()}`);
    try {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
      try {
        fs.linkSync(sourcePath, temporaryPath);
      } catch {
        // Hard links are preferred; copy is the portable fallback.
        fs.copyFileSync(sourcePath, temporaryPath);
      }
      // rename replaces an existing regular file atomically on the target
      // filesystem, so concurrent same-name uploads never expose a partial file.
      fs.renameSync(temporaryPath, visiblePath);
      return visiblePath;
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  function publishLatestVisibleAttachment(originalName) {
    const latest = db.prepare("SELECT * FROM attachments WHERE original_name = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(attachmentBasename(originalName));
    if (latest && fs.existsSync(latest.storage_path)) publishAttachment(latest);
  }

  function migrateStoredAttachmentLayout() {
    const uploadRoot = path.resolve(attachmentsDirectory);
    const directRows = db.prepare("SELECT * FROM attachments ORDER BY created_at, id").all()
      .filter((row) => path.dirname(path.resolve(row.storage_path)) === uploadRoot);
    for (const row of directRows) {
      const sourcePath = path.resolve(row.storage_path);
      if (!fs.existsSync(sourcePath)) continue;
      const historyDirectory = path.join(attachmentHistoryDirectory, row.id);
      const historyPath = path.join(historyDirectory, attachmentBasename(row.original_name));
      fs.mkdirSync(historyDirectory, { recursive: true, mode: 0o700 });
      try {
        try {
          fs.linkSync(sourcePath, historyPath);
        } catch {
          fs.copyFileSync(sourcePath, historyPath, fs.constants.COPYFILE_EXCL);
        }
        updateAttachmentStoragePath.run(historyPath, row.id);
        fs.rmSync(sourcePath, { force: true });
      } catch (error) {
        fs.rmSync(historyDirectory, { recursive: true, force: true });
        throw error;
      }
    }

    const rows = db.prepare("SELECT * FROM attachments ORDER BY created_at, id").all();
    for (const row of rows) {
      if (fs.existsSync(row.storage_path)) publishAttachment(row);
    }
    return { migrated: directRows.length, published: rows.length };
  }

  migrateStoredAttachmentLayout();

  function publicRun(row) {
    if (!row) return null;
    return {
      ...row,
      result: parseJson(row.result_json),
      attachmentIds: parseJson(row.attachment_ids_json, []),
      request_ciphertext: undefined,
      result_json: undefined,
      attachment_ids_json: undefined,
    };
  }

  return {
    databasePath,
    dataDirectory: dataDir,
    attachmentsDirectory,
    uploadDirectory: attachmentsDirectory,
    attachmentHistoryDirectory,
    legacyAttachmentsDirectory,

    createRun({ id = randomUUID(), source, ownerScope = "local", parentRunId = null, request, reportId = null, status = "running" }) {
      const attachmentIds = Array.isArray(request?.attachments)
        ? request.attachments.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean)
        : [];
      insertRun.run({
        id,
        reportId,
        source,
        ownerScope,
        parentRunId,
        status,
        baseUrlDisplay: sanitizeDisplayUrl(request?.base_url ?? request?.baseUrl ?? request?.url),
        model: String(request?.model ?? ""),
        profileModel: request?.profile_model ?? request?.profileModel ?? null,
        protocol: String(request?.protocol ?? "auto"),
        requestCiphertext: encryptJson(request, key),
        attachmentIdsJson: JSON.stringify(attachmentIds),
        createdAt: new Date().toISOString(),
      });
      return id;
    },

    finishRun(id, { status, report = null, errorCode = null, errorMessage = null } = {}) {
      const score = typeof report?.score === "number" ? report.score : null;
      const verdict = report?.verdict?.value ?? report?.authenticity?.verdict ?? null;
      updateRun.run({
        id,
        reportId: typeof report?.id === "string" ? report.id : null,
        status: status || report?.status || "completed",
        score,
        verdict,
        engineVersion: report?.engine_version ?? report?.profile?.version ?? null,
        resultJson: report ? JSON.stringify(report) : null,
        errorCode,
        errorMessage,
        completedAt: new Date().toISOString(),
      });
    },

    listRuns({ limit = 100, source = null, ownerScope = "local", allowAnyOwner = false } = {}) {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
      const rows = allowAnyOwner
        ? source
          ? db.prepare("SELECT * FROM detection_runs WHERE source = ? ORDER BY created_at DESC LIMIT ?").all(source, safeLimit)
          : db.prepare("SELECT * FROM detection_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit)
        : source
          ? db.prepare("SELECT * FROM detection_runs WHERE owner_scope = ? AND source = ? ORDER BY created_at DESC LIMIT ?").all(ownerScope, source, safeLimit)
          : db.prepare("SELECT * FROM detection_runs WHERE owner_scope = ? ORDER BY created_at DESC LIMIT ?").all(ownerScope, safeLimit);
      return rows.map(publicRun);
    },

    getRunPublic(id, ownerScope = "local", allowAnyOwner = false) {
      const row = allowAnyOwner
        ? db.prepare("SELECT * FROM detection_runs WHERE id = ?").get(id)
        : db.prepare("SELECT * FROM detection_runs WHERE id = ? AND owner_scope = ?").get(id, ownerScope);
      return publicRun(row);
    },

    getRunForRetry(id, ownerScope = "local", allowAnyOwner = false) {
      const row = allowAnyOwner
        ? db.prepare("SELECT * FROM detection_runs WHERE id = ?").get(id)
        : db.prepare("SELECT * FROM detection_runs WHERE id = ? AND owner_scope = ?").get(id, ownerScope);
      if (!row) return null;
      return { ...row, request: decryptJson(row.request_ciphertext, key) };
    },

    recordApiRequest({ id = randomUUID(), runId = null, route, method, statusCode, errorCode = null, durationMs, detectorKeyFingerprint = null, createdAt = new Date().toISOString() }) {
      insertAudit.run({
        id,
        runId,
        route,
        method,
        statusCode,
        errorCode,
        durationMs: Math.max(0, Math.trunc(durationMs) || 0),
        detectorKeyFingerprint,
        createdAt,
      });
      return id;
    },

    createAttachment(record) {
      insertAttachments([record]);
      return record;
    },

    createAttachments(records) {
      insertAttachments(records);
      return records;
    },

    publishAttachment,
    publishAttachments(records) {
      const published = [];
      try {
        for (const record of records) published.push({ record, path: publishAttachment(record) });
        return published.map((item) => item.path);
      } catch (error) {
        // A multi-file request must not leave files from a failed publication
        // behind. Compare the inode/hash before removing each visible name so
        // a concurrent newer upload is never touched.
        for (const item of published) {
          if (fileMatchesRecord(item.path, item.record, item.record.storagePath)) fs.rmSync(item.path, { force: true });
        }
        throw error;
      }
    },

    cleanupAttachmentArtifact,

    getAttachment(id, ownerScope = "local", allowAnyOwner = false) {
      const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
      if (!row) return null;
      if (!allowAnyOwner && row.owner_scope !== ownerScope) return null;
      return row;
    },

    getLatestAttachmentByName(name, ownerScope = null, allowAnyOwner = true) {
      const normalizedName = attachmentBasename(name);
      const row = allowAnyOwner || !ownerScope
        ? db.prepare("SELECT * FROM attachments WHERE original_name = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(normalizedName)
        : db.prepare("SELECT * FROM attachments WHERE original_name = ? AND owner_scope = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(normalizedName, ownerScope);
      return row || null;
    },

    getAttachments(ids, ownerScope = "local", allowAnyOwner = false) {
      return ids.map((id) => this.getAttachment(id, ownerScope, allowAnyOwner)).filter(Boolean);
    },

    listAttachments(ids, ownerScope = "local", allowAnyOwner = false) {
      return ids.map((id) => {
        const row = this.getAttachment(id, ownerScope, allowAnyOwner);
        if (!row) return null;
        return {
          id: row.id,
          original_name: row.original_name,
          media_type: row.media_type,
          size_bytes: row.size_bytes,
          sha256: row.sha256,
          created_at: row.created_at,
        };
      }).filter(Boolean);
    },

    deleteAttachment(id, ownerScope = "local", { allowAnyOwner = false, requireUnreferenced = true } = {}) {
      const row = this.getAttachment(id, ownerScope, allowAnyOwner);
      if (!row) return { deleted: false, reason: "not_found" };
      if (requireUnreferenced && runAttachmentIds().has(id)) return { deleted: false, reason: "attachment_in_use" };
      const allowVisibleCleanup = !hasNewerSameNameAttachment(row);
      const changes = deleteAttachmentRow.run(id).changes;
      if (changes > 0) {
        cleanupAttachmentArtifact(row, { allowVisibleCleanup });
        if (allowVisibleCleanup) publishLatestVisibleAttachment(row.original_name);
      }
      return { deleted: changes > 0, reason: changes > 0 ? null : "not_found" };
    },

    deleteAttachments(ids, ownerScope = "local", options = {}) {
      return ids.map((id) => ({ id, ...this.deleteAttachment(id, ownerScope, options) }));
    },

    pruneUnreferencedAttachments({ ownerScope = null, olderThan = new Date() } = {}) {
      const cutoff = olderThan instanceof Date ? olderThan.toISOString() : new Date(olderThan).toISOString();
      const referenced = runAttachmentIds();
      const rows = ownerScope
        ? db.prepare("SELECT * FROM attachments WHERE owner_scope = ? AND created_at <= ?").all(ownerScope, cutoff)
        : db.prepare("SELECT * FROM attachments WHERE created_at <= ?").all(cutoff);
      let deleted = 0;
      for (const row of rows) {
        if (referenced.has(row.id)) continue;
        const allowVisibleCleanup = !hasNewerSameNameAttachment(row);
        if (deleteAttachmentRow.run(row.id).changes > 0) {
          cleanupAttachmentArtifact(row, { allowVisibleCleanup });
          if (allowVisibleCleanup) publishLatestVisibleAttachment(row.original_name);
          deleted += 1;
        }
      }
      return deleted;
    },

    clearRuns(ownerScope = "local", allowAnyOwner = false) {
      return allowAnyOwner
        ? db.prepare("DELETE FROM detection_runs").run().changes
        : db.prepare("DELETE FROM detection_runs WHERE owner_scope = ?").run(ownerScope).changes;
    },

    close() {
      db.close();
    },
  };
}
