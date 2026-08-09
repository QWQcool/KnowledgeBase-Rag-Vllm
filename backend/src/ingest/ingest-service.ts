import { randomUUID } from "node:crypto";
import {
  IngestRequest,
  IngestResponse,
  type ChunkStrategyType,
  type Document,
  type DocumentChunk,
} from "@rag/shared";
import type { EmbeddingProvider, VectorStore } from "../infra/types";
import { parseDocument } from "./parser";
import { createChunkStrategy, type ChunkOptions } from "./chunker";

/**
 * ingest-service.ts —— 文档摄入主流程。
 *
 * 入参：IngestRequest（契约唯一事实源）→ 解析 → 分块（DocumentChunk[]）
 * → EmbeddingProvider.embed() → VectorStore.upsertChunks() → IngestResponse。
 *
 * 注意：documentId 运行时生成；knowledgeBaseId 优先取请求里显式传入的，
 * 缺省 "default"——保证 ingest 与 query 的检索命名空间对齐（M2 集成要点）。
 */

export interface IngestServiceOptions {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
}

/** 缺省知识库命名空间（请求未指定时使用，与 query 侧对齐） */
export const DEFAULT_KNOWLEDGE_BASE_ID = "default";

export class IngestService {
  constructor(private readonly opts: IngestServiceOptions) {}

  async ingest(request: IngestRequest): Promise<IngestResponse> {
    // 运行时校验：契约是唯一事实源，非法入参直接拒绝
    const validated = IngestRequest.parse(request);
    const knowledgeBaseId =
      validated.knowledgeBaseId ?? DEFAULT_KNOWLEDGE_BASE_ID;

    // 1. 解析原文
    const parsed = await parseDocument(validated.filename, validated.content);

    // 2. 分块（缺省 fixed；heading 无标题时内部回落 fixed）
    const strategyType: ChunkStrategyType = validated.chunkStrategy ?? "fixed";
    const options: ChunkOptions =
      validated.chunkSize !== undefined
        ? { chunkSize: validated.chunkSize }
        : {};
    const rawChunks = createChunkStrategy(strategyType).chunk(
      parsed.text,
      options,
    );

    // 3. 同名文档覆盖：同 knowledgeBaseId 下已存在相同 filename → 先删旧文档全部 chunk，
    //    避免知识库膨胀（重复入库产生多条相同内容的 chunk）
    const existingIds = await this.opts.vectorStore.findDocumentIdsByFilename(
      knowledgeBaseId,
      validated.filename,
    );
    for (const oldDocId of existingIds) {
      await this.opts.vectorStore.deleteDocument(knowledgeBaseId, oldDocId);
    }

    // 4. 组装 Document + DocumentChunk[]
    const documentId = `doc_${randomUUID()}`;
    const chunks: DocumentChunk[] = rawChunks.map((c, index) => ({
      id: `${documentId}#${index}`,
      documentId,
      index,
      content: c.content,
      ...(c.source ? { source: c.source } : {}),
    }));

    // 5. 向量化 + 入库（只调用 infra 接口，不实现）
    const vectors = await this.opts.embeddingProvider.embed(
      chunks.map((c) => c.content),
    );
    await this.opts.vectorStore.init(knowledgeBaseId);
    await this.opts.vectorStore.upsertChunks(
      knowledgeBaseId,
      chunks.map((chunk, i) => ({
        chunk,
        vector: vectors[i],
        filename: validated.filename,
      })),
    );

    // 6. 组装响应并过契约校验
    const document: Document = {
      id: documentId,
      filename: validated.filename,
      ...(parsed.title ? { title: parsed.title } : {}),
      status: "ready",
      sourceType: parsed.sourceType,
      sizeBytes: Buffer.byteLength(validated.content, "utf8"),
      chunkCount: chunks.length,
      error: null,
      uploadedAt: new Date().toISOString(),
    };

    return IngestResponse.parse({ document, chunks, chunkCount: chunks.length });
  }
}
