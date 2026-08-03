import type { RetrieveRequest, RetrieveResponse } from "@rag/shared";
import type { EmbeddingProvider, VectorStore } from "../infra/types";

/**
 * retrieval/retrieve-service.ts —— 检索编排（M2）
 *
 * RetrieveRequest → embed(question) → VectorStore.search → score 降序 topK → RetrieveResponse
 * 空知识库 / 无命中：VectorStore 返回空数组，这里原样透出（不抛错）。
 */
export class RetrieveService {
  constructor(
    private readonly embedding: EmbeddingProvider,
    private readonly store: VectorStore,
  ) {}

  async retrieve(req: RetrieveRequest): Promise<RetrieveResponse> {
    const topK = req.topK ?? 5;

    // 1. 问题向量化（单问题，取第一个向量）
    const vectors = await this.embedding.embed([req.question]);
    const queryVector = vectors[0];

    // 2. 向量相似检索（store 负责返回排序好的 topK）
    const hits = await this.store.search(req.knowledgeBaseId, queryVector, topK);

    // 3. 相关度阈值过滤（可选）：低于 minScore 视为无关，防止"永远返回 topK"误导
    const minScore = req.minScore;
    const filtered = minScore === undefined ? hits : hits.filter((h) => h.score >= minScore);

    // 4. 防御性：score 降序 + 截断 topK
    const sorted = [...filtered]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return { hits: sorted };
  }
}
