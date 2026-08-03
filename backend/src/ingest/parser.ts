import type { DocumentSourceType } from "@rag/shared";

/**
 * parser.ts —— 文档解析：MD/TXT 直读文本，PDF 用 pdf-parse（纯 JS）提取。
 *
 * 输入约定：IngestRequest.content 是 string（契约定死）。
 * 对 PDF，二进制原文经 latin1 编解码无损承载（1 字节 = 1 字符）。
 */

export interface ParseResult {
  text: string;
  sourceType: DocumentSourceType;
  /** 文档标题（md 取首个一级标题，其它类型为 undefined） */
  title?: string;
}

/** 提取首个一级标题（"# xxx"）作为文档标题 */
function extractTitle(text: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(text);
  return match?.[1];
}

export async function parseDocument(
  filename: string,
  content: string,
): Promise<ParseResult> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "md":
      return { text: content, sourceType: "md", title: extractTitle(content) };
    case "txt":
      return { text: content, sourceType: "txt" };
    case "pdf":
      return extractPdfText(content);
    default:
      throw new Error(`不支持的文档类型: .${ext}（仅支持 md / txt / pdf）`);
  }
}

/** pdf-parse v2 的 PDFParse 实例所需的最小结构（动态导入 + 结构类型） */
interface PdfParserLike {
  destroy(): Promise<void>;
  getText(): Promise<{ text: string }>;
}

async function extractPdfText(content: string): Promise<ParseResult> {
  let parser: PdfParserLike | undefined;
  try {
    // 动态导入：pdf-parse 依赖 pdfjs-dist，体量较大，仅 pdf 场景才加载
    const { PDFParse } = await import("pdf-parse");
    // latin1 无损还原二进制字节
    const buffer = Buffer.from(content, "latin1");
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result.text ?? "").trim();
    if (!text) {
      throw new Error("PDF 未提取到任何文本（可能是扫描件/图片型 PDF）");
    }
    return { text, sourceType: "pdf" };
  } catch (err) {
    throw new Error(
      `PDF 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}
