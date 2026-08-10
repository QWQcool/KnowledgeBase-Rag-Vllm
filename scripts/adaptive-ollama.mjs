// adaptive-ollama.mjs —— 显存自适应：检测空闲显存，推荐 Ollama 推理档位
//
// 用法：
//   node scripts/adaptive-ollama.mjs
//   输出最后一行 LEVEL=HIGH|MID|LOW，供 start-all.bat 用 for /f 读取；
//   前几行是人类可读的检测报告。
//
// 档位表（与 backend/src/gpu/gpu-status.ts 保持一致）：
//   HIGH: 4096 上下文 + 全 GPU      （空闲显存 ≥ 9500 MiB）
//   MID : 2048 上下文 + 24/36 层 GPU（≥ 4800 MiB）
//   LOW : 1024 上下文 + 16/36 层 GPU（≥ 3400 MiB，兜底）
// 无 GPU / 探测失败 → 默认 HIGH（纯 CPU 或无需限制）。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LEVELS = {
  HIGH: { label: "高性能（4096 上下文 · 全 GPU）", minFreeMiB: 9500 },
  MID: { label: "均衡（2048 上下文 · 24 层 GPU）", ctx: 2048, layers: 24, minFreeMiB: 4800 },
  LOW: { label: "低显存（1024 上下文 · 16 层 GPU）", ctx: 1024, layers: 16, minFreeMiB: 3400 },
};

async function probeFreeVramMiB() {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=memory.total,memory.used",
      "--format=csv,noheader,nounits",
    ]);
    const line = stdout.trim().split("\n")[0]?.trim();
    if (!line) return { supported: false, free: null };
    const [total, used] = line.split(",").map((s) => parseInt(s.trim(), 10));
    if (Number.isNaN(total) || Number.isNaN(used)) return { supported: false, free: null };
    return { supported: true, total, used, free: total - used };
  } catch {
    return { supported: false, free: null };
  }
}

function pickLevel(freeMiB) {
  if (freeMiB === null) return "HIGH";
  if (freeMiB >= LEVELS.HIGH.minFreeMiB) return "HIGH";
  if (freeMiB >= LEVELS.MID.minFreeMiB) return "MID";
  return "LOW";
}

const gpu = await probeFreeVramMiB();
const level = pickLevel(gpu.free);
const spec = LEVELS[level];

// 人类可读报告走 stderr（bat 的 for /f 2^>nul 丢弃，不污染 stdout 解析）
if (!gpu.supported) {
  console.error("[adaptive] no NVIDIA GPU detected (or nvidia-smi unavailable), fallback HIGH");
} else {
  console.error(`[adaptive] vram ${gpu.used}MiB / ${gpu.total}MiB, free ${gpu.free}MiB`);
  console.error(
    `[adaptive] recommended ${level}: ${spec.label}` +
      (level === "HIGH" ? "" : ` (OLLAMA_CONTEXT_LENGTH=${spec.ctx} OLLAMA_GPU_LAYERS=${spec.layers})`),
  );
}
// stdout 仅一行纯 ASCII：LEVEL=X（供 start-all.bat for /f 解析）
console.log(`LEVEL=${level}`);
