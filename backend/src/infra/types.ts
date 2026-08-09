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

/** 写入向量库的单条条目：chunk + 向量 + 可选所属文件名（供同名文档去重索引） */
export interface VectorEntry {
  chunk: DocumentChunk;
  vector: number[];
  /** 所属文档原始文件名（ingest 时传入，用于按 filename 查重） */
  filename?: string;
}

/** 向量库接口（可替换实现：TriviumDB / LanceDB / 内存版 / sqlite-vec） */
export interface VectorStore {
  /** 初始化（建库/连库），重复调用应幂等 */
  init(knowledgeBaseId: string): Promise<void>;
  /** 写入一批 (chunk, vector) 对；同 id 覆盖 */
  upsertChunks(
    knowledgeBaseId: string,
    entries: VectorEntry[],
  ): Promise<void>;
  /** 向量相似检索，按相关度降序返回 topK 条 */
  search(
    knowledgeBaseId: string,
    queryVector: number[],
    topK: number,
  ): Promise<RetrievalHit[]>;
  /** 清空某个知识库（重建索引用） */
  clear(knowledgeBaseId: string): Promise<void>;
  /** 按原始文件名查该知识库下的文档 id（同名去重用，无则返回空数组） */
  findDocumentIdsByFilename(
    knowledgeBaseId: string,
    filename: string,
  ): Promise<string[]>;
  /** 删除某文档的全部 chunk（同名覆盖：先删旧再插新） */
  deleteDocument(knowledgeBaseId: string, documentId: string): Promise<void>;
}

/** LLM 生成接口（可替换实现：OpenAI 兼容 HTTP / llama-server / Mock） */
export interface LLMProvider {
  /**
   * 非流式生成（M2 用，POST /api/query）。
   * 等模型整段回答生成完再返回。
   */
  generate(params: {
    systemPrompt: string;
    contextChunks: { content: string; source: string }[];
    question: string;
  }): Promise<{ answer: string }>;

  /**
   * 流式生成（M3 用，POST /api/query/stream）。
   * 返回 async generator，逐段 yield { delta, thinking? }：
   *   - thinking=false/缺省：正式回答增量（content），前端渲染回答文本；
   *   - thinking=true：思考过程增量（reasoning_content），前端可单独展示。
   * 实现需保证：生成完毕后 generator 自然结束（不 yield 结束标记，
   * 结束由编排层发 done 事件）；抛异常时编排层捕获并发 error 事件。
   */
  stream(params: {
    systemPrompt: string;
    contextChunks: { content: string; source: string }[];
    question: string;
    /** 是否开启思考模式（true=先思考再回答；缺省 true） */
    thinking?: boolean;
  }): AsyncGenerator<{ delta: string; thinking?: boolean }, void, unknown>;
}
