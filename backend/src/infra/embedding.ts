import os from "node:os";
import path from "node:path";
import type { EmbeddingProvider } from "./types";
import {
  EMBEDDING_DIM,
  EMBEDDING_FALLBACK_HINT,
  EMBEDDING_MODEL,
  TRANSFORMERS_CACHE_DIR,
} from "./config";

/**
 * infra/embedding.ts —— EmbeddingProvider 的可切换实现 + 工厂（Strategy 模式）
 *
 * - MockEmbeddingProvider：确定性伪向量（文本 hash → PRNG → 384 维），测试/离线演示用
 * - TransformersEmbeddingProvider：@huggingface/transformers 的 feature-extraction
 *   pipeline，模型 all-MiniLM-L6-v2（384 维）。模型懒加载：首次 embed 才下载；
 *   网络失败/超时会 catch 并抛出明确提示（可换 Mock）
 * - createEmbeddingProvider(type)：按配置切换实现
 */

/* ===================== Mock（确定性伪向量） ===================== */

/** FNV-1a 字符串哈希 → 32 位无符号种子 */
function hashSeed(text: string): number {
  let seed = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193);
  }
  return seed >>> 0;
}

/** mulberry32 PRNG：给定种子产出确定性伪随机序列 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** L2 归一化，保证向量相似度可比 */
function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  private readonly dim = EMBEDDING_DIM;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const rand = mulberry32(hashSeed(text));
      return l2Normalize(
        Array.from({ length: this.dim }, () => rand() * 2 - 1),
      );
    });
  }
}

/* ===================== Transformers.js（真实模型） ===================== */

/** 与 FeatureExtractionPipeline 返回值结构兼容的最小形状（避免依赖具体类型名） */
interface EmbeddingTensor {
  dims: number[];
  data: Float32Array | Uint8Array | Uint16Array | number[];
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  private extractorPromise: Promise<unknown> | null = null;

  /** 懒加载 pipeline（首次 embed 才触发模型下载），失败时给出明确提示 */
  private async getExtractor(): Promise<{
    (texts: string | string[], options?: { pooling?: string; normalize?: boolean }): Promise<EmbeddingTensor>;
  }> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        try {
          // 动态 require：避免顶层加载把整个 WASM/ONNX 运行时拉进测试
          const { pipeline, env } = await import("@huggingface/transformers");
          // 模型缓存到用户主目录，避免污染项目仓库
          env.cacheDir = TRANSFORMERS_CACHE_DIR;
          return await pipeline("feature-extraction", EMBEDDING_MODEL, {
            dtype: "fp32",
          });
        } catch (err) {
          this.extractorPromise = null; // 允许下次重试
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`${EMBEDDING_FALLBACK_HINT}（原因：${reason}）`);
        }
      })();
    }
    return this.extractorPromise as Promise<{
      (texts: string | string[], options?: { pooling?: string; normalize?: boolean }): Promise<EmbeddingTensor>;
    }>;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const extractor = await this.getExtractor();
      const output = await extractor(texts, {
        pooling: "mean",
        normalize: true,
      });
      const data = Array.from(output.data);
      const dim = output.dims?.[output.dims.length - 1] ?? EMBEDDING_DIM;
      const vectors: number[][] = [];
      for (let i = 0; i < data.length; i += dim) {
        vectors.push(data.slice(i, i + dim));
      }
      return vectors;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${EMBEDDING_FALLBACK_HINT}（原因：${reason}）`);
    }
  }
}

/* ===================== 工厂 ===================== */

export type EmbeddingProviderType = "mock" | "transformers";

/** 按配置切换 embedding 实现（Strategy 模式） */
export function createEmbeddingProvider(
  type: EmbeddingProviderType,
): EmbeddingProvider {
  switch (type) {
    case "mock":
      return new MockEmbeddingProvider();
    case "transformers":
      return new TransformersEmbeddingProvider();
    default:
      throw new Error(`未知 embedding 类型：${String(type)}`);
  }
}
