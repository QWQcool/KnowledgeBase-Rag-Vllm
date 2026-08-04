import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * create-server.ts —— MCP server 工厂（可测试）
 *
 * 与 index.ts 分离：工厂返回 server 实例（不 connect），测试用 InMemoryTransport
 * 直接挂 Client 验证；index.ts 负责真正连接 stdio transport 启动。
 */

export interface ServerDeps {
  /** backend 地址（缺省 http://localhost:3000） */
  backendUrl?: string;
  /** true = mock 模式（不调 backend） */
  useMock?: boolean;
}

export function createServer(deps: ServerDeps = {}) {
  const backendUrl = deps.backendUrl ?? "http://localhost:3000";
  const useMock = deps.useMock ?? false;

  const server = new McpServer({
    name: "rag-knowledge-base",
    version: "0.2.0",
  });

  server.tool(
    "retrieve",
    {
      query: z.string().describe("用户问题，用于在知识库中做语义检索"),
      top_k: z.number().int().positive().default(5).describe("返回片段条数"),
      knowledge_base_id: z.string().default("default").describe("知识库 ID"),
    },
    async ({ query, top_k, knowledge_base_id }) => {
      let text: string;
      if (useMock) {
        text = `[mock] 知识库「${knowledge_base_id}」检索「${query}」top${top_k}：
1. （片段）RAG 是检索增强生成…（score 0.91）
2. （片段）文档被切成块后转成向量…（score 0.87）`;
      } else {
        const resp = await fetch(`${backendUrl}/api/retrieve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: query,
            knowledgeBaseId: knowledge_base_id,
            topK: top_k,
          }),
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => "");
          throw new Error(`backend /api/retrieve 失败: HTTP ${resp.status} ${detail}`);
        }
        const data = (await resp.json()) as {
          hits: { chunk: { content: string }; score: number }[];
        };
        if (data.hits.length === 0) {
          text = `知识库「${knowledge_base_id}」未检索到与「${query}」相关的内容。`;
        } else {
          text =
            `知识库「${knowledge_base_id}」检索「${query}」结果（top ${data.hits.length}）：\n\n` +
            data.hits
              .map(
                (h, i) =>
                  `${i + 1}. （score ${h.score.toFixed(3)}）\n${h.chunk.content.trim()}\n`,
              )
              .join("\n");
        }
      }
      return { content: [{ type: "text" as const, text }] };
    },
  );

  return server;
}
