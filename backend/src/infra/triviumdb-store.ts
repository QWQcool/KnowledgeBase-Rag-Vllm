import fs from "node:fs";
import path from "node:path";
import triviumdb from "triviumdb";
import type { DocumentChunk, RetrievalHit } from "@rag/shared";
import type { VectorStore } from "./types";
import { EMBEDDING_DIM, TRIVIUM_DATA_DIR } from "./config";

// napi-rs CJS 绑定：类型来自 triviumdb.d.ts，运行时为 CJS default export
const { TriviumDB } = triviumdb as unknown as typeof import("triviumdb");

/**
 * triviumdb-store.ts —— TriviumDB 版 VectorStore（Strategy 第 2 实现，替换 LanceDB）
 *
 * 选型理由（2026-08-03 决策，见 01 手册选型记录）：
 * - Rust 嵌入式三位一体（向量+图+文档），napi-rs 预编译绑定（win32-x64-msvc.node）
 * - 与 LanceDB 同样满足「本地文件、无原生编译坑」，且余弦相似度区分度更好
 * - 学习价值：较新项目（v0.7.2），踩坑可提 PR（用户主动选择）
 *
 * 实测行为（探测脚本验证，非文档臆测）：
 * 1. insertWithId 同 id 抛错「Node already exists」→ upsert 需查存在 + update
 * 2. search 返回原始余弦相似度（相关 ~0.99 / 无关 ~0.00，分布远超 LanceDB L2 映射）
 * 3. close() 后 .tdb.lock 残留、无法立即重开 → 本 Store 缓存连接，进程内每 kb 只 open 一次
 * 4. ESM 下需 default import + 解构（CJS interop），不能用 named import
 * 5. **d.ts 有 filterWhere/query，但运行时实装没有**（v0.7.2 bug，可提 PR）→
 *    upsert 存在性改用内存映射 chunkId→nodeId，配合 allNodeIds+getPayload 懒重建
 *
 * 设计：一个 knowledgeBaseId = 一个 .tdb 文件（sanitize 文件名）；连接缓存 Map，避免锁问题。
 */
export class TriviumDBStore implements VectorStore {
  /** 已打开的连接缓存：key = knowledgeBaseId */
  private readonly connections = new Map<string, TriviumDBInstance>();
  /** chunkId → nodeId 映射（进程内维护；重启后由 allNodeIds+getPayload 懒重建） */
  private readonly idMaps = new Map<string, Map<string, number>>();
  private readonly dataDir: string;
  private readonly dim: number;

  constructor(options?: { dataDir?: string; dim?: number }) {
    this.dataDir = options?.dataDir ?? TRIVIUM_DATA_DIR;
    this.dim = options?.dim ?? EMBEDDING_DIM;
  }

  /** 打开/复用连接（幂等）；进程内每 kb 只 open 一次（close 后 lock 残留无法重开） */
  async init(knowledgeBaseId: string): Promise<void> {
    if (this.connections.has(knowledgeBaseId)) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, `${sanitizeKbId(knowledgeBaseId)}.tdb`);
    const db = new TriviumDB(file, this.dim, "f32", "normal");
    this.connections.set(knowledgeBaseId, db);
    await this.rebuildIdMap(knowledgeBaseId, db);
  }

  /** upsert：按 chunk.id 查存在（内存映射）→ 更新向量+payload；否则插入 */
  async upsertChunks(
    knowledgeBaseId: string,
    entries: { chunk: DocumentChunk; vector: number[] }[],
  ): Promise<void> {
    const db = await this.getDb(knowledgeBaseId);
    const idMap = this.idMaps.get(knowledgeBaseId)!;

    for (const { chunk, vector } of entries) {
      const existingId = idMap.get(chunk.id);
      if (existingId !== undefined) {
        db.updateVector(existingId, vector);
        db.updatePayload(existingId, payloadOf(chunk));
      } else {
        const nodeId = db.insert(vector, payloadOf(chunk));
        idMap.set(chunk.id, nodeId);
      }
    }
  }

  /** 向量相似检索：纯向量（expandDepth=0，退化=相似度排序），按 score 降序返回 topK */
  async search(
    knowledgeBaseId: string,
    queryVector: number[],
    topK: number,
  ): Promise<RetrievalHit[]> {
    const db = await this.getDb(knowledgeBaseId);
    // minScore 传 -1：不过滤，让上层（retrieve-service）统一按契约 minScore 决策
    const hits = db.search(queryVector, topK, 0, -1) as JsSearchHit[];
    return hits
      .map((h) => ({
        chunk: h.payload as unknown as DocumentChunk,
        score: h.score,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /** 清空某知识库：删除全部节点（连接保留，避免 lock 残留）+ 重置映射 */
  async clear(knowledgeBaseId: string): Promise<void> {
    const db = this.connections.get(knowledgeBaseId);
    if (!db) return;
    for (const id of db.allNodeIds()) db.delete(id);
    this.idMaps.set(knowledgeBaseId, new Map());
  }

  private async getDb(knowledgeBaseId: string) {
    await this.init(knowledgeBaseId);
    return this.connections.get(knowledgeBaseId)!;
  }

  /** 从库中重建 chunkId→nodeId 映射（连接刚打开/重启后调用一次） */
  private async rebuildIdMap(knowledgeBaseId: string, db: TriviumDBInstance) {
    const map = new Map<string, number>();
    for (const nodeId of db.allNodeIds()) {
      // getPayload 运行时存在但 d.ts 缺失（v0.7.2 类型缺陷）→ 断言绕过
      const payload = (db as unknown as { getPayload(id: number): unknown }).getPayload(
        nodeId,
      ) as unknown as { chunkId?: string };
      if (payload && typeof payload.chunkId === "string") {
        map.set(payload.chunkId, nodeId);
      }
    }
    this.idMaps.set(knowledgeBaseId, map);
  }
}

/* ===================== 内部工具 ===================== */

type TriviumDBInstance = InstanceType<typeof TriviumDB>;

/** JsSearchHit 最小形状（类型来自 d.ts，此处对齐运行时） */
interface JsSearchHit {
  id: number;
  score: number;
  payload: unknown;
}

/** 文件名安全化：kb id 里非字母数字下划线一律替换，防路径注入/非法文件名 */
function sanitizeKbId(kbId: string): string {
  const safe = kbId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe || "default";
}

/** chunk → TriviumDB payload：chunkId 用于 upsert 查找，其余字段原样存 */
function payloadOf(chunk: DocumentChunk) {
  return { chunkId: chunk.id, ...chunk };
}
