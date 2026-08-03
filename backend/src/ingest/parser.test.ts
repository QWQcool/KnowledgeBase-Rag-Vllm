import { describe, expect, it } from "vitest";
import { parseDocument } from "./parser";

/** 构造一份含单页文本的最小合法 PDF（偏移量/交叉引用表按字节精确计算） */
function buildMinimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    null, // 0 号对象占位
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

describe("parseDocument · Markdown", () => {
  it("md 直接返回原文，sourceType=md", async () => {
    const { text, sourceType, title } = await parseDocument("guide.md", "# 指南\n\n正文内容");
    expect(text).toBe("# 指南\n\n正文内容");
    expect(sourceType).toBe("md");
    expect(title).toBe("指南");
  });

  it("无标题的 md title 为 undefined", async () => {
    const { title } = await parseDocument("notes.md", "没有标题的正文");
    expect(title).toBeUndefined();
  });
});

describe("parseDocument · TXT", () => {
  it("txt 直接返回原文，sourceType=txt", async () => {
    const { text, sourceType, title } = await parseDocument("note.txt", "纯文本内容");
    expect(text).toBe("纯文本内容");
    expect(sourceType).toBe("txt");
    expect(title).toBeUndefined();
  });
});

describe("parseDocument · PDF", () => {
  it("pdf 用纯 JS 库提取文本，sourceType=pdf", async () => {
    const pdfBytes = buildMinimalPdf("Hello PDF World");
    const { text, sourceType } = await parseDocument("doc.pdf", pdfBytes.toString("latin1"));
    expect(sourceType).toBe("pdf");
    expect(text).toContain("Hello PDF World");
  });

  it("非 PDF 内容解析失败时给出明确错误", async () => {
    await expect(parseDocument("broken.pdf", "这不是一个PDF文件")).rejects.toThrow(/PDF/);
  });
});

describe("parseDocument · 不支持的类型", () => {
  it("非 md/txt/pdf 扩展名报错", async () => {
    await expect(parseDocument("a.docx", "x")).rejects.toThrow(/不支持/);
  });

  it("扩展名大小写不敏感", async () => {
    const { sourceType } = await parseDocument("GUIDE.MD", "# 标题");
    expect(sourceType).toBe("md");
  });
});
