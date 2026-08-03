import os from "node:os";
import path from "node:path";

/**
 * infra/config.ts —— 基础设施配置（M2 唯一配置源，路径/模型集中在此，不散落）
 */

/** 向量库数据目录：默认 backend/data/lancedb/，可用环境变量 RAG_LANCEDB_DIR 覆盖（测试用临时目录） */
export const LANCEDB_DATA_DIR =
  process.env.RAG_LANCEDB_DIR ?? path.resolve(process.cwd(), "data", "lancedb");

/** Transformers.js 模型缓存目录：默认放用户主目录，避免污染项目仓库 */
export const TRANSFORMERS_CACHE_DIR =
  process.env.RAG_HF_CACHE_DIR ??
  path.join(os.homedir(), ".cache", "huggingface", "transformers");

/** 向量维度：与 all-MiniLM-L6-v2 及 Mock 对齐 */
export const EMBEDDING_DIM = 384;

/** Transformers.js 使用的 embedding 模型（HF hub 名称，首次运行自动下载） */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** 在线模型不可用时的降级提示（配合 try/catch 抛出） */
export const EMBEDDING_FALLBACK_HINT =
  "模型下载失败或加载失败：请检查网络，或在配置中改用 mock embedding（createEmbeddingProvider('mock')）";
