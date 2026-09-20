import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractResume } from "../../lib/server/documents";
import { withDeadline } from "../../lib/server/deadline";

const content =
  "DEMO RESUME: Alex Example. Customer service and beverage preparation at Example Coffee from 2023 to 2025. Fictional test evidence only.";
export function textPdf(text: string) {
  const stream = `BT /F1 12 Tf 30 760 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test("text PDF and DOCX preserve actual evidence without OCR claims", async () => {
  const pdf = await extractResume(textPdf(content), "fictional-resume.pdf");
  assert.match(pdf.text, /Customer service/);
  assert.equal(pdf.extraction.method, "text");
  assert.equal(pdf.extraction.pages, 1);
  assert.equal(pdf.extraction.confidence, undefined);
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${content}</w:t></w:r></w:p></w:body></w:document>`,
  );
  const docx = await extractResume(
    await zip.generateAsync({ type: "nodebuffer" }),
    "fictional-resume.docx",
  );
  assert.match(docx.text, /2023 to 2025/);
  assert.equal(docx.extraction.method, "text");
});
test("damaged documents fail safely and deadlines settle", async () => {
  await assert.rejects(
    extractResume(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), "damaged.docx"),
    /could not be read/,
  );
  const bad = await extractResume(Buffer.from("%PDF-invalid"), "damaged.pdf");
  assert.equal(bad.text, "");
  assert.ok(bad.extraction.warnings.length);
  await assert.rejects(withDeadline(new Promise(() => {}), 10));
});
