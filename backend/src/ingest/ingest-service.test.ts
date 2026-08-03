import { describe, expect, it, vi } from "vitest";
import { IngestRequest, IngestResponse } from "@rag/shared";
import { IngestService } from "./ingest-service";
import type { EmbeddingProvider, VectorStore } from "../infra/types";

const MD = `# 使用指南

这是使用指南的第一段正文。

## 安装

执行 npm install。

## 快速开始

运行 start 命令。`;

const LONG_TXT = "这是一段用于验证默认策略的纯文本内容。".repeat(30);

function makeMocks() {
  const embeddingProvider: EmbeddingProvider = {
    embed: vi.fn(async (texts: string[]) => texts.map((_, i) => [i, 0.5])),
  };
  const vectorStore: VectorStore = {
    init: vi.fn(async () => undefined),
    upsertChunks: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    clear: vi.fn(async () => undefined),
  };
  return { embeddingProvider, vectorStore };
}

describe("IngestService", () => {
  it("heading 策略：解析→分块→embed→upsert→返回符合契约的 IngestResponse", async () => {
    const { embeddingProvider, vectorStore } = makeMocks();
    const service = new IngestService({ embeddingProvider, vectorStore });

    const req = IngestRequest.parse({
      filename: "guide.md",
      content: MD,
      chunkStrategy: "heading",
      knowledgeBaseId: "kb-1",
    });
    const res = await service.ingest(req);

    // 1. 调用了 embedding 与向量库写入
    expect(embeddingProvider.embed).toHaveBeenCalledTimes(1);
    expect(vectorStore.init).toHaveBeenCalledWith("kb-1");
    expect(vectorStore.upsertChunks).toHaveBeenCalledTimes(1);
    const [kbId, entries] = (vectorStore.upsertChunks as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(kbId).toBe("kb-1");
    expect(entries).toHaveLength(res.chunks.length);
    expect(entries[0].vector).toEqual([0, 0.5]);

    // 2. Document 对象
    expect(res.document.filename).toBe("guide.md");
    expect(res.document.sourceType).toBe("md");
    expect(res.document.status).toBe("ready");
    expect(res.document.chunkCount).toBe(res.chunks.length);
    expect(res.document.error).toBeNull();

    // 3. chunks 结构与文档一致
    res.chunks.forEach((chunk, i) => {
      expect(chunk.documentId).toBe(res.document.id);
      expect(chunk.id).toBe(`${res.document.id}#${i}`);
      expect(chunk.index).toBe(i);
    });
    expect(entries[0].chunk.id).toBe(res.chunks[0].id);

    // 4. 运行时用 Zod 再校验：契约是唯一事实源
    expect(IngestResponse.safeParse(res).success).toBe(true);
  });

  it("缺省策略为 fixed：无 chunkStrategy 时按固定长度分块", async () => {
    const { embeddingProvider, vectorStore } = makeMocks();
    const service = new IngestService({ embeddingProvider, vectorStore });

    const res = await service.ingest({
      filename: "note.txt",
      content: LONG_TXT,
      knowledgeBaseId: "kb-default",
    });

    expect(res.document.sourceType).toBe("txt");
    expect(res.chunks.length).toBeGreaterThan(1);
    // 所有 chunk 内容都被向量化并入库
    const embedArgs = (embeddingProvider.embed as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(embedArgs).toHaveLength(res.chunks.length);
    expect(embedArgs[0]).toBe(res.chunks[0].content);
  });

  it("chunkSize 可配置并透传给 fixed 策略", async () => {
    const { embeddingProvider, vectorStore } = makeMocks();
    const service = new IngestService({ embeddingProvider, vectorStore });

    const res = await service.ingest({
      filename: "note.txt",
      content: LONG_TXT,
      chunkStrategy: "fixed",
      chunkSize: 100,
    });

    expect(Math.max(...res.chunks.map((c) => c.content.length))).toBeLessThanOrEqual(100);
  });

  it("未传 knowledgeBaseId 时使用缺省 default（与 query 命名空间对齐）", async () => {
    const { embeddingProvider, vectorStore } = makeMocks();
    const service = new IngestService({ embeddingProvider, vectorStore });

    const res = await service.ingest({
      filename: "note.txt",
      content: "hello",
    });

    expect(vectorStore.init).toHaveBeenCalledWith("default");
    const [kbId] = (vectorStore.upsertChunks as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(kbId).toBe("default");
    expect(res.chunkCount).toBeGreaterThanOrEqual(1);
  });
});
