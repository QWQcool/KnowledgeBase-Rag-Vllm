/**
 * shared/contract.ts —— 前后端唯一事实源（Single Source of Truth）
 *
 * 命名约定（M1 定死，后续里程碑不得改名）：
 *   - 类型 / 接口：PascalCase（Document、ChatRequest、ChatResponse）
 *   - 字段：camelCase（uploadedAt、knowledgeBaseId、chunkIndex）
 *   - 枚举值：kebab-case 小写字符串（"processing"、"user"），对 JSON/HTTP 友好
 *   - 每个结构体都配一个同名 Zod Schema（值），静态类型用 `z.infer` 推导，
 *     保证「运行时校验」与「编译期类型」永远一致。
 *
 * 引用方式：前后端统一 `import ... from "@rag/shared"`（npm workspaces 包，
 * 根 node_modules/@rag/shared 链接到本目录）。Zod 依赖提升到根 node_modules。
 */

import { z } from "zod";

/* ===================== 通用 ===================== */

/** 统一 API 响应信封：业务端点返回 { ok, data }（预留，后续里程碑启用） */
export interface Envelope<T> {
  ok: boolean;
  data: T;
}

export const ok = <T>(data: T): Envelope<T> => ({ ok: true, data });

/** 后端业务端点统一挂在此前缀下 */
export const API_PREFIX = "/api";

/* ===================== 健康检查 ===================== */

export const HealthStatus = z.object({
  status: z.literal("ok"),
  version: z.string().optional(),
  uptimeSec: z.number().int().nonnegative().optional(),
});
export type HealthStatus = z.infer<typeof HealthStatus>;

/* ===================== 文档 Document ===================== */

export const DocumentStatus = z.enum([
  "uploading",
  "processing",
  "ready",
  "failed",
  "deleted",
]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const DocumentSourceType = z.enum(["pdf", "md", "txt"]);
export type DocumentSourceType = z.infer<typeof DocumentSourceType>;

export const Document = z.object({
  id: z.string().min(1),
  /** 原始上传文件名 */
  filename: z.string().min(1),
  title: z.string().optional(),
  status: DocumentStatus,
  sourceType: DocumentSourceType,
  /** 文件字节数 */
  sizeBytes: z.number().int().nonnegative(),
  /** 解析后的分块数量（status=ready 后才有） */
  chunkCount: z.number().int().nonnegative().optional(),
  /** 失败原因（仅 status=failed） */
  error: z.string().nullable().optional(),
  /** ISO 8601 上传时间 */
  uploadedAt: z.string().datetime(),
});
export type Document = z.infer<typeof Document>;

/* ===================== 知识库 KnowledgeBase ===================== */

export const KnowledgeBase = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /** 归属该知识库的文档 id 列表 */
  documentIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type KnowledgeBase = z.infer<typeof KnowledgeBase>;

/* ===================== 问答 Chat ===================== */

export const ChatRole = z.enum(["user", "assistant"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** 回答引用来源：哪篇文档的哪一段（M3 引用溯源用） */
export const SourceRef = z.object({
  documentId: z.string().min(1),
  documentName: z.string().min(1),
  chunkIndex: z.number().int().nonnegative().optional(),
  snippet: z.string(),
  /** 检索相关度 0~1（可选） */
  score: z.number().min(0).max(1).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const ChatRequest = z.object({
  /** 用户问题 */
  question: z.string().min(1),
  /** 在哪个知识库内检索 */
  knowledgeBaseId: z.string().min(1),
  /** 多轮上下文（可选，最多 20 条） */
  messages: z.array(ChatMessage).max(20).optional(),
  /**
   * 是否开启思考模式（thinking）：true = 模型先思考再回答（流式先推 thinking 事件）；
   * false = 直接回答（更快）。缺省 true（默认开）。
   * 实现：转发给 llama-server 的 chat_template_kwargs.enable_thinking。
   */
  thinking: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatResponse = z.object({
  /** 模型最终回答 */
  answer: z.string(),
  /** 引用来源（可为空数组：检索无命中时无引用） */
  sources: z.array(SourceRef),
  conversationId: z.string().optional(),
  /** 后端处理耗时（毫秒） */
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type ChatResponse = z.infer<typeof ChatResponse>;

/* ===================== M3 流式问答（SSE） ===================== */

/**
 * 流式问答端点：POST /api/query/stream
 * - 请求体同 ChatRequest（zod 校验），响应是 text/event-stream。
 * - 后端按事件顺序推送：sources → token* → done（或中途 error）。
 * - 每条 SSE 消息形如 `data: {JSON}\n\n`，JSON 即下方某个事件对象。
 *
 * 设计要点：
 * - sources 事件先于 token 发出，让前端「先渲染引用列表，再看回答逐字出」，
 *   而不是等全部生成完才看到来源（首 token 延迟与引用可见性解耦）。
 * - 检索为空时仍推 sources(空数组) + 直接 done（带提示文案在 done.message 里），
 *   不走 error——「没查到」是正常业务结果，不是错误。
 * - LLM 中途异常 → 推一条 error 事件后关闭流（前端展示友好文案，不白屏）。
 */
export const STREAM_QUERY_PATH = `${API_PREFIX}/query/stream`;

/** sources 事件：检索完成、LLM 生成前发出，前端据此渲染引用列表 */
export const SourcesEvent = z.object({
  type: z.literal("sources"),
  sources: z.array(SourceRef),
});
export type SourcesEvent = z.infer<typeof SourcesEvent>;

/** thinking 事件：思考模式的推理过程增量（Qwen3 reasoning_content，开思考时先于 token 到达） */
export const ThinkingEvent = z.object({
  type: z.literal("thinking"),
  /** 思考过程增量片段 */
  delta: z.string(),
});
export type ThinkingEvent = z.infer<typeof ThinkingEvent>;

/** token 事件：LLM 逐字/逐词生成的增量片段 */
export const TokenEvent = z.object({
  type: z.literal("token"),
  delta: z.string(),
  /** 首个回答 token 距请求开始的时间（ms），前端据此算 TTFT（首 token 延迟） */
  firstTokenMs: z.number().int().nonnegative().optional(),
});
export type TokenEvent = z.infer<typeof TokenEvent>;

/** done 事件：流正常结束；message 可携带「未命中」等提示文案 */
export const DoneEvent = z.object({
  type: z.literal("done"),
  elapsedMs: z.number().int().nonnegative(),
  /** 检索为空等非错误场景的提示文案（可选） */
  message: z.string().optional(),
});
export type DoneEvent = z.infer<typeof DoneEvent>;

/** error 事件：LLM 异常等中途错误，前端展示友好文案 */
export const ErrorEvent = z.object({
  type: z.literal("error"),
  message: z.string(),
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/** 流式事件联合（判别字段 type，前端按 type 分派渲染） */
export const StreamingEvent = z.discriminatedUnion("type", [
  SourcesEvent,
  ThinkingEvent,
  TokenEvent,
  DoneEvent,
  ErrorEvent,
]);
export type StreamingEvent = z.infer<typeof StreamingEvent>;

/* ===================== M2 流水线：分块 / 摄入 / 检索 ===================== */

/** 文档分块：一个 chunk = 一个可检索的最小单元（M2 起核心概念） */
export const DocumentChunk = z.object({
  /** 全局唯一 chunk id（建议 `${documentId}#${index}`） */
  id: z.string().min(1),
  /** 所属文档 */
  documentId: z.string().min(1),
  /** 在文档内的顺序号（0 起） */
  index: z.number().int().nonnegative(),
  /** 分块正文 */
  content: z.string(),
  /** 来源元数据：如标题层级、页码（M3 引用溯源用） */
  source: z
    .object({
      title: z.string().optional(),
      heading: z.string().optional(),
      page: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type DocumentChunk = z.infer<typeof DocumentChunk>;

/** 分块策略：M2 先实现二选一（heading 按标题 / fixed 固定长度），可配置 */
export const ChunkStrategyType = z.enum(["heading", "fixed"]);
export type ChunkStrategyType = z.infer<typeof ChunkStrategyType>;

/** 摄入（ingest）请求：上传/提交文档内容 */
export const IngestRequest = z.object({
  /** 上传文件名（含扩展名，决定解析器） */
  filename: z.string().min(1),
  /** 原文内容（M2 先走文本；PDF 由解析器提取） */
  content: z.string().min(1),
  /** 分块策略；缺省 fixed */
  chunkStrategy: ChunkStrategyType.optional(),
  /** 固定长度分块的大小（仅 chunkStrategy=fixed 时生效，缺省 500） */
  chunkSize: z.number().int().positive().optional(),
  /** 入库目标知识库（与 query 的 knowledgeBaseId 对齐，缺省 "default"） */
  knowledgeBaseId: z.string().min(1).optional(),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

/** 摄入响应 */
export const IngestResponse = z.object({
  /** 新建/更新后的文档对象 */
  document: Document,
  /** 产生的分块 */
  chunks: z.array(DocumentChunk),
  chunkCount: z.number().int().nonnegative(),
});
export type IngestResponse = z.infer<typeof IngestResponse>;

/** 单条检索命中 */
export const RetrievalHit = z.object({
  chunk: DocumentChunk,
  /** 相关度分数（越大越相关；实现可归一化到 0~1） */
  score: z.number(),
});
export type RetrievalHit = z.infer<typeof RetrievalHit>;

/** 检索请求（query 的内部步骤/独立调试端点用） */
export const RetrieveRequest = z.object({
  question: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  /** top-k 检索条数，缺省 5 */
  topK: z.number().int().positive().max(50).optional(),
  /** 相关度阈值：低于此 score 的命中视为无关（过滤后可能不足 topK；缺省不过滤） */
  minScore: z.number().min(0).max(1).optional(),
});
export type RetrieveRequest = z.infer<typeof RetrieveRequest>;

/** 检索响应 */
export const RetrieveResponse = z.object({
  hits: z.array(RetrievalHit),
  /** embedding 耗时/检索耗时等诊断信息（M5 回填性能数字） */
  diagnostics: z.record(z.string(), z.number()).optional(),
});
export type RetrieveResponse = z.infer<typeof RetrieveResponse>;

/* ===================== 分页（后续列表端点用，字段占位） ===================== */

export const Page = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type Page = z.infer<typeof Page>;

/* ===================== 推理引擎切换（Agent 2：UI 引擎切换） ===================== */

/**
 * 推理引擎标识（与 llm-config.json 的 engine 字段/engines key 对齐）。
 * 新增引擎需同步扩展：llm-config.json、backend config.ts 的 LlmEngineName、
 * start-all.bat 的 --engine 校验、前端切换控件的可选项。
 */
export const LlmEngine = z.enum(["ollama", "vllm"]);
export type LlmEngine = z.infer<typeof LlmEngine>;

/** 单个引擎的 OpenAI 兼容端点配置（与 llm-config.json 的 engines.* 对齐） */
export const LlmEngineEndpoint = z.object({
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
});
export type LlmEngineEndpoint = z.infer<typeof LlmEngineEndpoint>;

/**
 * GET /api/llm-engine 响应 & PUT /api/llm-engine 成功响应（同一形状）：
 * - engine：当前**生效**引擎（RAG_LLM_ENGINE 环境变量会覆盖 llm-config.json 的 engine 字段，
 *   所以可能与文件里存的值不同——前端提示文案会说明这点）。
 * - engines：llm-config.json 中全部引擎端点配置（原样透传）。
 * - configPath：llm-config.json 的实际路径（用于展示/排障）。
 * - requiresRestart：推理层是重资源进程，切换后必须重启后端才生效，恒为 true。
 */
export const LlmEngineStatus = z.object({
  engine: LlmEngine,
  engines: z.record(LlmEngine, LlmEngineEndpoint),
  configPath: z.string().min(1),
  requiresRestart: z.literal(true),
});
export type LlmEngineStatus = z.infer<typeof LlmEngineStatus>;

/** PUT /api/llm-engine 请求体：只允许写 engine 字段（不写环境变量） */
export const LlmEngineUpdateRequest = z.object({
  engine: LlmEngine,
});
export type LlmEngineUpdateRequest = z.infer<typeof LlmEngineUpdateRequest>;

/* ===================== 引擎服务管理（后台任务：启动/停止/健康轮询） ===================== */

/**
 * 引擎服务进程状态机：
 * - unknown：未探测过（后端刚启动，尚未查询）
 * - stopped：服务未运行（端口不通）
 * - starting：正在拉起服务进程（健康轮询中）
 * - running：服务已就绪（健康端点响应）
 * - error：启动失败或健康轮询超时
 */
export const EngineServiceState = z.enum(["unknown", "stopped", "starting", "running", "error"]);
export type EngineServiceState = z.infer<typeof EngineServiceState>;

/** 单个引擎服务的运行状态（GET /api/engine-services 与 start/stop 响应共用） */
export const EngineServiceStatus = z.object({
  engine: LlmEngine,
  state: EngineServiceState,
  /** 服务进程 PID（spawn 后可知；端口探测的存量进程可为 null） */
  pid: z.number().nullable(),
  /** 人类可读信息（错误原因 / 启动进度等） */
  message: z.string().optional(),
});
export type EngineServiceStatus = z.infer<typeof EngineServiceStatus>;

/** GET /api/engine-services 响应：ollama 与 vllm 两个引擎的服务状态 */
export const EngineServicesStatus = z.record(LlmEngine, EngineServiceStatus);
export type EngineServicesStatus = z.infer<typeof EngineServicesStatus>;
