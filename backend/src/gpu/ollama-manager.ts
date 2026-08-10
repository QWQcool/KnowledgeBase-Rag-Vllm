import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { GPU_LEVELS, type GpuLevel } from "./gpu-status";

/**
 * ollama-manager.ts —— 运行时切换推理档位（重启 Ollama serve 进程）
 *
 * 为什么需要它：Ollama 的上下文长度 / GPU 层数是 serve 进程级环境变量，
 * 改档位必须重启进程。本模块负责：找 PID → kill → 以新 env 拉起 → 等端口就绪。
 *
 * 设计：
 * - OllamaManager 接口依赖注入（测试注入 mock，不真杀进程/不 spawn）
 * - 生产实现 SpawnOllamaManager 用 netstat 找 PID、taskkill 杀、spawn 拉起
 * - 切换前上层已校验显存（本模块只管进程）
 */

export interface OllamaRestartResult {
  ok: boolean;
  message: string;
  pid?: number;
}

export interface OllamaManager {
  /** 重启 Ollama 到目标档位（需上层先校验显存充足） */
  restart(level: GpuLevel): Promise<OllamaRestartResult>;
  /** 估算当前已加载模型占用的显存（MiB）——重启后会释放，切换校验应算入 */
  estimateOllamaVramMiB(): Promise<number>;
}

const execFileAsync = promisify(execFile);

/** 解析 ollama ps 的 SIZE 列（如 "5.1 GB" / "512 MB"）→ MiB */
export function parseOllamaPsSize(output: string): number {
  let totalMiB = 0;
  for (const line of output.split("\n").slice(1)) {
    const cols = line.trim().split(/\s{2,}|\t+/);
    const sizeCell = cols[2];
    if (!sizeCell) continue;
    const m = sizeCell.match(/^([\d.]+)\s*(MB|GB)$/i);
    if (!m) continue;
    const val = parseFloat(m[1]);
    totalMiB += m[2].toUpperCase() === "GB" ? val * 1024 : val;
  }
  return Math.round(totalMiB);
}

/** 定位 ollama 可执行文件：PATH 优先，退回标准安装位置 */
export function locateOllamaBin(env: NodeJS.ProcessEnv = process.env): string {
  const standard = `${env.LOCALAPPDATA ?? ""}\\Programs\\Ollama\\ollama.exe`;
  return env.OLLAMA_BIN ?? standard;
}

/** 从 netstat 输出解析监听 11434 端口的 PID（无则 null） */
export function parseOllamaPid(netstatOutput: string): number | null {
  for (const line of netstatOutput.split("\n")) {
    if (line.includes("11434") && line.toUpperCase().includes("LISTENING")) {
      const pid = parseInt(line.trim().split(/\s+/).pop() ?? "", 10);
      if (!Number.isNaN(pid)) return pid;
    }
  }
  return null;
}

/** 轮询直到端口可探测（GET /api/tags 返回 200），最多 timeoutMs */
export async function waitOllamaReady(
  port: number,
  timeoutMs = 20000,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/tags`);
      if (res.ok) return true;
    } catch {
      // 未就绪，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 生产实现：真实 kill + spawn 重启 Ollama */
export class SpawnOllamaManager implements OllamaManager {
  constructor(private readonly options: { port?: number; ollamaBin?: string } = {}) {
    this.port = options.port ?? 11434;
    this.ollamaBin = options.ollamaBin ?? locateOllamaBin();
  }
  private readonly port: number;
  private readonly ollamaBin: string;

  /** 用 netstat 找监听端口的 PID（测试可注入 netstatImpl） */
  async findPid(netstatImpl: (() => Promise<string>) | null = null): Promise<number | null> {
    try {
      const run = netstatImpl ?? (async () => (await execFileAsync("netstat", ["-ano"])).stdout);
      return parseOllamaPid(await run());
    } catch {
      return null;
    }
  }

  async kill(pid: number): Promise<void> {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/F"]);
    } catch {
      // 进程可能已退出，忽略
    }
  }

  /** 调 `ollama ps` 解析已加载模型占用的显存（重启会释放；失败按 0 计） */
  async estimateOllamaVramMiB(psImpl: (() => Promise<string>) | null = null): Promise<number> {
    try {
      const run = psImpl ?? (async () => (await execFileAsync(this.ollamaBin, ["ps"])).stdout);
      return parseOllamaPsSize(await run());
    } catch {
      return 0;
    }
  }

  async restart(level: GpuLevel): Promise<OllamaRestartResult> {
    const spec = GPU_LEVELS[level];
    try {
      // 1. 找旧进程并杀
      const pid = await this.findPid();
      if (pid !== null) await this.kill(pid);
      await new Promise((r) => setTimeout(r, 800));

      // 2. 以目标档位 env 拉起（detached：后端进程退出后 Ollama 仍存活）
      const childEnv = { ...process.env } as NodeJS.ProcessEnv;
      if (spec.gpuLayers !== null) {
        childEnv.OLLAMA_CONTEXT_LENGTH = String(spec.ctx);
        childEnv.OLLAMA_GPU_LAYERS = String(spec.gpuLayers);
      } else {
        delete childEnv.OLLAMA_CONTEXT_LENGTH;
        delete childEnv.OLLAMA_GPU_LAYERS;
      }
      const child = spawn(this.ollamaBin, ["serve"], {
        env: childEnv,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      // 3. 等端口就绪
      const ready = await waitOllamaReady(this.port);
      if (!ready) {
        return {
          ok: false,
          message: `Ollama 已在 ${this.port} 端口拉起但 ${20}s 内未就绪（模型加载慢或启动失败），请稍后重试或手动启动`,
        };
      }
      return {
        ok: true,
        message: `已切换到档位「${spec.label}」并重启推理层`,
        pid: child.pid,
      };
    } catch (err) {
      return {
        ok: false,
        message: `切换档位失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** 测试用 no-op manager（不做任何进程操作） */
export function createMockOllamaManager(impl?: Partial<OllamaManager>): OllamaManager {
  return {
    async restart() {
      return { ok: true, message: "[mock] 已切换档位", pid: 1 };
    },
    async estimateOllamaVramMiB() {
      return 0;
    },
    ...impl,
  };
}
