import { describe, expect, it } from "vitest";
import {
  MockEmbeddingProvider,
  createEmbeddingProvider,
  type EmbeddingProviderType,
} from "./embedding";
import type { EmbeddingProvider } from "./types";

describe("MockEmbeddingProvider", () => {
  const provider = new MockEmbeddingProvider();

  it("同一文本两次 embed 向量完全相等（确定性）", async () => {
    const [v1] = await provider.embed(["什么是 RAG？"]);
    const [v2] = await provider.embed(["什么是 RAG？"]);
    expect(v2).toEqual(v1);
  });

  it("不同文本大概率不同", async () => {
    const [v1] = await provider.embed(["苹果香蕉水果"]);
    const [v2] = await provider.embed(["宇宙飞船登陆火星"]);
    // 完全不同文本的向量不应逐维相等
    expect(v1).not.toEqual(v2);
  });

  it("向量维度固定为 384（与 all-MiniLM-L6-v2 对齐）", async () => {
    const [v] = await provider.embed(["测试"]);
    expect(v).toHaveLength(384);
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("批量 embed 返回等长数组", async () => {
    const vectors = await provider.embed(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
    expect(new Set(vectors.map((v) => v.length)).size).toBe(1);
  });
});

describe("createEmbeddingProvider 工厂（Strategy 模式）", () => {
  it('type="mock" 返回 MockEmbeddingProvider 实例', () => {
    const p = createEmbeddingProvider("mock");
    expect(p).toBeInstanceOf(MockEmbeddingProvider);
  });

  it('type="transformers" 返回可 embed 的 provider，且构造时不触发模型下载（懒加载）', async () => {
    const p = createEmbeddingProvider("transformers");
    expect(typeof p.embed).toBe("function");
    // 构造不抛错（离线也不炸）；embed 的下载/网络错误延迟到调用时统一给出明确提示
    expect(p).toBeDefined();
  });

  it("非法 type 抛明确错误", () => {
    expect(() =>
      createEmbeddingProvider("unknown" as EmbeddingProviderType),
    ).toThrow();
  });
});
