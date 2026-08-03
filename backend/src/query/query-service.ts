import {
  type ChatRequest,
  type ChatResponse,
  type RetrieveRequest,
  type RetrieveResponse,
} from "@rag/shared";
import type { LLMProvider } from "../infra/types";

/**
 * query/query-service.ts —— 问答编排（M2）
 *
 * 流程：question + knowledgeBaseId → retrieveService（按 @rag/shared RetrieveRequest
 * 契约）→ hits 拼 systemPrompt + context → LLMProvider.generate → ChatResponse。
 * retrieveService 用结构性接口注入，避免依赖 retrieval/ 目录的具体实现，
 * 便于测试与并行开发（Retrieval Agent 交付后可无缝替换）。
 */

/** 检索服务的结构性接口：只要暴露 retrieve 方法即可注入 */
export interface RetrieveService {
  retrieve(req: RetrieveRequest): Promise<RetrieveResponse>;
}

export interface QueryServiceDeps {
  retrieveService: RetrieveService;
  llmProvider: LLMProvider;
}

export interface QueryService {
  query(req: ChatRequest): Promise<ChatResponse>;
}

/** 每片检索片段允许带进 systemPrompt 的最长内容 */
const SNIPPET_MAX_LEN = 200;

/**
 * 无命中判定阈值：score < 此值视为无关。M2 实测（transformers+中文，
 * all-MiniLM-L6-v2）：TriviumDB 余弦相似度，相关片段 0.41~0.53，
 * 无关 0.34~0.42——0.45 是合理分界（宁缺毋滥，防编造）。可用 RAG_MIN_SCORE 覆盖。
 */
export const DEFAULT_MIN_SCORE = 0.45;

export function createQueryService(deps: QueryServiceDeps): QueryService {
  const { retrieveService, llmProvider } = deps;

  return {
    async query(req: ChatRequest): Promise<ChatResponse> {
      const startedAt = Date.now();

      const minScore =
        process.env.RAG_MIN_SCORE !== undefined
          ? Number(process.env.RAG_MIN_SCORE)
          : DEFAULT_MIN_SCORE;

      const { hits } = await retrieveService.retrieve({
        question: req.question,
        knowledgeBaseId: req.knowledgeBaseId,
        topK: 5,
        minScore,
      });

      const sources = hits.map((hit) => ({
        documentId: hit.chunk.documentId,
        documentName: hit.chunk.source?.title ?? `文档 ${hit.chunk.documentId}`,
        chunkIndex: hit.chunk.index,
        snippet: hit.chunk.content.slice(0, SNIPPET_MAX_LEN),
        // 检索相关度归一化到契约要求的 0~1
        score: Math.min(1, Math.max(0, hit.score)),
      }));

      // 检索为空：明确告知未找到，不给模型编造的机会
      if (hits.length === 0) {
        return {
          answer: "未找到相关内容，请换一种问法，或补充更多资料后再试。",
          sources: [],
          elapsedMs: Date.now() - startedAt,
        };
      }

      const systemPrompt =
        "你是一个基于知识库回答问题的助手。" +
        "请只依据用户给出的检索片段作答，不要编造片段之外的内容。" +
        "回答时尽量引用片段原文，并在末尾按需提及出处。";

      const { answer } = await llmProvider.generate({
        systemPrompt,
        contextChunks: hits.map((hit) => ({
          content: hit.chunk.content,
          source: hit.chunk.source?.title ?? hit.chunk.documentId,
        })),
        question: req.question,
      });

      return {
        answer,
        sources,
        elapsedMs: Date.now() - startedAt,
      };
    },
  };
}
