import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatResponse,
  SourceRef,
  type RetrievalHit,
} from "@rag/shared";
import { createApp } from "../app";
import { createLLMProvider, MockLLMProvider, OpenAICompatibleLLMProvider } from "./llm-provider";
import { createQueryService, type RetrieveService } from "./query-service";

/** 构造一条符合 RetrievalHit 契约的命中 */
function makeHit(
  documentId: string,
  title: string,
  content: string,
  score: number,
): RetrievalHit {
  return {
    chunk: {
      id: `${documentId}#0`,
      documentId,
      index: 0,
      content,
      source: { title },
    },
    score,
  };
}

const HITS = [
  makeHit(
    "doc-1",
    "01-项目规划与执行手册.md",
    "检索增强生成（RAG）是一种结合信息检索与生成模型的技术。",
    0.92,
  ),
  makeHit(
    "doc-2",
    "向量数据库说明.md",
    "向量数据库用于存储文档分块的嵌入向量，支撑相似度检索。",
    0.78,
  ),
];

function retrieveServiceWith(hits: RetrievalHit[]): RetrieveService {
  return {
    async retrieve() {
      return { hits };
    },
  };
}

describe("queryService", () => {
  it("注入 chatLog 时每次问答都落一条日志（含问题/知识库/来源/答案/耗时）", async () => {
    const appends: unknown[] = [];
    const service = createQueryService({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: new MockLLMProvider(),
      chatLog: { append: (e) => appends.push(e) },
    });

    await service.query({ question: "什么是 RAG？", knowledgeBaseId: "kb-1" });

    expect(appends).toHaveLength(1);
    const entry = appends[0] as Record<string, unknown>;
    expect(entry.question).toBe("什么是 RAG？");
    expect(entry.knowledgeBaseId).toBe("kb-1");
    expect(entry.sources).toHaveLength(2);
    expect(typeof entry.answer).toBe("string");
    expect((entry.answer as string).length).toBeGreaterThan(0);
    expect(entry.fallbackNoHits).toBe(false);
    expect(typeof entry.elapsedMs).toBe("number");
  });

  it("a) 命中 2 条：answer 非空且含检索片段，sources 完整符合 SourceRef 契约", async () => {
    const service = createQueryService({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: new MockLLMProvider(),
    });

    const resp = await service.query({
      question: "什么是 RAG？",
      knowledgeBaseId: "kb-1",
    });

    expect(resp.answer.length).toBeGreaterThan(0);
    // Mock 会把最相关片段（第一条命中）拼进回答，证明「真用了检索结果」
    expect(resp.answer).toContain(HITS[0].chunk.content.slice(0, 20));

    expect(resp.sources).toHaveLength(2);
    const s0 = resp.sources[0];
    // 逐条按 SourceRef 契约校验
    expect(SourceRef.safeParse(s0).success).toBe(true);
    expect(s0.documentId).toBe("doc-1");
    expect(s0.documentName).toBe("01-项目规划与执行手册.md");
    expect(s0.snippet.length).toBeGreaterThan(0);
    expect(s0.score).toBeCloseTo(0.92);

    // 整包响应也能通过 ChatResponse 契约
    expect(ChatResponse.safeParse(resp).success).toBe(true);
  });

  it("b) 检索为空：仍调用 LLM 兜底回答（sources 为空数组，answer 非空）", async () => {
    const service = createQueryService({
      retrieveService: retrieveServiceWith([]),
      llmProvider: new MockLLMProvider(),
    });

    const resp = await service.query({
      question: "不存在的主题",
      knowledgeBaseId: "kb-1",
    });

    expect(resp.sources).toEqual([]);
    expect(resp.answer.length).toBeGreaterThan(0);
    expect(ChatResponse.safeParse(resp).success).toBe(true);
  });
});

describe("POST /api/query 端点", () => {
  it("c1) 合法 ChatRequest → 200，响应通过 ChatResponse 契约", async () => {
    const app = createApp({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: new MockLLMProvider(),
    });

    const res = await app.request("/api/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "什么是 RAG？", knowledgeBaseId: "kb-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ChatResponse.safeParse(body).success).toBe(true);
    const parsed = ChatResponse.parse(body);
    expect(parsed.sources).toHaveLength(2);
  });

  it("c2) 非法 body（缺 knowledgeBaseId）→ 422", async () => {
    const app = createApp({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: new MockLLMProvider(),
    });

    const res = await app.request("/api/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hi" }),
    });

    expect(res.status).toBe(422);
  });

  it("c3) 非法 body（非 JSON）→ 422", async () => {
    const app = createApp();

    const res = await app.request("/api/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(422);
  });
});

describe("OpenAICompatibleLLMProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_API_KEY;
  });

  it("按 OpenAI 兼容协议 POST /v1/chat/completions 并解析回答", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "来自模型的回答" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "sk-test",
    });

    const { answer } = await provider.generate({
      systemPrompt: "你是助手",
      contextChunks: [{ content: "片段A", source: "doc-1" }],
      question: "你好",
    });

    expect(answer).toBe("来自模型的回答");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("test-model");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("片段A");
    expect(init?.headers).toMatchObject({ authorization: "Bearer sk-test" });
  });

  it("环境变量缺 OPENAI_MODEL 时抛出明确错误", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://example.com/v1",
      model: "",
      apiKey: "sk-test",
    });
    await expect(
      provider.generate({
        systemPrompt: "s",
        contextChunks: [],
        question: "q",
      }),
    ).rejects.toThrow(/OPENAI_MODEL/);
  });

  it("createLLMProvider 工厂按配置切换实现（Strategy）", () => {
    expect(createLLMProvider("mock")).toBeInstanceOf(MockLLMProvider);
    expect(createLLMProvider("openai")).toBeInstanceOf(OpenAICompatibleLLMProvider);
  });
});
