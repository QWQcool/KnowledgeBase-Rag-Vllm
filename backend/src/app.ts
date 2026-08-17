import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  API_PREFIX,
  ChatRequest,
  ChatResponse,
  Document,
  EngineServiceStatus,
  EngineServicesStatus,
  HealthStatus,
  LlmEngine,
  LlmEngineEndpoint,
  LlmEngineStatus,
  LlmEngineUpdateRequest,
  STREAM_QUERY_PATH,
  ok,
} from "@rag/shared";
import type { LLMProvider } from "./infra/types";
import {
  getLlmConfigField,
  loadLlmConfig,
  resolveActiveEngine,
  resolveLlmConfigPath,
  updateLlmConfigEngine,
} from "./infra/config";
import { createLLMProvider } from "./query/llm-provider";
import { scheduleSelfRestart } from "./restart";
import {
  DefaultEngineServiceManager,
  type EngineServiceManager,
} from "./engine-service";
import {
  createQueryService,
  type QueryService,
  type RetrieveService,
} from "./query/query-service";
import type { ChatLogWriter } from "./query/chat-log";
import {
  createProductionDeps,
  mountProductionHandlers,
} from "./bootstrap";
import { gpuStatus, GPU_LEVELS, type GpuLevel, type GpuProbe, NvidiaSmiProbe } from "./gpu/gpu-status";
import {
  createMockOllamaManager,
  type OllamaManager,
  SpawnOllamaManager,
} from "./gpu/ollama-manager";

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
  /** 对话日志写入器（生产由 bootstrap 注入 FileChatLogWriter；测试缺省 no-op） */
  chatLog?: ChatLogWriter;
  /** 显存探测（生产缺省 NvidiaSmiProbe；测试可注入 mock） */
  gpuProbe?: GpuProbe;
  /** Ollama 进程管理（生产缺省 SpawnOllamaManager；测试注入 mock 防杀进程） */
  ollamaManager?: OllamaManager;
  /** 引擎切换后的自重启调度（生产缺省：非 test 环境自动重启后端；测试注入 no-op） */
  restartScheduler?: () => void;
  /** 推理引擎服务管理（启动/停止/健康轮询；测试注入 mock 防真启动 vLLM/Ollama） */
  engineServiceManager?: EngineServiceManager;
}

/** 生产额外路由的处理器签名（bootstrap.ts 提供实现） */
export interface AppHandlers {
  ingest: (c: any) => Promise<Response>;
  listDocuments: (c: any) => Promise<Response>;
  retrieve: (c: any) => Promise<Response>;
  listChatLogs: (c: any) => Promise<Response>;
  listKnowledgeBases: (c: any) => Promise<Response>;
}

/** 缺省检索实现：Retrieval Agent 交付前返回空命中（不造假检索结果） */
const emptyRetrieveService: RetrieveService = {
  async retrieve() {
    return { hits: [] };
  },
};

/** 缺省引擎服务管理器：读 llm-config.json 端点配置；测试环境禁 spawn（不真启动服务） */
function createDefaultEngineServiceManager(): EngineServiceManager {
  const cfg = loadLlmConfig();
  const engines: Record<LlmEngine, LlmEngineEndpoint> = {
    ollama: {
      baseUrl: cfg?.engines.ollama?.baseUrl ?? "http://127.0.0.1:11434/v1",
      model: cfg?.engines.ollama?.model ?? "qwen3:8b",
      apiKey: cfg?.engines.ollama?.apiKey,
    },
    vllm: {
      baseUrl: cfg?.engines.vllm?.baseUrl ?? "http://127.0.0.1:8000/v1",
      model: cfg?.engines.vllm?.model ?? "qwen3-8b-awq",
      apiKey: cfg?.engines.vllm?.apiKey,
    },
  };
  return new DefaultEngineServiceManager({
    engines,
    allowSpawn: process.env.NODE_ENV !== "test",
  });
}

/** 确保目标引擎服务运行；就绪后触发后端自重启（切换流程的最后一步） */
async function ensureEngineAndRestart(
  engine: LlmEngine,
  serviceManager: EngineServiceManager,
  scheduler: () => void,
): Promise<void> {
  try {
    const before = await serviceManager.getStatus(engine);
    if (before.state !== "running") {
      await serviceManager.start(engine); // 内部健康轮询直到就绪/超时（vLLM 最长 5 分钟）
    }
    // 服务就绪（或已 running）→ 重启后端加载新引擎配置
    scheduler();
  } catch (err) {
    console.error(
      `[engine-service] 启动 ${engine} 失败：`,
      err instanceof Error ? err.message : err,
    );
    // 启动失败不重启后端：保持旧引擎可用，前端会看到 error 状态
  }
}

export function createApp(deps?: Partial<AppDeps>) {
  const app = new Hono();

  app.use(`${API_PREFIX}/*`, cors());

  // 引擎切换后的自重启：生产默认自动重启（响应发出后 600ms 拉起新进程），测试环境 no-op
  const restartScheduler: () => void =
    deps?.restartScheduler ?? (process.env.NODE_ENV === "test" ? () => {} : scheduleSelfRestart);

  // 引擎服务管理：生产默认真实管理（可 spawn vLLM/Ollama），测试环境禁 spawn
  const engineServiceManager: EngineServiceManager =
    deps?.engineServiceManager ?? createDefaultEngineServiceManager();

  const queryService: QueryService = createQueryService({
    retrieveService: deps?.retrieveService ?? emptyRetrieveService,
    llmProvider: deps?.llmProvider ?? createLLMProvider(),
    chatLog: deps?.chatLog,
  });

  // 运行时切换的档位覆盖（内存态，GET /api/gpu 优先读它；启动档位仍来自 env）
  let gpuLevelOverride: GpuLevel | null = null;

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

  // GET /api/knowledge-bases 由生产 handler 提供真实列表（bootstrap mount 时覆盖）；
  // 此处不再注册占位，避免先注册的 [] 遮蔽真实数据。

  // POST /api/chat —— 未实现，明确返回 501 而非 404/误导性数据
  app.post(`${API_PREFIX}/chat`, (c) =>
    c.json(ok({ message: "RAG 问答在 M2 实现" }), 501),
  );

  // ================= M2 问答编排 =================

  // GET /api/model —— 模型信息（代理推理层，前端免跨域）
  // 双协议适配：llama.cpp 的 /v1/models 带结构化 meta；Ollama 的 /v1/models 只有
  // 标准 OpenAI 字段（无 meta），需再探测其原生 /api/tags 补齐参数/量化/上下文等。
  app.get(`${API_PREFIX}/model`, async (c) => {
    // 端点优先级：llm-config.json → 环境变量 → 默认 8080（与 llm-provider 同一事实源）
    const baseUrl = (getLlmConfigField("baseUrl") ?? "http://127.0.0.1:8080/v1")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    try {
      const res = await fetch(`${baseUrl}/v1/models`);
      if (!res.ok) {
        return c.json({ error: `推理层返回 ${res.status}` }, 502);
      }
      const data = (await res.json()) as {
        data?: { id: string; meta?: Record<string, unknown> }[];
      };
      const m = data?.data?.[0];
      if (!m) return c.json({ error: "未发现模型" }, 404);
      // llama.cpp 格式：meta 存在则直接透传
      if (m.meta) {
        return c.json({
          id: m.id,
          meta: m.meta,
          raw: { n_vocab: m.meta.n_vocab, ftype: m.meta.ftype },
        });
      }
      // Ollama 格式：/v1/models 无 meta → 探测 /api/tags 补齐
      try {
        const tagsRes = await fetch(`${baseUrl}/api/tags`);
        if (tagsRes.ok) {
          const tags = (await tagsRes.json()) as {
            models?: {
              name: string;
              size: number;
              details?: {
                parameter_size?: string;
                quantization_level?: string;
                context_length?: number;
                embedding_length?: number;
              };
            }[];
          };
          const om = tags?.models?.find((x) => x.name === m.id) ?? tags?.models?.[0];
          if (om) {
            // "8.2B" → 8.2e9（前端 fmtParams 按 /1e9 显示）
            const psize = om.details?.parameter_size;
            const nParams = psize
              ? Math.round(parseFloat(psize) * 1e9)
              : undefined;
            const ctx = om.details?.context_length;
            return c.json({
              id: om.name,
              meta: {
                n_params: nParams,
                ftype: om.details?.quantization_level,
                n_ctx: ctx,
                n_ctx_train: ctx,
                n_embd: om.details?.embedding_length,
                size: om.size,
              },
              raw: { source: "ollama" },
            });
          }
        }
      } catch {
        // Ollama 探测失败则降级返回基础信息
      }
      return c.json({ id: m.id, meta: null, raw: {} });
    } catch {
      return c.json(
        { error: "无法连接推理层，请检查是否启动" },
        502,
      );
    }
  });

  // GET /api/mcp-tools —— MCP 工具列表（mcp-server 注册的 retrieve 工具）
  app.get(`${API_PREFIX}/mcp-tools`, (c) =>
    c.json({
      servers: [
        {
          name: "rag-knowledge",
          status: "connected",
          tools: [
            {
              name: "retrieve",
              description:
                "从知识库检索与 query 最相关的文档片段（RAG 检索）",
              inputSchema: {
                query: "string",
                top_k: "number",
                knowledge_base_id: "string",
              },
            },
          ],
        },
      ],
    }),
  );

  // ================= 推理引擎切换（llm-config.json 持久化） =================

  // GET /api/llm-engine —— 当前生效引擎 + 全量配置 + 配置文件路径
  app.get(`${API_PREFIX}/llm-engine`, (c) => {
    const file = loadLlmConfig();
    if (!file) {
      return c.json(
        { error: `llm-config.json（${resolveLlmConfigPath()}）不存在或已损坏` },
        500,
      );
    }
    // engine 取「当前生效」值：RAG_LLM_ENGINE 环境变量会覆盖 JSON 的 engine 字段
    const body = LlmEngineStatus.parse({
      engine: resolveActiveEngine(file),
      engines: file.engines,
      configPath: resolveLlmConfigPath(),
      requiresRestart: true,
    });
    return c.json(body);
  });

  // PUT /api/llm-engine —— 切换引擎：仅改写 llm-config.json 的 engine 字段（不写环境变量）。
  // 推理层是重资源进程，无法热切换——保存成功后需重启后端才生效（前端提示用户）。
  app.put(`${API_PREFIX}/llm-engine`, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = LlmEngineUpdateRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "非法引擎：可选 ollama / vllm", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const file = updateLlmConfigEngine(parsed.data.engine);
      const body = LlmEngineStatus.parse({
        engine: resolveActiveEngine(file),
        engines: file.engines,
        configPath: resolveLlmConfigPath(),
        requiresRestart: true,
      });
      const resp = c.json(body);
      // 异步：确保目标引擎服务运行（未跑则自动拉起 + 健康轮询）→ 就绪后自重启后端加载新配置
      // 响应先返回；服务启动进度由前端轮询 GET /api/engine-services 获取
      setTimeout(
        () => void ensureEngineAndRestart(parsed.data.engine, engineServiceManager, restartScheduler),
        0,
      );
      return resp;
    } catch (err) {
      return c.json(
        {
          error: "写入 llm-config.json 失败，请检查文件是否只读/被占用",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  // GET /api/engine-services —— 两个引擎服务的实时状态（端口探测，不缓存）
  app.get(`${API_PREFIX}/engine-services`, async (c) => {
    const [ollama, vllm] = await Promise.all([
      engineServiceManager.getStatus("ollama"),
      engineServiceManager.getStatus("vllm"),
    ]);
    return c.json(EngineServicesStatus.parse({ ollama, vllm }));
  });

  // POST /api/engine-services/:engine/start —— 异步拉起服务并健康轮询，立即返回当前状态
  const svcStarting = new Set<LlmEngine>();
  app.post(`${API_PREFIX}/engine-services/:engine/start`, async (c) => {
    const raw = c.req.param("engine") as LlmEngine;
    if (!LlmEngine.safeParse(raw).success) return c.json({ error: "非法引擎" }, 400);
    if (!svcStarting.has(raw)) {
      svcStarting.add(raw);
      // 不 await：start 内部轮询可能持续数分钟，前端通过 GET 轮询进度
      void engineServiceManager.start(raw).finally(() => svcStarting.delete(raw));
    }
    return c.json(EngineServiceStatus.parse(await engineServiceManager.getStatus(raw)));
  });

  // POST /api/engine-services/:engine/stop —— 停止服务进程
  app.post(`${API_PREFIX}/engine-services/:engine/stop`, async (c) => {
    const raw = c.req.param("engine") as LlmEngine;
    if (!LlmEngine.safeParse(raw).success) return c.json({ error: "非法引擎" }, 400);
    return c.json(EngineServiceStatus.parse(await engineServiceManager.stop(raw)));
  });

  // GET /api/gpu —— 显存状态与推理档位建议（自适应显存）
  app.get(`${API_PREFIX}/gpu`, async (c) => {
    const status = await gpuStatus(
      deps?.gpuProbe ?? new NvidiaSmiProbe(),
      process.env,
      gpuLevelOverride,
    );
    return c.json(status);
  });

  // POST /api/gpu/level —— 手动切换推理档位（重启 Ollama，需显存充足）
  app.post(`${API_PREFIX}/gpu/level`, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const level = (raw as { level?: unknown } | null)?.level;
    if (
      typeof level !== "string" ||
      !(level === "HIGH" || level === "MID" || level === "LOW")
    ) {
      return c.json({ error: "非法档位：可选 HIGH / MID / LOW" }, 422);
    }
    const target = GPU_LEVELS[level as GpuLevel];

    // 显存校验：目标档位在当前"可用显存"下必须可行。
    // 注意：当前已加载模型会在重启时卸载释放，其占用要算入可用量
    // （否则模型驻留时会误判"显存不足"拒绝切档）。
    const probe = deps?.gpuProbe ?? new NvidiaSmiProbe();
    const manager = deps?.ollamaManager ?? new SpawnOllamaManager();
    const info = await probe.probe();
    if (info.supported && info.freeMiB !== null && info.freeMiB < target.minFreeMiB) {
      const releasable = await manager.estimateOllamaVramMiB();
      const effectiveFree = info.freeMiB + releasable;
      if (effectiveFree < target.minFreeMiB) {
        return c.json(
          {
            error: `当前空闲显存 ${info.freeMiB} MiB（含模型释放后 ${effectiveFree} MiB）不足以运行「${target.label}」（需 ≥${target.minFreeMiB} MiB），请先关闭部分占显存软件`,
          },
          400,
        );
      }
    }

    const result = await manager.restart(level as GpuLevel);
    if (result.ok) {
      gpuLevelOverride = level as GpuLevel;
    }
    return c.json({ ok: result.ok, message: result.message, level });
  });

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
