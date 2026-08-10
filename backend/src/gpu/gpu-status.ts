import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * gpu-status.ts —— 显存检测 + 推理档位建议
 *
 * 背景：qwen3:8b 在 10GB 显存卡上，桌面应用占显存时 4096ctx 会 OOM
 * （llama-server process has terminated）。本模块提供：
 * 1. nvidia-smi 显存探测（无 GPU / 探测失败时优雅降级 supported=false）
 * 2. 三档推理配置表（ctx × GPU 层数 = 显存需求），按空闲显存推荐档位
 * 3. 当前档位（从进程 env 推断）vs 建议档位对比 → safe / advice
 *
 * 设计：GpuProbe 接口依赖注入，测试可 mock，不 spawn 真实 nvidia-smi。
 */

/** 推理档位：HIGH=4096 全 GPU / MID=2048+24 层 / LOW=1024+16 层 */
export type GpuLevel = "HIGH" | "MID" | "LOW";

export interface GpuLevelSpec {
  level: GpuLevel;
  label: string;
  /** Ollama 上下文长度 */
  ctx: number;
  /** GPU 层数（null = 不限制，全 GPU） */
  gpuLayers: number | null;
  /** 该档位安全运行所需最小空闲显存（MiB） */
  minFreeMiB: number;
  /** 给 start-all.bat 的环境变量片段 */
  envHint: string;
}

/** 档位表（实测标定：4096≈9343MiB / 2048+24 层≈4300MiB / 1024+16 层≈3200MiB） */
export const GPU_LEVELS: Record<GpuLevel, GpuLevelSpec> = {
  HIGH: {
    level: "HIGH",
    label: "高性能（4096 上下文 · 全 GPU）",
    ctx: 4096,
    gpuLayers: null,
    minFreeMiB: 9500,
    envHint: "（默认：无需额外环境变量）",
  },
  MID: {
    level: "MID",
    label: "均衡（2048 上下文 · 24/36 层 GPU）",
    ctx: 2048,
    gpuLayers: 24,
    minFreeMiB: 4800,
    envHint: "set OLLAMA_CONTEXT_LENGTH=2048&& set OLLAMA_GPU_LAYERS=24",
  },
  LOW: {
    level: "LOW",
    label: "低显存（1024 上下文 · 16/36 层 GPU）",
    ctx: 1024,
    gpuLayers: 16,
    minFreeMiB: 3400,
    envHint: "set OLLAMA_CONTEXT_LENGTH=1024&& set OLLAMA_GPU_LAYERS=16",
  },
};

/** nvidia-smi 探测结果（supported=false = 无 GPU 或探测失败，字段全 null） */
export interface GpuInfo {
  supported: boolean;
  totalMiB: number | null;
  usedMiB: number | null;
  freeMiB: number | null;
}

/** 显存探测接口（依赖注入，测试可 mock） */
export interface GpuProbe {
  probe(): Promise<GpuInfo>;
}

const execFileAsync = promisify(execFile);

/** 生产实现：调 nvidia-smi 读显存（Windows 上 nvidia-smi 在 PATH） */
export class NvidiaSmiProbe implements GpuProbe {
  async probe(): Promise<GpuInfo> {
    try {
      const { stdout } = await execFileAsync("nvidia-smi", [
        "--query-gpu=memory.total,memory.used",
        "--format=csv,noheader,nounits",
      ]);
      const line = stdout.trim().split("\n")[0]?.trim();
      if (!line) return { supported: false, totalMiB: null, usedMiB: null, freeMiB: null };
      const [total, used] = line.split(",").map((s) => parseInt(s.trim(), 10));
      if (Number.isNaN(total) || Number.isNaN(used)) {
        return { supported: false, totalMiB: null, usedMiB: null, freeMiB: null };
      }
      return { supported: true, totalMiB: total, usedMiB: used, freeMiB: total - used };
    } catch {
      return { supported: false, totalMiB: null, usedMiB: null, freeMiB: null };
    }
  }
}

/** 按空闲显存推荐档位（无 GPU/未知 → 返回 LOW 作为安全默认） */
export function suggestLevel(freeMiB: number | null): GpuLevelSpec {
  if (freeMiB === null) return GPU_LEVELS.LOW;
  if (freeMiB >= GPU_LEVELS.HIGH.minFreeMiB) return GPU_LEVELS.HIGH;
  if (freeMiB >= GPU_LEVELS.MID.minFreeMiB) return GPU_LEVELS.MID;
  return GPU_LEVELS.LOW;
}

/** 从进程环境变量推断当前档位（Ollama 是 serve 进程级 env）；
 *  运行时切换后由 overrideLevel 覆盖（内存态优先，反映实际档位） */
export function currentLevelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrideLevel?: GpuLevel | null,
): GpuLevelSpec {
  if (overrideLevel && GPU_LEVELS[overrideLevel]) return GPU_LEVELS[overrideLevel];
  const ctx = parseInt(env.OLLAMA_CONTEXT_LENGTH ?? "", 10);
  const layers = parseInt(env.OLLAMA_GPU_LAYERS ?? "", 10);
  if (ctx >= 4096 || Number.isNaN(ctx)) return GPU_LEVELS.HIGH;
  if (ctx >= 2048) return layers > 0 ? GPU_LEVELS.MID : GPU_LEVELS.HIGH;
  return layers > 0 ? GPU_LEVELS.LOW : GPU_LEVELS.MID;
}

/** /api/gpu 响应体 */
export interface GpuStatusResponse {
  supported: boolean;
  totalMiB: number | null;
  usedMiB: number | null;
  freeMiB: number | null;
  currentLevel: GpuLevel;
  currentLabel: string;
  suggestedLevel: GpuLevel;
  suggestedLabel: string;
  /** 当前档位下显存是否安全（freeMiB >= 当前档位需求） */
  safe: boolean;
  advice: string;
  /** 档位表（前端渲染切换按钮用） */
  levels: { level: GpuLevel; label: string; minFreeMiB: number }[];
}

/** 组装 /api/gpu 响应 */
export async function gpuStatus(
  probe: GpuProbe = new NvidiaSmiProbe(),
  env: NodeJS.ProcessEnv = process.env,
  overrideLevel?: GpuLevel | null,
): Promise<GpuStatusResponse> {
  const info = await probe.probe();
  const current = currentLevelFromEnv(env, overrideLevel);
  const suggested = suggestLevel(info.freeMiB);
  let advice: string;
  let safe = true;

  if (!info.supported) {
    safe = true;
    advice = "未检测到 NVIDIA GPU（CPU 环境）。显存自适应不可用，推理档位由启动脚本决定。";
  } else if (info.freeMiB! < current.minFreeMiB) {
    safe = false;
    advice = `显存余量 ${info.freeMiB} MiB 低于当前档位需求（${current.minFreeMiB} MiB），推理进程有崩溃风险（llama-server OOM）。建议关闭部分占显存软件，或用启动脚本切换到建议档位「${suggested.label}」。`;
  } else if (suggested.level !== current.level) {
    advice = `当前档位「${current.label}」可用，但显存余量充足（${info.freeMiB} MiB），可重启推理层升到「${suggested.label}」获得更长上下文。`;
  } else {
    advice = `显存余量充足（${info.freeMiB} MiB ≥ ${current.minFreeMiB} MiB），当前档位「${current.label}」安全。`;
  }

  return {
    supported: info.supported,
    totalMiB: info.totalMiB,
    usedMiB: info.usedMiB,
    freeMiB: info.freeMiB,
    currentLevel: current.level,
    currentLabel: current.label,
    suggestedLevel: suggested.level,
    suggestedLabel: suggested.label,
    safe,
    advice,
    levels: Object.values(GPU_LEVELS).map((l) => ({
      level: l.level,
      label: l.label,
      minFreeMiB: l.minFreeMiB,
    })),
  };
}
