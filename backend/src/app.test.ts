import { describe, expect, it } from "vitest";
import {
  ChatRequest,
  ChatResponse,
  HealthStatus,
} from "@rag/shared";
import { createApp } from "./app";

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

  it("GET /api/knowledge-bases 返回空数组", async () => {
    const app = createApp();
    const res = await app.request("/api/knowledge-bases");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
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
