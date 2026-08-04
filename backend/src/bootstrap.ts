import {
  API_PREFIX,
  IngestRequest,
  IngestResponse,
  RetrieveRequest,
  RetrieveResponse,
  type Document,
} from "@rag/shared";
import { Hono } from "hono";
import type { AppDeps, AppHandlers } from "./app";
import { createEmbeddingProvider } from "./infra/embedding";
import { TriviumDBStore } from "./infra/triviumdb-store";
import { IngestService } from "./ingest/ingest-service";
import { RetrieveService } from "./retrieval/retrieve-service";
import { createLLMProvider } from "./query/llm-provider";

/**
 * bootstrap.ts —— 生产依赖组装（编排层）
 *
 * app.ts 保持纯函数（测试注入 mock），这里负责把真实实现串成完整流水线：
 *   Transformers/Mock embedding + TriviumDB + IngestService + RetrieveService + LLM
 * 环境变量：
 *   RAG_EMBEDDING=mock|transformers   （缺省 mock：离线/CI 稳，transformers 需下载模型）
 *   LLM_PROVIDER=mock|openai          （缺省 mock；openai 需 OPENAI_BASE_URL/KEY，M4 指向 llama-server）
 */
export interface ProductionDeps {
  /** 默认知识库命名空间（演示/单库场景固定；多库由路由层传） */
  knowledgeBaseId: string;
  embedding: "mock" | "transformers";
  llm: "mock" | "openai";
  /** 向量库数据目录（测试注入临时目录用；缺省读 TRIVIUM_DATA_DIR/config） */
  dataDir?: string;
}

export function createProductionDeps(
  overrides: Partial<ProductionDeps> = {},
): { deps: AppDeps; handlers: AppHandlers } {
  const cfg: ProductionDeps = {
    knowledgeBaseId: overrides.knowledgeBaseId ?? "default",
    embedding: overrides.embedding ?? (process.env.RAG_EMBEDDING as any) ?? "mock",
    llm: overrides.llm ?? (process.env.LLM_PROVIDER as any) ?? "mock",
    dataDir: overrides.dataDir,
  };

  const embedding = createEmbeddingProvider(cfg.embedding);
  const store = new TriviumDBStore(
    cfg.dataDir !== undefined ? { dataDir: cfg.dataDir } : undefined,
  );
  const retrieveService = new RetrieveService(embedding, store);
  const llmProvider = createLLMProvider(cfg.llm);

  // ingest 依赖注入到路由处理器（AppHandlers 里接 /api/ingest）
  const ingestService = new IngestService({
    embeddingProvider: embedding,
    vectorStore: store,
  });

  const handlers: AppHandlers = {
    async ingest(c) {
      const raw = await c.req.json().catch(() => null);
      const parsed = IngestRequest.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: "非法请求体", issues: parsed.error.issues }, 422);
      }
      const result: IngestResponse = await ingestService.ingest(parsed.data);
      return c.json(IngestResponse.parse(result), 201);
    },
    async listDocuments(c) {
      // M2 简化：知识库内文档列表从向量库表反查暂缺，先返回空占位
      // （文档元数据持久化在 M3 知识库管理里程碑补齐）
      const docs: Document[] = [];
      return c.json(docs);
    },
    async retrieve(c) {
      // MCP server 等外部调用方：纯检索端点（不做 LLM 生成）
      const raw = await c.req.json().catch(() => null);
      const parsed = RetrieveRequest.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: "非法请求体", issues: parsed.error.issues }, 422);
      }
      const result: RetrieveResponse = await retrieveService.retrieve(parsed.data);
      return c.json(RetrieveResponse.parse(result), 200);
    },
  };

  return { deps: { retrieveService, llmProvider }, handlers };
}

/** 生产路由挂载：把 handlers 注册到 app（app.ts 里统一调用） */
export function mountProductionHandlers(app: Hono, handlers: AppHandlers) {
  app.post(`${API_PREFIX}/ingest`, handlers.ingest);
  app.get(`${API_PREFIX}/documents`, handlers.listDocuments);
  app.post(`${API_PREFIX}/retrieve`, handlers.retrieve);
}
