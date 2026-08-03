import type {
  DocumentChunk,
  RetrievalHit,
} from "@rag/shared";

/**
 * infra/types.ts —— M2 基础设施接口（编排者定死，三个 Dev Agent 共同遵守）
 *
 * 为什么有这份文件：
 * - Ingest / Retrieval / Query 三个 Agent 并行开发，谁都可能用到 embedding 与向量库；
 * - 接口先定，实现后到——各自开发期用 Mock 实现跑通测试，集成期替换为真实实现；
 * - 这也是 01 手册「Strategy 模式」的落地：换 embedding 模型 / 换向量库，不碰业务代码。
 *
 * 命名约定：接口 PascalCase，方法 camelCase。
 */

/** 文本向量化接口（可替换实现：Transformers.js / llama-server /v1/embeddings / Mock） */
export interface EmbeddingProvider {
  /** 把一批文本转成等长向量 */
  embed(texts: string[]): Promise<number[][]>;
}

/** 向量库接口（可替换实现：LanceDB / 内存版 / sqlite-vec） */
export interface VectorStore {
  /** 初始化（建库/连库），重复调用应幂等 */
  init(knowledgeBaseId: string): Promise<void>;
  /** 写入一批 (chunk, vector) 对；同 id 覆盖 */
  upsertChunks(
    knowledgeBaseId: string,
    entries: { chunk: DocumentChunk; vector: number[] }[],
  ): Promise<void>;
  /** 向量相似检索，按相关度降序返回 topK 条 */
  search(
    knowledgeBaseId: string,
    queryVector: number[],
    topK: number,
  ): Promise<RetrievalHit[]>;
  /** 清空某个知识库（重建索引用） */
  clear(knowledgeBaseId: string): Promise<void>;
}

/** LLM 生成接口（可替换实现：OpenAI 兼容 HTTP / llama-server / Mock） */
export interface LLMProvider {
  /** 根据系统提示 + 检索上下文 + 用户问题生成回答 */
  generate(params: {
    systemPrompt: string;
    contextChunks: { content: string; source: string }[];
    question: string;
  }): Promise<{ answer: string }>;
}
