import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LlmEngineStatus } from "@rag/shared";
import { createApp } from "./app";
import { LLM_CONFIG_FILENAME, type LlmConfigFile } from "./infra/config";

/**
 * llm-engine.test.ts —— 推理引擎切换端点（GET/PUT /api/llm-engine）
 *
 * 隔离方案：每个用例用独立临时目录写 llm-config.json，并把 RAG_LLM_CONFIG
 * 指向它——不碰仓库根的真实 llm-config.json（避免污染用户配置）。
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

let tmpDir: string;
let cfgPath: string;

/** 测试用 app：注入 mock 引擎服务管理器（不真探测端口 / 不真启动 vLLM/Ollama） */
function createTestApp() {
  const engineServiceManager = {
    getStatus: async (engine: "ollama" | "vllm") => ({ engine, state: "running" as const, pid: null }),
    start: async (engine: "ollama" | "vllm") => ({ engine, state: "running" as const, pid: null }),
    stop: async (engine: "ollama" | "vllm") => ({ engine, state: "stopped" as const, pid: null }),
  };
  return createApp({ engineServiceManager });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-llm-api-"));
  cfgPath = path.join(tmpDir, LLM_CONFIG_FILENAME);
  fs.writeFileSync(cfgPath, JSON.stringify(VALID_JSON, null, 2), "utf8");
  process.env.RAG_LLM_CONFIG = cfgPath;
  delete process.env.RAG_LLM_ENGINE;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  delete process.env.RAG_LLM_CONFIG;
  delete process.env.RAG_LLM_ENGINE;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
});

describe("GET /api/llm-engine", () => {
  it("返回当前引擎 + 全量配置 + 配置文件路径 + requiresRestart=true，符合契约", async () => {
    const app = createTestApp();
    const res = await app.request("/api/llm-engine");

    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmEngineStatus;
    expect(body.engine).toBe("ollama");
    expect(body.engines.ollama!.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(body.engines.vllm!.model).toBe("qwen3-8b-awq");
    expect(body.configPath).toBe(cfgPath);
    expect(body.requiresRestart).toBe(true);
    // 运行时用 Zod 契约再校验一遍
    expect(LlmEngineStatus.safeParse(body).success).toBe(true);
  });

  it("RAG_LLM_ENGINE=vllm 时返回生效引擎 vllm（env 优先级高于 JSON engine 字段）", async () => {
    process.env.RAG_LLM_ENGINE = "vllm";
    const app = createTestApp();
    const res = await app.request("/api/llm-engine");

    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmEngineStatus;
    expect(body.engine).toBe("vllm");
    // JSON 文件里的 engine 仍是 ollama，但响应报的是"生效引擎"
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as LlmConfigFile;
    expect(onDisk.engine).toBe("ollama");
  });

  it("配置文件不存在 → 500", async () => {
    process.env.RAG_LLM_CONFIG = path.join(tmpDir, "missing", "llm-config.json");
    const app = createTestApp();
    const res = await app.request("/api/llm-engine");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("不存在或已损坏");
  });
});

describe("PUT /api/llm-engine", () => {
  it("合法切换 → 200 返回更新后配置，且磁盘文件 engine 字段确实改写（原子写无 tmp 残留）", async () => {
    const app = createTestApp();
    const res = await app.request("/api/llm-engine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "vllm" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmEngineStatus;
    expect(body.engine).toBe("vllm");
    expect(body.requiresRestart).toBe(true);
    expect(body.configPath).toBe(cfgPath);
    expect(LlmEngineStatus.safeParse(body).success).toBe(true);

    // 磁盘文件确已改写：engine 变 vllm，其余字段（engines 全量配置）保留
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as LlmConfigFile;
    expect(onDisk.engine).toBe("vllm");
    expect(onDisk.engines.ollama!.baseUrl).toBe("http://127.0.0.1:11434/v1");

    // 原子写不留 tmp 残渣
    const leftover = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("切换回 ollama 也可反复写（幂等）", async () => {
    const app = createTestApp();
    await app.request("/api/llm-engine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "vllm" }),
    });
    const res2 = await app.request("/api/llm-engine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "ollama" }),
    });

    expect(res2.status).toBe(200);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as LlmConfigFile;
    expect(onDisk.engine).toBe("ollama");
  });

  it("非法引擎值 → 400 且不写盘", async () => {
    const app = createTestApp();
    const res = await app.request("/api/llm-engine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "llama.cpp" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("非法引擎");
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as LlmConfigFile;
    expect(onDisk.engine).toBe("ollama");
  });

  it("非 JSON 请求体 → 400", async () => {
    const app = createTestApp();
    const res = await app.request("/api/llm-engine", { method: "PUT" });

    expect(res.status).toBe(400);
  });

  it("文件写入失败 → 500（mock writeFileSync 抛权限错误），文件内容不变", async () => {
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const app = createTestApp();
    const res = await app.request("/api/llm-engine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "vllm" }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("写入 llm-config.json 失败");
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as LlmConfigFile;
    expect(onDisk.engine).toBe("ollama");
  });

  it("配置文件缺失 → 500（无法读取现有配置，不新建残缺文件）", async () => {
    process.env.RAG_LLM_CONFIG = path.join(tmpDir, "missing", "llm-config.json");
    const app = createTestApp();
    const res = await app.request("/api/llm-engine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "vllm" }),
    });

    expect(res.status).toBe(500);
  });
});
