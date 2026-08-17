// engine-service.ts —— 推理引擎服务进程管理（2026-08-17 新增）
//
// 职责：管理 Ollama / vLLM 两个推理服务的启动、停止与健康轮询，让前端
// "切换引擎"时后端自动拉起目标服务（无需用户手动跑 start-vllm.bat / ollama serve）。
//
// 设计要点：
// - 端口探测判定"是否在跑"（存量进程也能识别，不依赖 spawn 记忆）
// - vLLM 启动走 `cmd /c "call vcvars64.bat && vllm serve ..."`——flashinfer JIT 需要
//   MSVC 环境（cl.exe/INCLUDE/LIB），直接 spawn vllm.exe 会 FileNotFoundError（见
//   docs/vllm-migration-report.md §6.3 第 2 条）。日志重定向到文件。
// - 健康轮询：vLLM 查 :8000/v1/models（加载模型需 1~3 分钟，超时 300s）；
//   Ollama 查 :11434/api/tags（超时 60s）。
// - 所有探测/轮询函数可注入，测试用 mock，不真启动进程。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmEngine, LlmEngineEndpoint, LlmEngineStatus } from "@rag/shared";

export type EngineServiceState = "unknown" | "stopped" | "starting" | "running" | "error";

export interface EngineServiceInfo {
  engine: LlmEngine;
  state: EngineServiceState;
  pid: number | null;
  message?: string;
}

/** 端口/健康探测函数（可注入 mock） */
export interface ServiceProber {
  /** 探测服务是否健康（端口 + 健康端点均通返回 true） */
  probe(engine: LlmEngine): Promise<boolean>;
}

export interface EngineServiceManager {
  /** 查询引擎服务当前状态（实时探测，不缓存） */
  getStatus(engine: LlmEngine): Promise<EngineServiceInfo>;
  /** 异步启动服务并轮询健康；已 running 直接返回。返回最终状态 */
  start(engine: LlmEngine): Promise<EngineServiceInfo>;
  /** 停止服务进程（spawn 出来的子进程；存量进程不杀，避免误伤） */
  stop(engine: LlmEngine): Promise<EngineServiceInfo>;
}

/** 默认探测实现：HTTP GET 健康端点，超时 3s */
class HttpProber implements ServiceProber {
  constructor(private endpoints: Record<LlmEngine, string>) {}

  async probe(engine: LlmEngine): Promise<boolean> {
    const url = this.endpoints[engine];
    if (!url) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }
}

export interface EngineServiceManagerOptions {
  /** 引擎端点配置（来自 llm-config.json / 环境变量） */
  engines: Record<LlmEngine, LlmEngineEndpoint>;
  /** 健康探测（缺省 HTTP 探测） */
  prober?: ServiceProber;
  /** 日志目录（服务 stdout/stderr 重定向，缺省系统临时目录） */
  logDir?: string;
  /** 是否允许真实 spawn（测试注入 false） */
  allowSpawn?: boolean;
}

/** vLLM 健康端点与启动参数（与 start-vllm.bat 对齐；参数按 10GB 卡校准） */
const VLLM_PORT = 8000;
const OLLAMA_PORT = 11434;
const VLLM_START_TIMEOUT_MS = 300_000; // 模型加载 1~3 分钟
const OLLAMA_START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;

/** 探测 vcvars64.bat（VS 安装目录），供 vLLM 启动用 */
function findVcvars64(): string | null {
  const vsRoot = "C:\\Program Files\\Microsoft Visual Studio\\2022";
  for (const edition of ["Professional", "Enterprise", "Community", "BuildTools", "Preview"]) {
    const p = path.join(vsRoot, edition, "VC", "Auxiliary", "Build", "vcvars64.bat");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export class DefaultEngineServiceManager implements EngineServiceManager {
  private readonly prober: ServiceProber;
  private readonly logDir: string;
  private readonly allowSpawn: boolean;
  private readonly vllmVenv: string;
  private readonly vllmModelDir: string;
  /** spawn 出来的子进程句柄（stop 用）；服务就绪后不释放（stop 需 kill 进程树） */
  private readonly children = new Map<LlmEngine, ReturnType<typeof spawn>>();

  constructor(private opts: EngineServiceManagerOptions) {
    this.prober = opts.prober ?? new HttpProber({
      ollama: `http://127.0.0.1:${OLLAMA_PORT}/api/tags`,
      vllm: `http://127.0.0.1:${VLLM_PORT}/v1/models`,
    });
    this.logDir = opts.logDir ?? path.join(os.tmpdir(), "rag-engine-logs");
    this.allowSpawn = opts.allowSpawn ?? true;
    this.vllmVenv = process.env.VLLM_VENV ?? path.join(os.homedir(), "venvs", "vllm-py312");
    // 模型目录：与 start-vllm.bat 对齐（RAG_libraries/models/Qwen3-8B-AWQ）
    const here = path.dirname(fileURLToPath(import.meta.url)); // backend/src
    this.vllmModelDir =
      process.env.VLLM_MODEL_DIR ?? path.resolve(here, "..", "..", "models", "Qwen3-8B-AWQ");
  }

  private baseInfo(engine: LlmEngine, state: EngineServiceState, message?: string): EngineServiceInfo {
    return { engine, state, pid: this.children.get(engine)?.pid ?? null, message };
  }

  async getStatus(engine: LlmEngine): Promise<EngineServiceInfo> {
    const healthy = await this.prober.probe(engine);
    return this.baseInfo(engine, healthy ? "running" : "stopped");
  }

  async start(engine: LlmEngine): Promise<EngineServiceInfo> {
    const healthy = await this.prober.probe(engine);
    if (healthy) return this.baseInfo(engine, "running");
    if (!this.allowSpawn) return this.baseInfo(engine, "error", "测试环境不允许真实启动");

    this.spawnService(engine);
    const deadline = Date.now() + (engine === "vllm" ? VLLM_START_TIMEOUT_MS : OLLAMA_START_TIMEOUT_MS);
    // 轮询健康直到就绪/超时
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (await this.prober.probe(engine)) {
        return this.baseInfo(engine, "running", "服务已就绪");
      }
    }
    // 超时：不 kill（可能还在加载），报 error 提示
    return this.baseInfo(
      engine,
      "error",
      engine === "vllm"
        ? "vLLM 启动超时（>5 分钟）。请查看日志或手动运行 start-vllm.bat"
        : "Ollama 启动超时（>60s），请手动运行 ollama serve",
    );
  }

  async stop(engine: LlmEngine): Promise<EngineServiceInfo> {
    const child = this.children.get(engine);
    if (child && !child.killed) {
      // Windows 杀进程树（vllm 有 APIServer/EngineCore 多进程；ollama 有 llama-server 子进程）
      spawn("taskkill", ["/PID", String(child.pid), "/F", "/T"], { stdio: "ignore" });
      child.kill();
      this.children.delete(engine);
    }
    // 端口可能残留 TIME_WAIT，稍等再探测
    await sleep(1500);
    const healthy = await this.prober.probe(engine);
    return this.baseInfo(engine, healthy ? "running" : "stopped");
  }

  /** 拉起服务进程（spawn 后立即返回；健康由 start 的轮询负责） */
  private spawnService(engine: LlmEngine): void {
    fs.mkdirSync(this.logDir, { recursive: true });
    if (engine === "vllm") {
      const vcvars = findVcvars64();
      const vllmExe = path.join(this.vllmVenv, "Scripts", "vllm.exe");
      const cudart =
        process.env.VLLM_CUDART_SO_PATH ??
        "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1\\bin\\x64\\cudart64_13.dll";
      // 写成临时 .bat 再执行：cmd /c 内联字符串会把嵌套引号/反斜杠解析坏（路径吞 \），
      // bat 文件按行解析无此问题（2026-08-17 实测：内联版 vcvars 路径被截断，vllm 起不来）
      // bat 开头顺带清理 vLLM 内部 ZMQ 端口 29550 残留（崩溃后常被占，导致 Address in use）
      const bat = [
        "@echo off",
        "for /f \"tokens=5\" %%a in ('netstat -ano ^| findstr \":29550\" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1",
        `call "${vcvars}" >nul 2>&1`,
        `set "VLLM_CUDART_SO_PATH=${cudart}"`,
        `"${vllmExe}" serve "${this.vllmModelDir}" --served-model-name qwen3-8b-awq --port ${VLLM_PORT} --gpu-memory-utilization 0.85 --max-model-len 8192 --quantization awq --dtype auto`,
      ].join("\r\n");
      const batPath = path.join(this.logDir, "start-vllm.bat");
      fs.writeFileSync(batPath, bat, "utf8");
      const logFile = path.join(this.logDir, "vllm.log");
      // 后台进程里直接给 spawn 传文件描述符在 WorkBuddy 环境会静默失败，
      // 因此再包一层 runner.bat，由 cmd 自己把 stdout/stderr 重定向到日志文件。
      const runnerPath = path.join(this.logDir, "start-vllm-run.bat");
      const runner = [
        "@echo off",
        `call "${batPath}" >> "${logFile}" 2>&1`,
      ].join("\r\n");
      fs.writeFileSync(runnerPath, runner, "utf8");
      const child = spawn("cmd.exe", ["/c", runnerPath], {
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      console.log(`[engine-service] vllm spawn pid=${child.pid} runner=${runnerPath}`);
      child.on("error", (err) => {
        console.error("[engine-service] vllm spawn error:", err);
      });
      child.on("exit", (code, signal) => {
        console.log(`[engine-service] vllm process exited code=${code} signal=${signal}`);
        this.children.delete("vllm");
      });
      this.children.set("vllm", child);
    } else {
      // Ollama：ollama serve（若 ollama.exe 不在 PATH，常见安装目录探测）
      const exe = process.env.OLLAMA_EXE ?? "ollama.exe";
      const logFile = path.join(this.logDir, "ollama.log");
      const runnerPath = path.join(this.logDir, "ollama-serve-run.bat");
      const runner = [
        "@echo off",
        `"${exe}" serve >> "${logFile}" 2>&1`,
      ].join("\r\n");
      fs.writeFileSync(runnerPath, runner, "utf8");
      const child = spawn("cmd.exe", ["/c", runnerPath], {
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      console.log(`[engine-service] ollama spawn pid=${child.pid} runner=${runnerPath}`);
      child.on("error", (err) => {
        console.error("[engine-service] ollama spawn error:", err);
      });
      child.on("exit", (code, signal) => {
        console.log(`[engine-service] ollama process exited code=${code} signal=${signal}`);
        this.children.delete("ollama");
      });
      this.children.set("ollama", child);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
