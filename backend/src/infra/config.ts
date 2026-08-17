import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * infra/config.ts —— 基础设施配置（M2 唯一配置源，路径/模型集中在此，不散落）
 *
 * LLM 引擎配置优先级（llm-config.json 优先，回退环境变量）：
 *   1) RAG_libraries/llm-config.json（可用 RAG_LLM_CONFIG 覆盖路径）
 *   2) 环境变量 OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY
 * 无 llm-config.json 时行为与旧版完全一致（纯环境变量），保证向后兼容。
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
export const EMBEDDING_MODEL =
  process.env.RAG_EMBEDDING_MODEL ?? "Xenova/multilingual-e5-small";

/** 在线模型不可用时的降级提示（配合 try/catch 抛出） */
export const EMBEDDING_FALLBACK_HINT =
  "模型下载失败或加载失败：请检查网络，或在配置中改用 mock embedding（createEmbeddingProvider('mock')）";

/* ==================== LLM 引擎配置（llm-config.json 优先，回退环境变量） ==================== */

/** LLM 引擎标识（Agent 2 前端引擎切换下拉的可选值，新增引擎需同步扩展） */
export type LlmEngineName = "ollama" | "vllm";

/** 单个引擎的 OpenAI 兼容端点配置 */
export interface LlmEngineConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * llm-config.json 的文件结构（Agent 2 前端引擎切换依赖此 schema，改动需同步前端）：
 * {
 *   "engine": "ollama",                                  // 当前生效引擎
 *   "engines": {                                          // 各引擎端点配置
 *     "ollama": { "baseUrl": "...", "model": "...", "apiKey": "..." },
 *     "vllm":   { "baseUrl": "...", "model": "...", "apiKey": "..." }
 *   }
 * }
 * 可选扩展：RAG_LLM_ENGINE 环境变量可在不改 JSON 的情况下临时覆盖 engine
 * （start-all.bat --engine vllm 就是这么做的）。
 */
export interface LlmConfigFile {
  engine: LlmEngineName;
  engines: Partial<Record<LlmEngineName, Partial<LlmEngineConfig>>>;
}

/** llm-config.json 文件名（固定放 RAG_libraries 根目录） */
export const LLM_CONFIG_FILENAME = "llm-config.json";

/**
 * 定位 llm-config.json 的路径：
 * 1) 环境变量 RAG_LLM_CONFIG 显式指定（测试注入 / 临时切换用）
 * 2) 默认：相对本文件（backend/src/infra/config.ts）向上 3 级 → RAG_libraries 根目录。
 *    用 import.meta.url 而非 process.cwd()，从任意目录启动 backend 都能找到。
 */
export function resolveLlmConfigPath(): string {
  if (process.env.RAG_LLM_CONFIG) return process.env.RAG_LLM_CONFIG;
  const here = path.dirname(fileURLToPath(import.meta.url)); // backend/src/infra
  return path.resolve(here, "..", "..", "..", LLM_CONFIG_FILENAME); // → RAG_libraries 根
}

/**
 * 读取并解析 llm-config.json。
 * 文件不存在、JSON 非法、engine 字段非法 → 返回 null（调用方回退环境变量，向后兼容）。
 */
export function loadLlmConfig(): LlmConfigFile | null {
  const p = resolveLlmConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as LlmConfigFile;
    if (raw.engine !== "ollama" && raw.engine !== "vllm") return null;
    return raw;
  } catch (err) {
    console.warn(
      `[config] 解析 ${p} 失败，回退环境变量：${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** 当前生效引擎：RAG_LLM_ENGINE（启动脚本 --engine 写入）优先，其次 JSON 的 engine 字段 */
export function resolveActiveEngine(file: LlmConfigFile): LlmEngineName {
  const fromEnv = process.env.RAG_LLM_ENGINE;
  if (fromEnv === "ollama" || fromEnv === "vllm") return fromEnv;
  return file.engine;
}

/**
 * 当前生效的引擎配置（JSON 字段优先，缺省回退环境变量；无 JSON → null）。
 * baseUrl/model/apiKey 逐字段取「JSON ?? 环境变量」，便于 JSON 里只配想覆盖的字段。
 */
export function getActiveLlmConfig(): {
  engine: LlmEngineName;
  baseUrl: string;
  model: string;
  apiKey: string;
} | null {
  const file = loadLlmConfig();
  if (!file) return null;
  const engine = resolveActiveEngine(file);
  const eng = file.engines?.[engine];
  if (!eng) return null;
  return {
    engine,
    baseUrl: eng.baseUrl ?? process.env.OPENAI_BASE_URL ?? "",
    model: eng.model ?? process.env.OPENAI_MODEL ?? "",
    apiKey: eng.apiKey ?? process.env.OPENAI_API_KEY ?? "",
  };
}

/**
 * 单字段读取 LLM 端点配置：llm-config.json → 环境变量 → undefined。
 * 所有读取 LLM baseUrl/model/apiKey 的位置（llm-provider、/api/model）统一走这里，
 * 保证「JSON 存在时用 JSON 的值，不存在时回退环境变量」在全局只实现一次。
 */
export function getLlmConfigField(
  key: "baseUrl" | "model" | "apiKey",
): string | undefined {
  const active = getActiveLlmConfig();
  if (active) {
    const v = active[key];
    if (v) return v;
  }
  switch (key) {
    case "baseUrl":
      return process.env.OPENAI_BASE_URL;
    case "model":
      return process.env.OPENAI_MODEL;
    case "apiKey":
      return process.env.OPENAI_API_KEY;
  }
}

/**
 * 切换生效引擎：把 llm-config.json 的 engine 字段改写为目标引擎（PUT /api/llm-engine）。
 *
 * 设计要点：
 * - **只写 JSON 的 engine 字段，绝不写环境变量**——RAG_LLM_ENGINE 优先级高于 JSON，
 *   若写环境变量会反过来覆盖 JSON 造成"改了但没生效"的困惑（README 有提醒）。
 * - 原子写：先写 `<file>.<pid>.tmp` 再 rename 覆盖，避免写一半崩溃留下损坏 JSON。
 * - 保留原有 engines 等其余字段，只替换 engine。
 * - 文件不存在 / JSON 解析失败（loadLlmConfig 返回 null）→ 抛错，调用方返回 500。
 */
export function updateLlmConfigEngine(engine: LlmEngineName): LlmConfigFile {
  const p = resolveLlmConfigPath();
  const existing = loadLlmConfig();
  if (!existing) {
    throw new Error(`llm-config.json（${p}）不存在或已损坏，无法切换引擎`);
  }
  const next: LlmConfigFile = { ...existing, engine };
  // 原子写：tmp 与目标同目录，保证 rename 在同一文件系统内（不会跨盘失败）
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
  return next;
}
