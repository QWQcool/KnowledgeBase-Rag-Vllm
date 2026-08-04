import { describe, expect, it, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./create-server.js";

/**
 * 测试策略：用 SDK 官方 Client + InMemoryTransport 连接 server（进程内，
 * 不 spawn 子进程），走完整 MCP 协议（initialize → tools/list → tools/call）。
 */

async function connectServer(deps: Parameters<typeof createServer>[0]) {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP server 工具注册", () => {
  it("tools/list 返回 retrieve 工具且参数 schema 正确", async () => {
    const { client, server } = await connectServer({ useMock: true });

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    const tool = tools.tools[0];
    expect(tool.name).toBe("retrieve");
    // JSON Schema：query 必填字符串、top_k 默认 5
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.query.type).toBe("string");
    expect(props.top_k.default).toBe(5);
    expect(tool.inputSchema.required).toContain("query");

    await client.close();
  });
});

describe("retrieve 工具（mock 模式）", () => {
  it("调用返回 mock 检索片段（含 query 与 top_k）", async () => {
    const { client, server } = await connectServer({ useMock: true });

    const result = await client.callTool({
      name: "retrieve",
      arguments: { query: "什么是 RAG？", top_k: 3, knowledge_base_id: "kb-demo" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text.text).toContain("[mock]");
    expect(text.text).toContain("什么是 RAG？");
    expect(text.text).toContain("top3");

    await client.close();
  });
});

describe("retrieve 工具（真实模式，调 backend /api/retrieve）", () => {
  it("backend 返回 hits 时按 markdown 格式化", async () => {
    // mock fetch：模拟 backend 返回 2 个命中
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hits: [
          { chunk: { content: "RAG 是检索增强生成" }, score: 0.91 },
          { chunk: { content: "文档切成块转成向量" }, score: 0.87 },
        ],
      }),
    })));

    const { client, server } = await connectServer({ backendUrl: "http://test-backend" });
    const result = await client.callTool({
      name: "retrieve",
      arguments: { query: "什么是 RAG？", top_k: 2 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text.text).toContain("top 2");
    expect(text.text).toContain("0.910");
    expect(text.text).toContain("RAG 是检索增强生成");

    // 确认 fetch 调了正确端点
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test-backend/api/retrieve",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"topK":2'),
      }),
    );

    await client.close();
  });

  it("backend 无命中时返回未找到提示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ hits: [] }),
    })));

    const { client, server } = await connectServer({ backendUrl: "http://test-backend" });
    const result = await client.callTool({
      name: "retrieve",
      arguments: { query: "天气如何", top_k: 5 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text.text).toContain("未检索到");

    await client.close();
  });

  it("backend 返回错误时以 isError 结果返回（MCP 协议：错误不抛，标记 isError）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "server error",
    })));

    const { client, server } = await connectServer({ backendUrl: "http://test-backend" });
    const result = await client.callTool({
      name: "retrieve",
      arguments: { query: "hi", top_k: 5 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text.text).toContain("500");
    expect(text.text).toContain("server error");

    await client.close();
  });
});
