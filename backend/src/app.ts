import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  API_PREFIX,
  ChatRequest,
  ChatResponse,
  Document,
  HealthStatus,
  KnowledgeBase,
  STREAM_QUERY_PATH,
  ok,
} from "@rag/shared";
import type { LLMProvider } from "./infra/types";
import { createLLMProvider } from "./query/llm-provider";
import {
  createQueryService,
  type QueryService,
  type RetrieveService,
} from "./query/query-service";
import {
  createProductionDeps,
  mountProductionHandlers,
} from "./bootstrap";

/**
 * 应用工厂：测试与启动共用同一份路由。
 * 测试用 app.request() 直接调用，不监听端口。
 *
 * 依赖注入：queryService 依赖的 retrieveService / LLMProvider 由 createApp 构造，
 * 测试可传假实现，生产用缺省（LLM 走 createLLMProvider，检索在 Retrieval Agent
 * 交付前先用空命中占位，避免伪造数据）。
 */
export interface AppDeps {
  retrieveService: RetrieveService;
  llmProvider: LLMProvider;
}

/** 生产额外路由的处理器签名（bootstrap.ts 提供实现） */
export interface AppHandlers {
  ingest: (c: any) => Promise<Response>;
  listDocuments: (c: any) => Promise<Response>;
  retrieve: (c: any) => Promise<Response>;
}

/** 缺省检索实现：Retrieval Agent 交付前返回空命中（不造假检索结果） */
const emptyRetrieveService: RetrieveService = {
  async retrieve() {
    return { hits: [] };
  },
};

export function createApp(deps?: Partial<AppDeps>) {
  const app = new Hono();

  app.use(`${API_PREFIX}/*`, cors());

  const queryService: QueryService = createQueryService({
    retrieveService: deps?.retrieveService ?? emptyRetrieveService,
    llmProvider: deps?.llmProvider ?? createLLMProvider(),
  });

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

  // ================= M2 问答编排 =================

  // POST /api/query —— 问答编排（M3 加流式 SSE）
  app.post(`${API_PREFIX}/query`, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ChatRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "非法请求体", issues: parsed.error.issues },
        422,
      );
    }

    const response = await queryService.query(parsed.data);
    // 响应再经契约校验一遍：ChatResponse 是唯一事实源
    return c.json(ChatResponse.parse(response));
  });

  // POST /api/query/stream —— 流式问答（M3 SSE）
  app.post(STREAM_QUERY_PATH, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ChatRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "非法请求体", issues: parsed.error.issues },
        422,
      );
    }

    return streamSSE(c, async (stream) => {
      for await (const event of queryService.streamQuery(parsed.data)) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    });
  });

  return app;
}

/** 生产应用：真实依赖链组装（bootstrap.ts）+ 挂载 ingest/documents 路由 */
export function createProductionApp() {
  const { deps, handlers } = createProductionDeps();
  const app = createApp(deps);
  mountProductionHandlers(app, handlers);
  return app;
}

/** 默认实例（index.ts 启动时使用生产组装） */
export const app = createProductionApp();
