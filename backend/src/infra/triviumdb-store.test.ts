import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TriviumDBStore } from "./triviumdb-store";
import type { DocumentChunk } from "@rag/shared";

/** 测试用临时数据目录，跑完清理，绝不污染项目仓库 */
let tmpDir: string;
let store: TriviumDBStore;

function makeChunk(
  id: string,
  content: string,
  index = 0,
  documentId = "doc-1",
): DocumentChunk {
  return { id, documentId, index, content };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "trivium-test-"));
  store = new TriviumDBStore({ dataDir: tmpDir, dim: 3 });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("TriviumDBStore", () => {
  it("建库 → upsert 3 chunk → search 相似向量命中排序正确 → clear 后为空", async () => {
    await store.init("kb-1");

    await store.upsertChunks("kb-1", [
      { chunk: makeChunk("a", "苹果香蕉水果", 0), vector: [1, 0, 0] },
      { chunk: makeChunk("b", "猫狗动物", 1), vector: [0, 1, 0] },
      { chunk: makeChunk("c", "高山湖泊风景", 2), vector: [0, 0, 1] },
    ]);

    // 查询向量贴近 a → 最近的是 a
    const hits = await store.search("kb-1", [0.95, 0.1, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].chunk.id).toBe("a");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    // 余弦相似度 ∈ [0,1]
    expect(hits[0].score).toBeGreaterThan(0.9);
    expect(hits[0].score).toBeLessThanOrEqual(1);

    // 查询贴近 c → c 排第一
    const hits2 = await store.search("kb-1", [0, 0.05, 0.98], 3);
    expect(hits2[0].chunk.id).toBe("c");
    expect(hits2[0].chunk.content).toBe("高山湖泊风景");

    // clear 后为空，不抛错
    await store.clear("kb-1");
    expect(await store.search("kb-1", [1, 0, 0], 5)).toEqual([]);
  });

  it("同 id 覆盖（upsert 语义）：更新内容与向量，不产生重复", async () => {
    await store.init("kb-1");
    await store.upsertChunks("kb-1", [
      { chunk: makeChunk("a", "v1 内容", 0), vector: [1, 0, 0] },
    ]);
    await store.upsertChunks("kb-1", [
      { chunk: makeChunk("a", "v2 内容", 0), vector: [1, 0, 0] },
      { chunk: makeChunk("b", "新增", 1), vector: [0, 1, 0] },
    ]);

    const hits = await store.search("kb-1", [1, 0, 0], 5);
    const ids = hits.map((h) => h.chunk.id).sort();
    expect(ids).toEqual(["a", "b"]); // 没有重复的 a
    const a = hits.find((h) => h.chunk.id === "a");
    expect(a!.chunk.content).toBe("v2 内容");
  });

  it("init 幂等：重复调用复用同一连接，不报错", async () => {
    await store.init("kb-1");
    await expect(store.init("kb-1")).resolves.toBeUndefined();
  });

  it("未打开的库 search 返回空数组，不抛错（连接懒打开）", async () => {
    const hits = await store.search("kb-不存在", [1, 0, 0], 3);
    expect(hits).toEqual([]);
  });

  it("不同知识库文件隔离：kb-1 的数据不影响 kb-2", async () => {
    await store.upsertChunks("kb-1", [
      { chunk: makeChunk("a", "只属于 kb1", 0), vector: [1, 0, 0] },
    ]);
    const hits = await store.search("kb-2", [1, 0, 0], 5);
    expect(hits).toEqual([]);
  });
});
