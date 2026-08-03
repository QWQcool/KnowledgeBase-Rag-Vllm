import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  API_PREFIX,
  Document,
  HealthStatus,
  KnowledgeBase,
  ok,
} from "@rag/shared";

/**
 * 应用工厂：测试与启动共用同一份路由。
 * 测试用 app.request() 直接调用，不监听端口。
 */
export function createApp() {
  const app = new Hono();

  app.use(`${API_PREFIX}/*`, cors());

  // ---- 健康检查 ----
  app.get("/health", (c) => {
    const body = HealthStatus.parse({
      status: "ok",
      version: "0.1.0",
      uptimeSec: Math.round(process.uptime()),
    });
    return c.json(body);
  });

  // ================= M1 空端点占位（M2 起填充实现） =================

  // GET /api/documents —— 文档列表（暂空）
  app.get(`${API_PREFIX}/documents`, (c) => c.json<Document[]>([]));

  // GET /api/knowledge-bases —— 知识库列表（暂空）
  app.get(`${API_PREFIX}/knowledge-bases`, (c) => c.json<KnowledgeBase[]>([]));

  // POST /api/chat —— 未实现，明确返回 501 而非 404/误导性数据
  app.post(`${API_PREFIX}/chat`, (c) =>
    c.json(ok({ message: "RAG 问答在 M2 实现" }), 501),
  );

  return app;
}

/** 默认实例（index.ts 启动时使用） */
export const app = createApp();
