import {
  type ChatRequest,
  type ChatResponse,
  type RetrieveRequest,
  type RetrieveResponse,
  type StreamingEvent,
} from "@rag/shared";
import type { LLMProvider } from "../infra/types";
import { noopChatLogWriter, type ChatLogWriter } from "./chat-log";

/**
 * query/query-service.ts —— 问答编排（M2）
 *
 * 流程：question + knowledgeBaseId → retrieveService（按 @rag/shared RetrieveRequest
 * 契约）→ hits 拼 systemPrompt + context → LLMProvider.generate → ChatResponse。
 * retrieveService 用结构性接口注入，避免依赖 retrieval/ 目录的具体实现，
 * 便于测试与并行开发（Retrieval Agent 交付后可无缝替换）。
 *
 * 对话日志：可选注入 chatLog 写入器（测试缺省 no-op，生产由 bootstrap 注入
 * FileChatLogWriter），每次问答结束时落一条 JSONL 记录（本地留存，不进 git）。
 */

/** 检索服务的结构性接口：只要暴露 retrieve 方法即可注入 */
export interface RetrieveService {
  retrieve(req: RetrieveRequest): Promise<RetrieveResponse>;
}

export interface QueryServiceDeps {
  retrieveService: RetrieveService;
  llmProvider: LLMProvider;
  /** 对话日志写入器（缺省 no-op，测试不写盘） */
  chatLog?: ChatLogWriter;
}

export interface QueryService {
  query(req: ChatRequest): Promise<ChatResponse>;
  streamQuery(req: ChatRequest): AsyncGenerator<StreamingEvent, void, unknown>;
}

/** 每片检索片段允许带进 systemPrompt 的最长内容 */
const SNIPPET_MAX_LEN = 200;

/**
 * 构造 systemPrompt：
 * - 检索为空：明确提示走通识回答，末尾注明"知识库未命中"。
 * - 有命中：要求优先基于片段作答；但片段与问题明显不相关时（弱相关命中，
 *   如 0.80~0.85 阈值放行的片段），允许模型基于通识回答并注明，避免被
 *   无关片段"绑死"（实测"写宇宙飞船短诗"命中 RAG 原理文档导致拒答）。
 */
function buildSystemPrompt(hitCount: number): string {
  if (hitCount === 0) {
    return (
      "你是知识库问答助手。本次没有在知识库中检索到相关资料（检索为空）。" +
      "请直接根据你自己的知识回答用户问题，并在回答末尾注明「知识库中未找到相关内容，以下为模型通识回答」。"
    );
  }
  return (
    "你是一个基于知识库回答问题的助手。" +
    "请优先依据用户给出的检索片段作答，回答时尽量引用片段原文。" +
    "若检索片段与问题明显不相关、或不足以回答问题（例如创作类问题只命中了无关的技术文档），" +
    "请基于你自己的知识回答，并在末尾注明「知识库片段与本问题相关性较低，以下为模型通识回答」。"
  );
}

/**
 * 无命中判定阈值：score < 此值视为无关。可用 RAG_MIN_SCORE 覆盖。
 *
 * M5 实测（multilingual-e5-small + TriviumDB 余弦相似度）：
 * 相关问题 0.89~0.94，无关问题 0.81~0.84——0.85 是合理分界。
 *
 * 历史变迁：M2 初版 0.45（all-MiniLM-L6-v2，英文模型，标点敏感差 0.12）→
 * M4 调 0.30（过低，multilingual-e5-small 分数普遍高 0.80+，阈值形同虚设）→
 * M5 定 0.85（换 multilingual-e5-small 后标点差仅 0.007，阈值可以卡高）。
 */
export const DEFAULT_MIN_SCORE = 0.85;

export function createQueryService(deps: QueryServiceDeps): QueryService {
  const { retrieveService, llmProvider } = deps;
  const chatLog = deps.chatLog ?? noopChatLogWriter;

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

      // 检索为空：不直接判负，交给 LLM 兜底回答（sources 为空数组，
      // 但让模型基于通用知识作答，而不是僵硬地返回"未找到"）
      const systemPrompt = buildSystemPrompt(hits.length);

      const { answer } = await llmProvider.generate({
        systemPrompt,
        contextChunks: hits.map((hit) => ({
          content: hit.chunk.content,
          source: hit.chunk.source?.title ?? hit.chunk.documentId,
        })),
        question: req.question,
      });

      chatLog.append({
        ts: new Date().toISOString(),
        question: req.question,
        knowledgeBaseId: req.knowledgeBaseId,
        thinking: req.thinking,
        sources,
        answer,
        fallbackNoHits: hits.length === 0,
        elapsedMs: Date.now() - startedAt,
      });

      return {
        answer,
        sources,
        elapsedMs: Date.now() - startedAt,
      };
    },

    /**
     * 流式问答：sources → token* → done（或 error）。
     * - 检索为空：仍发 sources([]) + done(message)，不发 error。
     * - LLM 异常：发 sources 后捕获异常发 error 事件，return。
     */
    async *streamQuery(req: ChatRequest): AsyncGenerator<StreamingEvent, void, unknown> {
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
        score: Math.min(1, Math.max(0, hit.score)),
      }));

      // 先推 sources，让前端尽早渲染引用列表
      yield { type: "sources", sources };

      // 检索为空：不发 error、不发"未找到"硬编码消息，走 LLM 兜底回答（见 buildSystemPrompt）
      const systemPrompt = buildSystemPrompt(hits.length);

      try {
        // 首个回答 token 时间戳（TTFT 由前端算更准，这里只做透传辅助）
        let firstTokenAt: number | null = null;
        let answerText = "";
        for await (const { delta, thinking } of llmProvider.stream({
          systemPrompt,
          contextChunks: hits.map((hit) => ({
            content: hit.chunk.content,
            source: hit.chunk.source?.title ?? hit.chunk.documentId,
          })),
          question: req.question,
          thinking: req.thinking ?? true,
        })) {
          if (thinking) {
            // 思考过程增量 → thinking 事件
            yield { type: "thinking", delta };
          } else {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            answerText += delta;
            yield {
              type: "token",
              delta,
              firstTokenMs: Date.now() - startedAt,
            };
          }
        }
        yield { type: "done", elapsedMs: Date.now() - startedAt };
        chatLog.append({
          ts: new Date().toISOString(),
          question: req.question,
          knowledgeBaseId: req.knowledgeBaseId,
          thinking: req.thinking ?? true,
          sources,
          answer: answerText,
          fallbackNoHits: hits.length === 0,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err) || "未知错误";
        chatLog.append({
          ts: new Date().toISOString(),
          question: req.question,
          knowledgeBaseId: req.knowledgeBaseId,
          thinking: req.thinking ?? true,
          sources,
          elapsedMs: Date.now() - startedAt,
          error: `生成失败：${message}`,
        });
        yield {
          type: "error",
          message: `生成失败：${message}`,
        };
      }
    },
  };
}
