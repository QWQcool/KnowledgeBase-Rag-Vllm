import { describe, expect, it } from "vitest";
import {
  ChatRequest,
  ChatResponse,
  HealthStatus,
  RetrieveRequest,
  RetrieveResponse,
} from "@rag/shared";
import { createApp } from "./app";
import { mountProductionHandlers, createProductionDeps } from "./bootstrap";
import { MockEmbeddingProvider } from "./infra/embedding";
import { EMBEDDING_DIM } from "./infra/config";
import { TriviumDBStore } from "./infra/triviumdb-store";
import { IngestService } from "./ingest/ingest-service";
import { RetrieveService } from "./retrieval/retrieve-service";

describe("GET /health", () => {
  it("返回 200 且 status=ok，符合 shared/contract 契约", async () => {
    const app = createApp();
    const res = await app.request("/health");

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ status: "ok" });
    // 运行时用 Zod 再校验一遍：契约是唯一事实源
    expect(HealthStatus.safeParse(body).success).toBe(true);
  });
});

describe("M1 空端点占位", () => {
  it("GET /api/documents 返回空数组", async () => {
    const app = createApp();
    const res = await app.request("/api/documents");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /api/knowledge-bases：未挂生产 handler 时返回 404（占位已移除，真实数据由 bootstrap 提供）", async () => {
    const app = createApp();
    const res = await app.request("/api/knowledge-bases");

    expect(res.status).toBe(404);
  });

  it("POST /api/chat 返回 501（未实现）", async () => {
    const app = createApp();
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hi", knowledgeBaseId: "kb-1" }),
    });

    expect(res.status).toBe(501);
  });
});

describe("共享契约校验（shared/contract.ts 为唯一事实源）", () => {
  it("合法 ChatRequest / ChatResponse 可通过 Zod 解析", () => {
    const req = ChatRequest.parse({
      question: "什么是 RAG？",
      knowledgeBaseId: "kb-1",
      messages: [{ role: "user", content: "你好" }],
    });

    const resp = ChatResponse.parse({
      answer: "RAG 是检索增强生成（Retrieval-Augmented Generation）…",
      sources: [
        {
          documentId: "doc-1",
          documentName: "01-项目规划与执行手册.md",
          chunkIndex: 3,
          snippet: "检索增强生成",
          score: 0.87,
        },
      ],
      elapsedMs: 123,
    });

    expect(req.question).toBe("什么是 RAG？");
    expect(resp.sources[0].documentName).toContain(".md");
    expect(resp.sources[0].score).toBeCloseTo(0.87);
  });

  it("非法 ChatRequest（空 question）应被拒绝", () => {
    const result = ChatRequest.safeParse({
      question: "",
      knowledgeBaseId: "kb-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("POST /api/retrieve（MCP server 调用的纯检索端点）", () => {
  it("合法 RetrieveRequest 返回 200 且 hits 符合 RetrieveResponse 契约", async () => {
    // 用内存级 mock 依赖组装（不碰磁盘）：mock embedding + 临时目录 TriviumDB
    const embedding = new MockEmbeddingProvider();
    const store = new TriviumDBStore({ dataDir: "./.tmp-retrieve-test", dim: EMBEDDING_DIM });
    const retrieveService = new RetrieveService(embedding, store);
    const app = createApp({ retrieveService, llmProvider: { async generate(p) { return { answer: "mock" }; }, async *stream(p) { yield { delta: "mock" }; } } });
    mountProductionHandlers(app, {
      ingest: async () => new Response("{}", { status: 501 }),
      listDocuments: async () => new Response("[]", { status: 200 }),
      retrieve: async (c: any) => {
        const raw = await c.req.json().catch(() => null);
        const parsed = RetrieveRequest.safeParse(raw);
        if (!parsed.success) return c.json({ error: "非法请求体" }, 422);
        const result = await retrieveService.retrieve(parsed.data);
        return c.json(RetrieveResponse.parse(result), 200);
      },
      listChatLogs: async () => new Response('{"total":0,"entries":[]}', { status: 200 }),
      listKnowledgeBases: async () => new Response("[]", { status: 200 }),
    });

    const res = await app.request("/api/retrieve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "什么是 RAG？",
        knowledgeBaseId: "kb-1",
        topK: 3,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(RetrieveResponse.safeParse(body).success).toBe(true);
  });

  it("非法 RetrieveRequest（缺 question）返回 422", async () => {
    const app = createApp();
    mountProductionHandlers(app, {
      ingest: async () => new Response("{}", { status: 501 }),
      listDocuments: async () => new Response("[]", { status: 200 }),
      retrieve: async (c: any) => {
        const raw = await c.req.json().catch(() => null);
        const parsed = RetrieveRequest.safeParse(raw);
        if (!parsed.success) return c.json({ error: "非法请求体" }, 422);
        return c.json(RetrieveResponse.parse({ hits: [] }), 200);
      },
      listChatLogs: async () => new Response('{"total":0,"entries":[]}', { status: 200 }),
      listKnowledgeBases: async () => new Response("[]", { status: 200 }),
    });

    const res = await app.request("/api/retrieve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledgeBaseId: "kb-1" }),
    });

    expect(res.status).toBe(422);
  });
});
