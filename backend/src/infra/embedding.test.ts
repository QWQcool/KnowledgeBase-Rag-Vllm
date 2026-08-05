import { describe, expect, it, vi } from "vitest";
import {
  MockEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  createEmbeddingProvider,
  type EmbeddingProviderType,
} from "./embedding";
import { EMBEDDING_DIM } from "./config";
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

  it("向量维度与 EMBEDDING_DIM 对齐（M4 起默认 384 = multilingual-e5-small）", async () => {
    const [v] = await provider.embed(["测试"]);
    expect(v).toHaveLength(EMBEDDING_DIM);
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

  it('type="openai" 返回 OpenAICompatibleEmbeddingProvider 实例', () => {
    const p = createEmbeddingProvider("openai");
    expect(p).toBeInstanceOf(OpenAICompatibleEmbeddingProvider);
  });

  it("非法 type 抛明确错误", () => {
    expect(() =>
      createEmbeddingProvider("unknown" as EmbeddingProviderType),
    ).toThrow();
  });
});

describe("OpenAICompatibleEmbeddingProvider（llama-server /v1/embeddings）", () => {
  it("按 OpenAI 兼容协议 POST /v1/embeddings 并解析向量", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:8080/v1",
      model: "bge-m3",
      apiKey: "sk-test",
      dim: 3,
    });

    const [v] = await provider.embed(["测试文本"]);

    expect(v).toEqual([0.1, 0.2, 0.3]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8080/v1/embeddings");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("bge-m3");
    expect(body.input).toEqual(["测试文本"]);
    expect(init?.headers).toMatchObject({ authorization: "Bearer sk-test" });

    vi.unstubAllGlobals();
  });

  it("维度不匹配时抛出明确错误（换模型没改 RAG_EMBEDDING_DIM）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:8080/v1",
      model: "bge-m3",
      dim: 384, // 模型返回 4 维，配置期望 384 → 应报错
    });

    await expect(provider.embed(["x"])).rejects.toThrow(/维度不匹配/);

    vi.unstubAllGlobals();
  });

  it("未配置模型名时抛出明确错误", async () => {
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:8080/v1",
      model: "",
      apiKey: "",
    });
    await expect(provider.embed(["x"])).rejects.toThrow(/未配置 embedding 模型名/);
  });

  it("空数组输入直接返回空（不请求）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:8080/v1",
      model: "bge-m3",
      dim: 384,
    });
    expect(await provider.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
