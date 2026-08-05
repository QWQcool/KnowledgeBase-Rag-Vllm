import os from "node:os";
import path from "node:path";

/**
 * infra/config.ts —— 基础设施配置（M2 唯一配置源，路径/模型集中在此，不散落）
 */

/** 向量库数据目录：默认 backend/data/trivium/，可用环境变量 RAG_TRIVIUM_DIR 覆盖（测试用临时目录） */
export const TRIVIUM_DATA_DIR =
  process.env.RAG_TRIVIUM_DIR ?? path.resolve(process.cwd(), "data", "trivium");

/** Transformers.js 模型缓存目录：默认放用户主目录，避免污染项目仓库 */
export const TRANSFORMERS_CACHE_DIR =
  process.env.RAG_HF_CACHE_DIR ??
  path.join(os.homedir(), ".cache", "huggingface", "transformers");

/**
 * 向量维度：默认 384（与 multilingual-e5-small 及 Mock 对齐）。
 * 切到 llama-server /v1/embeddings（如 bge-m3=1024、text-embedding-3-small=1536）
 * 时必须用环境变量 RAG_EMBEDDING_DIM 覆盖，且与入库时一致——
 * 维度变 = 已入库向量作废，需清 data/trivium/ 重建索引。
 */
export const EMBEDDING_DIM = Number(process.env.RAG_EMBEDDING_DIM ?? 384);

/**
 * Transformers.js 使用的 embedding 模型（HF hub 名称，首次运行自动下载）。
 * M4 起改用 multilingual-e5-small（多语言含中文，384 维，有 ONNX 文件）——
 * all-MiniLM-L6-v2 是英文模型，对中文问句标点过于敏感。
 * 注：Xenova/bge-small-zh-v1.5 仓库缺 ONNX 文件无法用于 Transformers.js。
 */
export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

/** 在线模型不可用时的降级提示（配合 try/catch 抛出） */
export const EMBEDDING_FALLBACK_HINT =
  "模型下载失败或加载失败：请检查网络，或在配置中改用 mock embedding（createEmbeddingProvider('mock')）";
