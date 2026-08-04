import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./create-server.js";

/**
 * index.ts —— MCP server 入口（stdio transport）
 *
 * 运行：npm start。MCP 客户端通过标准输入/输出连接本 server。
 * 环境变量：
 *   RAG_BACKEND_URL   backend 地址（缺省 http://localhost:3000）
 *   RAG_MCP_MOCK=1    mock 模式（不调 backend）
 */
const server = createServer({
  backendUrl: process.env.RAG_BACKEND_URL,
  useMock: process.env.RAG_MCP_MOCK === "1",
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[rag-mcp] server 已启动（stdio）${process.env.RAG_MCP_MOCK === "1" ? "[mock 模式]" : `→ backend ${process.env.RAG_BACKEND_URL ?? "http://localhost:3000"}`}`,
);
