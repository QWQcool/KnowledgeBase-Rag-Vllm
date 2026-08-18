import { describe, expect, it, vi } from "vitest";
import {
  ChatResponse,
  type RetrievalHit,
} from "@rag/shared";
import { createApp } from "../app";
import { MockLLMProvider } from "../query/llm-provider";
import {
  createAgenticRagService,
  type GradeDecision,
  type RouteDecision,
} from "./agentic-rag";

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

function fakeDecisionMaker(route: RouteDecision, grade: GradeDecision) {
  return {
    async decideRoute() {
      return route;
    },
    async gradeDocuments() {
      return grade;
    },
  };
}

describe("AgenticRagService (LangGraph)", () => {
  it("路由走 RAG 且检索片段相关：返回带引用回答，检索被调用一次", async () => {
    const retrieve = vi.fn(async () => ({ hits: HITS }));
    const service = createAgenticRagService({
      retrieveService: { retrieve },
      llmProvider: new MockLLMProvider(),
      decisionMaker: fakeDecisionMaker(
        { needsRag: true, reason: "test" },
        { relevant: true, reason: "test" },
      ),
    });

    const resp = await service.query({
      question: "什么是 RAG？",
      knowledgeBaseId: "kb-1",
    });

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(resp.answer).toContain(HITS[0].chunk.content.slice(0, 20));
    expect(resp.sources).toHaveLength(2);
    expect(ChatResponse.safeParse(resp).success).toBe(true);
  });

  it("路由判定不需要 RAG：不检索，直接走通识兜底", async () => {
    const retrieve = vi.fn();
    const service = createAgenticRagService({
      retrieveService: { retrieve },
      llmProvider: new MockLLMProvider(),
      decisionMaker: fakeDecisionMaker(
        { needsRag: false, reason: "greeting" },
        { relevant: true, reason: "never called" },
      ),
    });

    const resp = await service.query({
      question: "你好",
      knowledgeBaseId: "kb-1",
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(resp.sources).toEqual([]);
    expect(resp.answer).toContain("未检索到相关内容");
    expect(ChatResponse.safeParse(resp).success).toBe(true);
  });

  it("检索命中但相关性判定不足：走兜底，不把弱相关片段硬塞给生成", async () => {
    const retrieve = vi.fn(async () => ({ hits: HITS }));
    const service = createAgenticRagService({
      retrieveService: { retrieve },
      llmProvider: new MockLLMProvider(),
      decisionMaker: fakeDecisionMaker(
        { needsRag: true, reason: "test" },
        { relevant: false, reason: "low relevance" },
      ),
    });

    const resp = await service.query({
      question: "写一首宇宙飞船短诗",
      knowledgeBaseId: "kb-1",
    });

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(resp.sources).toEqual([]);
    expect(resp.answer).toContain("未检索到相关内容");
  });

  it("RuleBasedGraphDecisionMaker：高分段通过，低分段判为无关", async () => {
    const service = createAgenticRagService({
      retrieveService: { retrieve: async () => ({ hits: HITS }) },
      llmProvider: new MockLLMProvider(),
      minScore: 0.85,
    });

    const relevantResp = await service.query({
      question: "什么是 RAG？",
      knowledgeBaseId: "kb-1",
    });
    expect(relevantResp.sources).toHaveLength(2);

    const lowHits = [makeHit("doc-x", "低相关.md", "内容", 0.5)];
    const lowService = createAgenticRagService({
      retrieveService: { retrieve: async () => ({ hits: lowHits }) },
      llmProvider: new MockLLMProvider(),
      minScore: 0.85,
    });
    const lowResp = await lowService.query({
      question: "不相关问题",
      knowledgeBaseId: "kb-1",
    });
    expect(lowResp.sources).toEqual([]);
  });
});

describe("POST /api/query/graph 端点", () => {
  it("注入 AgenticRagService 后返回 ChatResponse 契约", async () => {
    const agenticRagService = createAgenticRagService({
      retrieveService: { retrieve: async () => ({ hits: HITS }) },
      llmProvider: new MockLLMProvider(),
      decisionMaker: fakeDecisionMaker(
        { needsRag: true, reason: "test" },
        { relevant: true, reason: "test" },
      ),
    });
    const app = createApp({ agenticRagService });

    const res = await app.request("/api/query/graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "什么是 RAG？", knowledgeBaseId: "kb-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ChatResponse.safeParse(body).success).toBe(true);
    expect((body as { sources: unknown[] }).sources).toHaveLength(2);
  });

  it("未注入服务时返回 501（Agentic RAG 未启用）", async () => {
    const app = createApp();
    const res = await app.request("/api/query/graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hi", knowledgeBaseId: "kb-1" }),
    });
    expect(res.status).toBe(501);
  });

  it("非法请求体返回 422", async () => {
    const agenticRagService = createAgenticRagService({
      retrieveService: { retrieve: async () => ({ hits: HITS }) },
      llmProvider: new MockLLMProvider(),
    });
    const app = createApp({ agenticRagService });

    const res = await app.request("/api/query/graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledgeBaseId: "kb-1" }),
    });
    expect(res.status).toBe(422);
  });
});
