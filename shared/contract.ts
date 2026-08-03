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

/* ===================== 分页（后续列表端点用，字段占位） ===================== */

export const Page = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type Page = z.infer<typeof Page>;
