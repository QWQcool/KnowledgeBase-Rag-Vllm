import { describe, expect, it } from "vitest";
import { RetrieveService } from "./retrieve-service";
import type { EmbeddingProvider, VectorStore } from "../infra/types";
import type { DocumentChunk, RetrievalHit } from "@rag/shared";

const chunk = (id: string, content: string): DocumentChunk => ({
  id,
  documentId: "doc-1",
  index: 0,
  content,
});

/** 固定向量的 embedding 假实现：记录调用，返回确定性向量 */
function fakeEmbedding(vector: number[]): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      return texts.map(() => vector);
    },
  };
}

/** 内存版假向量库：可控返回 hits */
function fakeStore(hits: RetrievalHit[]): VectorStore & { searches: number[] } {
  const searches: number[] = [];
  return {
    searches,
    async init() {},
    async upsertChunks() {},
    async search(_kb: string, _v: number[], topK: number) {
      searches.push(topK);
      return hits;
    },
    async clear() {},
  };
}

describe("RetrieveService", () => {
  it("question 先 embed，再按 topK 检索并降序返回", async () => {
    const embedding = fakeEmbedding([0.5, 0.5]);
    const store = fakeStore([
      { chunk: chunk("a", "低相关"), score: 0.3 },
      { chunk: chunk("b", "高相关"), score: 0.9 },
      { chunk: chunk("c", "中相关"), score: 0.6 },
    ]);
    const svc = new RetrieveService(embedding, store);

    const resp = await svc.retrieve({
      question: "什么是向量检索？",
      knowledgeBaseId: "kb-1",
      topK: 2,
    });

    // embed 输入是原问题
    expect(embedding.calls[0][0]).toBe("什么是向量检索？");
    // 只取 topK=2 且按 score 降序
    expect(resp.hits.map((h) => h.chunk.id)).toEqual(["b", "c"]);
    expect(resp.hits.map((h) => h.score)).toEqual([0.9, 0.6]);
    // store 收到的是归一化后的 topK
    expect(store.searches[0]).toBe(2);
  });

  it("topK 缺省为 5", async () => {
    const embedding = fakeEmbedding([1, 0]);
    const store = fakeStore([]);
    const svc = new RetrieveService(embedding, store);

    await svc.retrieve({ question: "q", knowledgeBaseId: "kb-1" });
    expect(store.searches[0]).toBe(5);
  });

  it("空知识库 / 无命中返回空 hits，不抛错", async () => {
    const embedding = fakeEmbedding([1, 0]);
    const store = fakeStore([]);
    const svc = new RetrieveService(embedding, store);

    const resp = await svc.retrieve({
      question: "空库问题",
      knowledgeBaseId: "kb-空",
      topK: 5,
    });
    expect(resp.hits).toEqual([]);
    expect(resp).toMatchObject({ hits: [] });
  });

  it("响应符合契约 RetrieveResponse（zod 可解析）", async () => {
    const embedding = fakeEmbedding([1, 0]);
    const store = fakeStore([
      { chunk: chunk("a", "命中内容"), score: 0.8 },
    ]);
    const svc = new RetrieveService(embedding, store);

    const resp = await svc.retrieve({
      question: "q",
      knowledgeBaseId: "kb-1",
      topK: 3,
    });
    expect(resp.hits).toHaveLength(1);
    expect(resp.hits[0].chunk.content).toBe("命中内容");
  });

  it("minScore 阈值过滤：低于阈值的命中被剔除（防'永远返回 topK'误导）", async () => {
    const embedding = fakeEmbedding([1, 0]);
    const store = fakeStore([
      { chunk: chunk("low", "低相关"), score: 0.2 },
      { chunk: chunk("mid", "中相关"), score: 0.6 },
      { chunk: chunk("high", "高相关"), score: 0.9 },
    ]);
    const svc = new RetrieveService(embedding, store);

    const resp = await svc.retrieve({
      question: "q",
      knowledgeBaseId: "kb-1",
      topK: 5,
      minScore: 0.5,
    });

    // 0.2 被阈值剔除，仅保留 ≥0.5 的两条且降序
    expect(resp.hits.map((h) => h.chunk.id)).toEqual(["high", "mid"]);
  });
});
