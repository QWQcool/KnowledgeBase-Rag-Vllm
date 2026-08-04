import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STREAM_QUERY_PATH,
  type ChatRequest,
  type RetrievalHit,
  type StreamingEvent,
} from "@rag/shared";
import { createApp } from "../app";
import { MockLLMProvider, OpenAICompatibleLLMProvider } from "./llm-provider";
import {
  createQueryService,
  type RetrieveService,
} from "./query-service";
import type { LLMProvider } from "../infra/types";

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

/** 收集 async generator 的所有事件 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

const REQ: ChatRequest = {
  question: "什么是 RAG？",
  knowledgeBaseId: "kb-1",
};

describe("queryService.streamQuery", () => {
  it("命中 2 条：事件序列 = sources(2) → token*(delta 非空) → done(elapsedMs>=0)", async () => {
    const service = createQueryService({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: new MockLLMProvider(),
    });

    const events = await collect(service.streamQuery(REQ));

    // 首事件 sources，2 条
    expect(events[0].type).toBe("sources");
    if (events[0].type !== "sources") return;
    expect(events[0].sources).toHaveLength(2);

    // 末事件 done
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    if (last.type !== "done") return;
    expect(last.elapsedMs).toBeGreaterThanOrEqual(0);

    // 中间全是 token，且 delta 非空
    const tokens = events.slice(1, -1);
    expect(tokens.length).toBeGreaterThan(0);
    for (const ev of tokens) {
      expect(ev.type).toBe("token");
      if (ev.type === "token") {
        expect(ev.delta.length).toBeGreaterThan(0);
      }
    }
  });

  it("空命中：事件序列 = sources([]) → done(带 message)", async () => {
    const service = createQueryService({
      retrieveService: retrieveServiceWith([]),
      llmProvider: new MockLLMProvider(),
    });

    const events = await collect(service.streamQuery(REQ));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("sources");
    if (events[0].type !== "sources") return;
    expect(events[0].sources).toEqual([]);

    expect(events[1].type).toBe("done");
    if (events[1].type !== "done") return;
    expect(typeof events[1].message).toBe("string");
    expect(events[1].message!.length).toBeGreaterThan(0);
  });

  it("LLM 异常：事件序列 = sources(...) → error(message 非空)", async () => {
    // mock 一个 stream() 会 throw 的 LLMProvider
    const failingProvider: LLMProvider = {
      async generate() {
        return { answer: "should not be called" };
      },
      async *stream() {
        throw new Error("boom");
      },
    };

    const service = createQueryService({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: failingProvider,
    });

    const events = await collect(service.streamQuery(REQ));

    // 首事件仍是 sources（检索已成功）
    expect(events[0].type).toBe("sources");
    // 末事件 error
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    if (last.type !== "error") return;
    expect(last.message.length).toBeGreaterThan(0);
  });
});

describe("POST /api/query/stream 端点", () => {
  it("合法请求 → 200，content-type 含 text/event-stream，body 含 sources/token/done 事件", async () => {
    const app = createApp({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: new MockLLMProvider(),
    });

    const res = await app.request(STREAM_QUERY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    // 解析 SSE 文本：每条形如 `data: {JSON}\n\n`
    const text = await res.text();
    const chunks = text
      .split("\n\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("data:"))
      .map((s) => JSON.parse(s.slice("data:".length).trim()) as StreamingEvent);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].type).toBe("sources");
    const last = chunks[chunks.length - 1];
    expect(last.type === "done" || last.type === "error").toBe(true);
  });

  it("非法 body（缺 knowledgeBaseId）→ 422", async () => {
    const app = createApp({
      retrieveService: retrieveServiceWith(HITS),
      llmProvider: new MockLLMProvider(),
    });

    const res = await app.request(STREAM_QUERY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hi" }),
    });

    expect(res.status).toBe(422);
  });
});

describe("OpenAICompatibleLLMProvider.stream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("用 SSE 解析 choices[0].delta.content 并逐段 yield", async () => {
    // 模拟 OpenAI 流式响应：两条 data 行 + [DONE]
    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "世界" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleLLMProvider({
      baseUrl: "https://example.com/v1",
      model: "test-model",
      apiKey: "sk-test",
    });

    const deltas: string[] = [];
    for await (const { delta } of provider.stream({
      systemPrompt: "你是助手",
      contextChunks: [{ content: "片段A", source: "doc-1" }],
      question: "你好",
    })) {
      deltas.push(delta);
    }

    expect(deltas.join("")).toBe("你好世界");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(true);
    expect(body.model).toBe("test-model");
  });
});
