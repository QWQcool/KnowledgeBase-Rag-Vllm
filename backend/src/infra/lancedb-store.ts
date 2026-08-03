import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import { mkdir } from "node:fs/promises";
import type { DocumentChunk, RetrievalHit } from "@rag/shared";
import type { VectorStore } from "./types";
import { LANCEDB_DATA_DIR } from "./config";

/**
 * infra/lancedb-store.ts —— VectorStore 的 LanceDB 实现（M2）
 *
 * 设计要点：
 * - 每 chunk 一行：id/documentId/index/content/source_* 元数据 + vector（FixedSizeList<Float32> 向量列）
 * - 表名 = `kb_${knowledgeBaseId}`，一个知识库一张表
 * - 表在首次 upsert 时用显式 schema 懒创建（含可空 source_* 列，规避「全 null 无法推断类型」）
 * - upsert 用 mergeInsert（同 id 原子覆盖，满足「同 id 覆盖」）
 * - 距离函数：LanceDB 默认 **L2 欧氏距离**（无额外配置、可移植）；score = 1/(1+_distance)，
 *   [0,+∞) → (0,1]，越大越相关，满足契约「score 越大越相关 / 可归一化 0~1」
 */

/** 落库行结构（source 元数据扁平化为 source_* 列） */
interface StoredRow {
  id: string;
  documentId: string;
  index: number;
  content: string;
  source_title?: string | null;
  source_heading?: string | null;
  source_page?: number | null;
  vector: number[];
}

const TABLE_PREFIX = "kb_";

function tableName(knowledgeBaseId: string): string {
  return `${TABLE_PREFIX}${knowledgeBaseId}`;
}

/** 显式表 schema：向量列 FixedSizeList<Float32>(dim)，source_* 可空 */
function tableSchema(dim: number): Schema {
  return new Schema([
    new Field("id", new Utf8(), false),
    new Field("documentId", new Utf8(), false),
    new Field("index", new Int32(), false),
    new Field("content", new Utf8(), false),
    new Field("source_title", new Utf8(), true),
    new Field("source_heading", new Utf8(), true),
    new Field("source_page", new Int32(), true),
    new Field("vector", new FixedSizeList(dim, new Field("item", new Float32())), false),
  ]);
}

function chunkToRow(chunk: DocumentChunk, vector: number[]): StoredRow {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    index: chunk.index,
    content: chunk.content,
    source_title: chunk.source?.title ?? null,
    source_heading: chunk.source?.heading ?? null,
    source_page: chunk.source?.page ?? null,
    vector,
  };
}

function rowToChunk(row: StoredRow): DocumentChunk {
  const chunk: DocumentChunk = {
    id: row.id,
    documentId: row.documentId,
    index: row.index,
    content: row.content,
  };
  const title = row.source_title;
  const heading = row.source_heading;
  const page = row.source_page;
  if (title !== undefined && title !== null || heading !== undefined && heading !== null || page !== undefined && page !== null) {
    chunk.source = {
      ...(title ? { title } : {}),
      ...(heading ? { heading } : {}),
      ...(page !== undefined && page !== null ? { page } : {}),
    };
  }
  return chunk;
}

/** L2 距离 → 相似度：距离为 0 时满分 1，随距离单调递减趋近 0 */
function distanceToScore(distance: number): number {
  return 1 / (1 + distance);
}

export class LanceDBStore implements VectorStore {
  private db: lancedb.Connection | null = null;
  private readonly dataDir: string;

  constructor(options?: { dataDir?: string }) {
    this.dataDir = options?.dataDir ?? LANCEDB_DATA_DIR;
  }

  /** 连接/建数据目录；重复调用幂等 */
  async init(_knowledgeBaseId?: string): Promise<void> {
    if (!this.db) {
      await mkdir(this.dataDir, { recursive: true });
      this.db = await lancedb.connect(this.dataDir);
    }
  }

  /** 获取表；不存在则返回 null（表由首次 upsert 懒创建） */
  private async getTable(knowledgeBaseId: string): Promise<lancedb.Table | null> {
    await this.init();
    const db = this.db!;
    const name = tableName(knowledgeBaseId);
    if (!(await db.tableNames()).includes(name)) return null;
    return db.openTable(name);
  }

  async upsertChunks(
    knowledgeBaseId: string,
    entries: { chunk: DocumentChunk; vector: number[] }[],
  ): Promise<void> {
    await this.init();
    const db = this.db!;
    const name = tableName(knowledgeBaseId);

    const rows: StoredRow[] = entries.map(({ chunk, vector }) =>
      chunkToRow(chunk, vector),
    );
    if (rows.length === 0) return;

    // 表不存在则用显式 schema 建表（向量维度取首批数据）；已存在则直接打开
    const dim = rows[0].vector.length;
    let table: lancedb.Table;
    if ((await db.tableNames()).includes(name)) {
      table = await db.openTable(name);
    } else {
      await db.createEmptyTable(name, tableSchema(dim), {
        mode: "create",
        existOk: true,
      });
      table = await db.openTable(name);
    }

    // 同 id 原子覆盖：更新已存在行 + 插入新行
    // （lancedb 包装层的类型形参声明为 arrow Data，但运行时接受普通对象数组，
    //   官方示例即传数组；经 never 中转宽化绕过冗余的类型摩擦）
    await table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows as unknown as never);
  }

  async search(
    knowledgeBaseId: string,
    queryVector: number[],
    topK: number,
  ): Promise<RetrievalHit[]> {
    const table = await this.getTable(knowledgeBaseId);
    if (!table) return []; // 空库/未建表 → 空命中，不抛错

    const rows = (await table.search(queryVector).limit(topK).toArray()) as (
      | StoredRow
      | { _distance: number }
    )[];

    return rows
      .map((row) => {
        const distance = (row as { _distance?: number })._distance ?? Number.POSITIVE_INFINITY;
        return {
          chunk: rowToChunk(row as StoredRow),
          score: distanceToScore(distance),
        };
      })
      .sort((a, b) => b.score - a.score); // 防御性降序
  }

  async clear(knowledgeBaseId: string): Promise<void> {
    const table = await this.getTable(knowledgeBaseId);
    if (!table) return;
    await this.db!.dropTable(tableName(knowledgeBaseId));
  }
}
