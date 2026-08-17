import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getActiveLlmConfig,
  getLlmConfigField,
  LLM_CONFIG_FILENAME,
  loadLlmConfig,
  resolveActiveEngine,
  resolveLlmConfigPath,
  type LlmConfigFile,
} from "./config";

/**
 * infra/config.test.ts —— llm-config.json 优先级与回退
 *
 * 覆盖要点：
 * - JSON 存在时用 JSON 的值（engine 选择、字段读取）
 * - RAG_LLM_ENGINE 环境变量可临时覆盖 JSON 的 engine（start-all.bat --engine 用）
 * - JSON 不存在/非法/引擎配置缺失 → 回退环境变量（向后兼容：行为与旧版一致）
 */

const VALID_JSON = {
  engine: "ollama",
  engines: {
    ollama: {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      apiKey: "ollama",
    },
    vllm: {
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "qwen3-8b-awq",
      apiKey: "EMPTY",
    },
  },
} satisfies LlmConfigFile;

/** 写一个临时 llm-config.json 并让 RAG_LLM_CONFIG 指向它（测试隔离，不碰仓库根的真实文件） */
function makeTmpConfig(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-llmcfg-"));
  const p = path.join(dir, LLM_CONFIG_FILENAME);
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  process.env.RAG_LLM_CONFIG = p;
  return p;
}

function cleanup() {
  // RAG_LLM_CONFIG 指向的临时文件由 afterEach 清理
  const p = process.env.RAG_LLM_CONFIG;
  if (p) {
    try {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
  delete process.env.RAG_LLM_CONFIG;
  delete process.env.RAG_LLM_ENGINE;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_API_KEY;
}
afterEach(cleanup);

describe("resolveLlmConfigPath", () => {
  it("默认解析到仓库根目录的 llm-config.json（相对模块位置，与 cwd 无关）", () => {
    delete process.env.RAG_LLM_CONFIG;
    const p = resolveLlmConfigPath();
    expect(path.basename(p)).toBe(LLM_CONFIG_FILENAME);
    // 仓库根目录下应已存在该文件（我们交付的默认配置）
    expect(fs.existsSync(p)).toBe(true);
  });

  it("RAG_LLM_CONFIG 显式指定时优先使用该路径", () => {
    process.env.RAG_LLM_CONFIG = "C:/tmp/custom-llm.json";
    expect(resolveLlmConfigPath()).toBe("C:/tmp/custom-llm.json");
  });
});

describe("loadLlmConfig", () => {
  it("解析合法 JSON：engine + engines 结构完整读回", () => {
    makeTmpConfig(VALID_JSON);
    const cfg = loadLlmConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.engine).toBe("ollama");
    expect(cfg?.engines.vllm?.baseUrl).toBe("http://127.0.0.1:8000/v1");
  });

  it("文件不存在 → null（调用方回退环境变量）", () => {
    process.env.RAG_LLM_CONFIG = path.join(os.tmpdir(), "does-not-exist-llm.json");
    expect(loadLlmConfig()).toBeNull();
  });

  it("非法 JSON（语法错误）→ null，不抛异常", () => {
    makeTmpConfig("{ not valid json ");
    expect(loadLlmConfig()).toBeNull();
  });

  it("engine 字段非法 → null", () => {
    makeTmpConfig({ engine: "llama.cpp", engines: {} });
    expect(loadLlmConfig()).toBeNull();
  });
});

describe("resolveActiveEngine", () => {
  it("无 RAG_LLM_ENGINE 时用 JSON 的 engine 字段", () => {
    delete process.env.RAG_LLM_ENGINE;
    expect(resolveActiveEngine(VALID_JSON)).toBe("ollama");
  });

  it("RAG_LLM_ENGINE=vllm 覆盖 JSON 的 engine=ollama", () => {
    process.env.RAG_LLM_ENGINE = "vllm";
    expect(resolveActiveEngine(VALID_JSON)).toBe("vllm");
  });
});

describe("getActiveLlmConfig", () => {
  it("JSON 存在：按 engine 字段返回对应引擎的完整配置", () => {
    makeTmpConfig(VALID_JSON);
    const cfg = getActiveLlmConfig();
    expect(cfg).toEqual({
      engine: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      apiKey: "ollama",
    });
  });

  it("RAG_LLM_ENGINE=vllm：即使 JSON.engine=ollama 也切到 vllm 配置", () => {
    makeTmpConfig(VALID_JSON);
    process.env.RAG_LLM_ENGINE = "vllm";
    const cfg = getActiveLlmConfig();
    expect(cfg?.engine).toBe("vllm");
    expect(cfg?.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(cfg?.model).toBe("qwen3-8b-awq");
  });

  it("JSON 字段缺省（仅配 baseUrl）→ 其余字段回退环境变量", () => {
    makeTmpConfig({ engine: "ollama", engines: { ollama: { baseUrl: "http://x/v1" } } });
    process.env.OPENAI_MODEL = "env-model";
    process.env.OPENAI_API_KEY = "env-key";
    const cfg = getActiveLlmConfig();
    expect(cfg?.baseUrl).toBe("http://x/v1");
    expect(cfg?.model).toBe("env-model");
    expect(cfg?.apiKey).toBe("env-key");
  });

  it("JSON 里没有当前 engine 的配置 → null（回退环境变量）", () => {
    makeTmpConfig({ engine: "vllm", engines: {} });
    expect(getActiveLlmConfig()).toBeNull();
  });

  it("JSON 不存在 → null（纯环境变量模式，向后兼容）", () => {
    process.env.RAG_LLM_CONFIG = path.join(os.tmpdir(), "nope-llm.json");
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
    expect(getActiveLlmConfig()).toBeNull();
  });
});

describe("getLlmConfigField（端点读取的唯一入口）", () => {
  it("JSON 存在时用 JSON 的值（即使环境变量已设置）", () => {
    makeTmpConfig(VALID_JSON);
    process.env.OPENAI_BASE_URL = "http://should-not-win:9999/v1";
    expect(getLlmConfigField("baseUrl")).toBe("http://127.0.0.1:11434/v1");
    expect(getLlmConfigField("model")).toBe("qwen3:8b");
    expect(getLlmConfigField("apiKey")).toBe("ollama");
  });

  it("无 JSON 时回退环境变量（与旧版行为一致）", () => {
    process.env.RAG_LLM_CONFIG = path.join(os.tmpdir(), "nope-llm.json");
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
    process.env.OPENAI_MODEL = "qwen3:8b";
    process.env.OPENAI_API_KEY = "ollama";
    expect(getLlmConfigField("baseUrl")).toBe("http://127.0.0.1:11434/v1");
    expect(getLlmConfigField("model")).toBe("qwen3:8b");
    expect(getLlmConfigField("apiKey")).toBe("ollama");
  });

  it("JSON 存在但 engine 配置缺失 → 回退环境变量", () => {
    makeTmpConfig({ engine: "vllm", engines: {} });
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:8000/v1";
    expect(getLlmConfigField("baseUrl")).toBe("http://127.0.0.1:8000/v1");
  });
});
