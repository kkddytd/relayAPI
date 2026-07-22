import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pdfImagePackage from "pdf-image";
import sharp from "sharp";

const { PDFImage } = pdfImagePackage;
const execFileAsync = promisify(execFile);
const DEFAULT_PAGE_LIMIT = 4;
const MAX_PAGE_LIMIT = 8;
const TARGET_BYTES = 4 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const MAX_OPERATION_TIMEOUT_MS = 300_000;

function boundedPageLimit(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_PAGE_LIMIT, parsed)
    : DEFAULT_PAGE_LIMIT;
}

function boundedTimeout(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_OPERATION_TIMEOUT_MS, Math.max(1_000, parsed))
    : DEFAULT_OPERATION_TIMEOUT_MS;
}

function abortReason(signal) {
  return signal?.reason || Object.assign(new Error("pdf_preview_aborted"), { name: "AbortError" });
}

function withOperationTimeout(operation, { signal, timeoutMs }) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("pdf_preview_timeout"), { code: "pdf_preview_timeout" })), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function selectedPages(totalPages, limit) {
  if (totalPages <= limit) return Array.from({ length: totalPages }, (_, index) => index);
  if (limit === 1) return [0];
  return [...new Set(Array.from(
    { length: limit },
    (_, index) => Math.round((index * (totalPages - 1)) / (limit - 1)),
  ))];
}

async function commandAvailable(command, args) {
  try {
    await execFileAsync(command, args, { timeout: 5_000, windowsHide: true });
    return true;
  } catch (error) {
    return error?.code !== "ENOENT" && error?.code !== "UNKNOWN";
  }
}

async function availableBackends(preferred) {
  if (preferred === "graphicsmagick" || preferred === "imagemagick") return [preferred];
  const configured = String(process.env.PDF_IMAGE_BACKEND || "").trim().toLowerCase();
  if (configured === "graphicsmagick" || configured === "imagemagick") return [configured];
  const backends = [];
  if (await commandAvailable("gm", ["version"])) backends.push("graphicsmagick");
  if (await commandAvailable("convert", ["-version"])) backends.push("imagemagick");
  return backends;
}

function safeTemporaryRoot() {
  const value = path.resolve(os.tmpdir());
  if (/["`$%\r\n]/.test(value)) throw new Error("pdf_preview_temp_path_unsafe");
  return value;
}

async function combinedPreview(imagePaths) {
  let smallest = null;
  for (const width of [1400, 1200, 1000, 800]) {
    const pages = [];
    for (const imagePath of imagePaths) {
      const { data, info } = await sharp(imagePath)
        .flatten({ background: "#ffffff" })
        .resize({ width, height: 1800, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      pages.push({ data, width: info.width, height: info.height });
    }
    const gap = 12;
    const columns = Math.min(2, pages.length);
    const rows = Math.ceil(pages.length / columns);
    const cellWidth = Math.max(...pages.map((page) => page.width));
    const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(
      ...pages.slice(row * columns, (row + 1) * columns).map((page) => page.height),
    ));
    const canvasWidth = cellWidth * columns + Math.max(0, columns - 1) * gap;
    const canvasHeight = rowHeights.reduce((total, height) => total + height, 0) + Math.max(0, rows - 1) * gap;
    const layers = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const row = Math.floor(index / columns);
      const column = index % columns;
      const rowTop = rowHeights.slice(0, row).reduce((total, height) => total + height + gap, 0);
      layers.push({
        input: page.data,
        left: column * (cellWidth + gap) + Math.floor((cellWidth - page.width) / 2),
        top: rowTop + Math.floor((rowHeights[row] - page.height) / 2),
      });
    }
    for (const quality of [84, 72, 60]) {
      const candidate = await sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: "#ffffff",
        },
      })
        .composite(layers)
        .webp({ quality, effort: 2 })
        .toBuffer();
      if (!smallest || candidate.length < smallest.length) smallest = candidate;
      if (candidate.length <= TARGET_BYTES) return candidate;
    }
  }
  return smallest;
}

async function renderWithBackend({ PDFImageClass, backend, pdfPath, outputDirectory, pageLimit, signal, timeoutMs }) {
  const renderer = new PDFImageClass(pdfPath, {
    outputDirectory,
    pdfFileBaseName: "page",
    convertExtension: "png",
    graphicsMagick: backend === "graphicsmagick",
    convertOptions: {
      "-density": "120",
      "-quality": "88",
      "-resize": "1400x1800",
    },
  });
  const totalPages = Math.trunc(Number(await withOperationTimeout(() => renderer.numberOfPages(), { signal, timeoutMs })));
  if (!Number.isFinite(totalPages) || totalPages < 1) throw new Error("pdf_preview_invalid_page_count");
  const pageIndexes = selectedPages(totalPages, pageLimit);
  const imagePaths = [];
  for (const pageIndex of pageIndexes) {
    imagePaths.push(await withOperationTimeout(() => renderer.convertPage(pageIndex), { signal, timeoutMs }));
  }
  const buffer = await withOperationTimeout(() => combinedPreview(imagePaths), { signal, timeoutMs });
  if (!buffer?.length) throw new Error("pdf_preview_empty_output");
  return { buffer, totalPages, pageIndexes, backend };
}

export async function renderPdfPreview(filePath, {
  pageLimit = process.env.PDF_PREVIEW_MAX_PAGES,
  backend,
  PDFImageClass = PDFImage,
  signal,
  timeoutMs = process.env.PDF_PREVIEW_TIMEOUT_MS,
} = {}) {
  const operationTimeoutMs = boundedTimeout(timeoutMs);
  if (signal?.aborted) throw abortReason(signal);
  const temporaryDirectory = await fs.mkdtemp(path.join(safeTemporaryRoot(), "relayapi-pdf-"));
  try {
    const pdfPath = path.join(temporaryDirectory, "input.pdf");
    await fs.copyFile(filePath, pdfPath);
    const backends = await availableBackends(backend);
    if (backends.length === 0) throw new Error("pdf_preview_renderer_unavailable");
    let lastError = null;
    for (const candidate of backends) {
      const outputDirectory = path.join(temporaryDirectory, candidate);
      await fs.mkdir(outputDirectory, { recursive: true });
      try {
        return await renderWithBackend({
          PDFImageClass,
          backend: candidate,
          pdfPath,
          outputDirectory,
          pageLimit: boundedPageLimit(pageLimit),
          signal,
          timeoutMs: operationTimeoutMs,
        });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError" || error?.code === "pdf_preview_timeout") throw error;
        lastError = error;
      }
    }
    throw Object.assign(new Error("pdf_preview_conversion_failed"), { cause: lastError });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
