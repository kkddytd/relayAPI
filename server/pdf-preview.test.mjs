import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderPdfPreview } from "./pdf-preview.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relayapi-pdf-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PDF preview rendering", () => {
  it("uses the original storage path and renders representative pages", async () => {
    const directory = temporaryDirectory();
    const originalPath = path.join(directory, 'report"$(ignored).pdf');
    const original = Buffer.from("original PDF bytes stay untouched", "utf8");
    fs.writeFileSync(originalPath, original);
    const instances = [];

    class FakePDFImage {
      constructor(pdfPath, options) {
        this.pdfPath = pdfPath;
        this.options = options;
        this.pages = [];
        instances.push(this);
      }

      async numberOfPages() {
        return "7";
      }

      async convertPage(pageIndex) {
        this.pages.push(pageIndex);
        const outputPath = path.join(this.options.outputDirectory, `page-${pageIndex}.png`);
        const buffer = await sharp({
          create: {
            width: 320,
            height: 180,
            channels: 3,
            background: { r: 30 + pageIndex, g: 90, b: 160 },
          },
        }).png().toBuffer();
        fs.writeFileSync(outputPath, buffer);
        return outputPath;
      }
    }

    const result = await renderPdfPreview(originalPath, {
      pageLimit: 3,
      backend: "graphicsmagick",
      PDFImageClass: FakePDFImage,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0].pdfPath).toBe(path.resolve(originalPath));
    expect(path.basename(instances[0].pdfPath)).toBe('report"$(ignored).pdf');
    expect(instances[0].options).toMatchObject({
      pdfFileBaseName: "page",
      convertExtension: "png",
      graphicsMagick: true,
    });
    expect(instances[0].pages).toEqual([0, 3, 6]);
    expect(result).toMatchObject({
      totalPages: 7,
      pageIndexes: [0, 3, 6],
      backend: "graphicsmagick",
    });
    expect((await sharp(result.buffer).metadata()).format).toBe("webp");
    expect(fs.readFileSync(originalPath)).toEqual(original);
  });

  it("passes the original path as an execFile argument", async () => {
    const directory = temporaryDirectory();
    const originalPath = path.join(directory, 'report "$(ignored)".pdf');
    fs.writeFileSync(originalPath, "%PDF-test");
    const calls = [];

    const execFileImpl = async (command, args) => {
      calls.push({ command, args });
      if (command === "pdfinfo") return { stdout: "Pages: 1\n", stderr: "" };
      const outputPath = args.at(-1);
      fs.writeFileSync(outputPath, await sharp({
        create: { width: 320, height: 180, channels: 3, background: "#345" },
      }).png().toBuffer());
      return { stdout: "", stderr: "" };
    };

    const result = await renderPdfPreview(originalPath, {
      pageLimit: 1,
      backend: "graphicsmagick",
      execFileImpl,
    });

    expect((await sharp(result.buffer).metadata()).format).toBe("webp");
    expect(calls[0]).toMatchObject({ command: "pdfinfo", args: [path.resolve(originalPath)] });
    expect(calls[1].command).toBe("gm");
    expect(calls[1].args).toContain(`${path.resolve(originalPath)}[0]`);
    expect(calls[1].args.join(" ")).toContain('report "$(ignored)".pdf');
    expect(fs.readFileSync(originalPath, "utf8")).toBe("%PDF-test");
  });

  it("cleans temporary files when conversion fails", async () => {
    const directory = temporaryDirectory();
    const originalPath = path.join(directory, "broken.pdf");
    fs.writeFileSync(originalPath, "%PDF-broken");
    let outputDirectory = null;

    class FailingPDFImage {
      constructor(pdfPath, options) {
        outputDirectory = options.outputDirectory;
      }

      async numberOfPages() {
        throw new Error("invalid PDF fixture");
      }
    }

    await expect(renderPdfPreview(originalPath, {
      backend: "graphicsmagick",
      PDFImageClass: FailingPDFImage,
    })).rejects.toThrow("pdf_preview_conversion_failed");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("stops waiting when the request is aborted", async () => {
    const directory = temporaryDirectory();
    const originalPath = path.join(directory, "cancelled.pdf");
    fs.writeFileSync(originalPath, "%PDF-cancelled");
    const controller = new AbortController();

    class HangingPDFImage {
      async numberOfPages() {
        return new Promise(() => {});
      }
    }

    const rendering = renderPdfPreview(originalPath, {
      backend: "graphicsmagick",
      PDFImageClass: HangingPDFImage,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
  });
});
