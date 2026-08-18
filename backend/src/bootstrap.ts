import fs from "node:fs";
import path from "node:path";
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
import { getActiveLlmConfig } from "./infra/config";
import { TriviumDBStore } from "./infra/triviumdb-store";
import { IngestService } from "./ingest/ingest-service";
import { RetrieveService } from "./retrieval/retrieve-service";
import { createLLMProvider } from "./query/llm-provider";
import { FileChatLogWriter, readChatLogs } from "./query/chat-log";
import { createProductionAgenticRagService } from "./agentic/agentic-rag";

/**
 * bootstrap.ts —— 生产依赖组装（编排层）
 *
 * app.ts 保持纯函数（测试注入 mock），这里负责把真实实现串成完整流水线：
 *   Transformers/Mock/OpenAI兼容 embedding + TriviumDB + IngestService + RetrieveService + LLM
 * 环境变量（缺省智能探测，npm start 与 start-all.bat 行为一致）：
 *   RAG_EMBEDDING=mock|transformers|openai  （缺省：本地缓存存在→transformers；否则 mock 并提示）
 *   LLM_PROVIDER=mock|openai                （缺省：openai + 本机 Ollama :11434/v1 + qwen3:8b）
 */
export interface ProductionDeps {
  /** 默认知识库命名空间（演示/单库场景固定；多库由路由层传） */
  knowledgeBaseId: string;
  embedding: "mock" | "transformers" | "openai";
  llm: "mock" | "openai";
  /** 向量库数据目录（测试注入临时目录用；缺省读 TRIVIUM_DATA_DIR/config） */
  dataDir?: string;
}

/**
 * 智能默认值：LLM_PROVIDER / RAG_EMBEDDING 未显式设置时，
 * 探测本机环境给出与 start-all.bat 一致的默认，避免裸 npm start 静默落到 mock。
 */
export function resolveSmartDefaults(): {
  embedding: "mock" | "transformers" | "openai";
  llm: "mock" | "openai";
} {
  // LLM：默认本机 Ollama（OpenAI 兼容接口）；无 Ollama 也可显式设 LLM_PROVIDER=mock
  // 端点优先级：llm-config.json > 环境变量 > 内置默认（与 config.ts 一致）
  const llm =
    (process.env.LLM_PROVIDER as "mock" | "openai" | undefined) ?? "openai";
  const llmCfg = getActiveLlmConfig();
  if (llmCfg !== null && llm === "openai") {
    console.log(
      `[bootstrap] llm-config.json → engine=${llmCfg.engine}（${llmCfg.baseUrl} / ${llmCfg.model}）`,
    );
  } else if (process.env.LLM_PROVIDER === undefined) {
    process.env.OPENAI_BASE_URL ??= "http://127.0.0.1:11434/v1";
    process.env.OPENAI_MODEL ??= "qwen3:8b";
    process.env.OPENAI_API_KEY ??= "ollama";
    console.log(
      "[bootstrap] LLM_PROVIDER 未设置 → 默认 openai + Ollama(qwen3:8b @127.0.0.1:11434)",
    );
  }

  // Embedding：本地缓存存在 → transformers（离线稳）；否则 mock 并提示（HF 被拦时避免卡下载）
  let embedding: "mock" | "transformers" | "openai";
  if (process.env.RAG_EMBEDDING !== undefined) {
    embedding = process.env.RAG_EMBEDDING as "mock" | "transformers" | "openai";
  } else {
    const localCache =
      process.env.RAG_EMBEDDING_LOCAL_CACHE ?? "C:\\models\\e5-small";
    if (fs.existsSync(localCache)) {
      embedding = "transformers";
      process.env.RAG_EMBEDDING_MODEL ??= localCache;
      console.log(
        `[bootstrap] RAG_EMBEDDING 未设置 → 检测到本地缓存 ${localCache}，默认 transformers`,
      );
    } else {
      embedding = "mock";
      console.warn(
        `[bootstrap] RAG_EMBEDDING 未设置且无本地缓存(${localCache}) → 回退 mock（随机向量，仅调试用）。` +
          `离线环境请先准备 embedding 缓存，或显式设 RAG_EMBEDDING=transformers/openai`,
      );
    }
  }
  return { embedding, llm };
}

export function createProductionDeps(
  overrides: Partial<ProductionDeps> = {},
): { deps: AppDeps; handlers: AppHandlers } {
  const smart = resolveSmartDefaults();
  const cfg: ProductionDeps = {
    knowledgeBaseId: overrides.knowledgeBaseId ?? "default",
    embedding: overrides.embedding ?? smart.embedding,
    llm: overrides.llm ?? smart.llm,
    dataDir: overrides.dataDir,
  };

  const embedding = createEmbeddingProvider(cfg.embedding);
  const store = new TriviumDBStore(
    cfg.dataDir !== undefined ? { dataDir: cfg.dataDir } : undefined,
  );
  const retrieveService = new RetrieveService(embedding, store);
  const llmProvider = createLLMProvider(cfg.llm);
  // RAG_GRAPH_ENABLED=0/false 可完全关闭 LangGraph Agentic RAG（端点返回 501，不创建图服务）
  const agenticRagService =
    process.env.RAG_GRAPH_ENABLED === "0" || process.env.RAG_GRAPH_ENABLED === "false"
      ? undefined
      : createProductionAgenticRagService({ retrieveService, llmProvider });
  // 对话日志：生产落盘到 backend/data/chat-logs/（data/ 已 gitignore，不进 git）
  const chatLog = new FileChatLogWriter();
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
    async listChatLogs(c) {
      // 对话日志查看入口：GET /api/chat-logs?date=YYYY-MM-DD&limit=N
      const date = c.req.query("date") ?? undefined;
      const limitRaw = Number(c.req.query("limit") ?? 100);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
      const entries = readChatLogs(undefined, { date, limit });
      return c.json({ total: entries.length, entries });
    },
    async listKnowledgeBases(c) {
      // 多知识库：扫描 data/trivium/ 下 *.tdb.* 文件（TriviumDB 实际落盘为 .tdb.wal/.tdb.lock）
      // 反推库 id（default→default.tdb.*）。smoke 是测试残留，过滤掉。
      const dir = path.resolve(process.cwd(), "data", "trivium");
      const kbs: { id: string; name: string; documentIds: string[] }[] = [];
      const seen = new Set<string>();
      try {
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            const m = f.match(/^(.+)\.tdb\./);
            if (!m || seen.has(m[1])) continue;
            const id = m[1];
            if (id === "smoke") continue; // vitest 测试库，非用户数据
            seen.add(id);
            kbs.push({ id, name: id, documentIds: [] });
          }
        }
      } catch (err) {
        console.warn(`[bootstrap] 扫描知识库失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return c.json(kbs);
    },
  };

  return { deps: { retrieveService, llmProvider, chatLog, agenticRagService }, handlers };
}

/** 生产路由挂载：把 handlers 注册到 app（app.ts 里统一调用） */
export function mountProductionHandlers(app: Hono, handlers: AppHandlers) {
  app.post(`${API_PREFIX}/ingest`, handlers.ingest);
  app.get(`${API_PREFIX}/documents`, handlers.listDocuments);
  app.post(`${API_PREFIX}/retrieve`, handlers.retrieve);
  app.get(`${API_PREFIX}/chat-logs`, handlers.listChatLogs);
  app.get(`${API_PREFIX}/knowledge-bases`, handlers.listKnowledgeBases);
}