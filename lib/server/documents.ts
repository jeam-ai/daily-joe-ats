import "server-only";
import mammoth from "mammoth";
import { createHash } from "node:crypto";
import type { Application } from "@/types";
import { SafeError } from "./config";
import { withDeadline } from "./deadline";

const normalize = (text: string) =>
  text
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
export function detectResumeType(bytes: Buffer, filename: string) {
  const prefix = (values: number[]) => values.every((v, i) => bytes[i] === v);
  if (bytes.length > 8 * 1024 * 1024 || !bytes.length)
    throw new SafeError("Choose a non-empty resume under 8 MB.");
  if (/\.pdf$/i.test(filename) && bytes.subarray(0, 5).toString() === "%PDF-")
    return "application/pdf";
  if (/\.docx$/i.test(filename) && prefix([0x50, 0x4b, 0x03, 0x04]))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (
    /\.png$/i.test(filename) &&
    prefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )
    return "image/png";
  if (/\.jpe?g$/i.test(filename) && prefix([0xff, 0xd8, 0xff]))
    return "image/jpeg";
  if (/\.txt$/i.test(filename) && !bytes.includes(0)) return "text/plain";
  throw new SafeError(
    "Unsupported or invalid resume. Choose a PDF, DOCX, PNG, JPG/JPEG, or TXT file with the correct extension.",
  );
}
export async function extractResume(bytes: Buffer, filename: string) {
  const mime = detectResumeType(bytes, filename);
  const extraction: NonNullable<Application["extraction"]> = {
    method: "text",
    warnings: [],
  };
  let text = "";
  let worker:
    | Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>
    | undefined;
  let startup: Promise<NonNullable<typeof worker>> | undefined;
  const confidences: number[] = [];
  const deadline = Date.now() + 75000;
  async function ocr(image: Buffer) {
    try {
      if (Date.now() >= deadline) throw Error();
      if (!worker) {
        const { createWorker } = await import("tesseract.js");
        startup ??= createWorker("eng", undefined, {
          cacheMethod: "none",
          logger: () => undefined,
          errorHandler: () => undefined,
        });
        worker = await withDeadline(
          startup,
          Math.max(1, Math.min(20000, deadline - Date.now())),
        );
      }
      const result = await withDeadline(
        worker.recognize(image),
        Math.max(1, Math.min(15000, deadline - Date.now())),
      );
      confidences.push(result.data.confidence);
      return result.data.text;
    } catch {
      extraction.warnings.push(
        "OCR could not reliably read part of this document. Review the original or upload a clearer scan.",
      );
      return "";
    }
  }
  try {
    if (mime === "application/pdf") {
      // Load PDF.js only for an actual PDF operation. Keeping this out of the
      // server module graph lets unrelated routes such as OAuth callbacks run
      // without initializing the native canvas runtime.
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await withDeadline(parser.getText({ first: 10 }), 20000);
        extraction.pages = result.total;
        if (result.total > 10)
          extraction.warnings.push(
            "Only the first 10 pages were processed. Review the remaining pages in the original document.",
          );
        const parts: string[] = [];
        for (const page of result.pages) {
          if (Date.now() >= deadline) {
            extraction.warnings.push(
              "Processing reached its time limit. Review the remaining pages in the original document.",
            );
            break;
          }
          if (page.text.trim().length >= 60) parts.push(page.text);
          else {
            extraction.method = result.pages.some(
              (p) => p.text.trim().length >= 60,
            )
              ? "mixed"
              : "ocr";
            const rendered = await withDeadline(
              parser.getScreenshot({
                partial: [page.num],
                desiredWidth: 1600,
                imageDataUrl: false,
              }),
              Math.max(1, Math.min(15000, deadline - Date.now())),
            );
            parts.push(
              (await ocr(Buffer.from(rendered.pages[0].data))) || page.text,
            );
          }
          text = parts.join("\n\n");
        }
      } catch (error) {
        if (/password/i.test((error as Error).name + (error as Error).message))
          throw new SafeError(
            "This PDF is password protected. Upload an unlocked copy.",
          );
        extraction.warnings.push(
          "Some PDF content could not be extracted. Review the original document or upload a clearer copy.",
        );
      } finally {
        await withDeadline(parser.destroy(), 3000).catch(() => undefined);
      }
    } else if (mime.includes("wordprocessingml")) {
      try {
        const result = await withDeadline(
          mammoth.extractRawText({ buffer: bytes }),
          20000,
        );
        text = result.value;
        if (result.messages.length)
          extraction.warnings.push(
            "Some document formatting could not be read. Verify the original document.",
          );
      } catch {
        throw new SafeError(
          "This DOCX could not be read. Check that it is not damaged or password protected.",
        );
      }
    } else if (mime.startsWith("image/")) {
      extraction.method = "ocr";
      text = await ocr(bytes);
    } else text = bytes.toString("utf8");
  } finally {
    if (worker)
      await withDeadline(worker.terminate(), 3000).catch(() => undefined);
    else if (startup)
      void startup.then((w) => w.terminate()).catch(() => undefined);
  }
  text = normalize(text);
  extraction.textVersion = createHash("sha256").update(text).digest("hex");
  if (confidences.length)
    extraction.confidence = Math.round(
      confidences.reduce((a, b) => a + b, 0) / confidences.length,
    );
  if (extraction.confidence !== undefined && extraction.confidence < 75)
    extraction.warnings.push(
      "Low OCR confidence. Employment dates, education, and other details need manual review.",
    );
  if (text.length < 60)
    extraction.warnings.push(
      "Very little readable text was extracted. Qualifications remain unclear until HR verifies the document.",
    );
  if (text.length > 100000)
    extraction.warnings.push(
      "Extracted text was limited to 100,000 characters. Review the full original document.",
    );
  extraction.warnings = [...new Set(extraction.warnings)];
  return {
    text: text.slice(0, 100000),
    mime,
    hash: createHash("sha256").update(bytes).digest("hex"),
    extraction,
  };
}
