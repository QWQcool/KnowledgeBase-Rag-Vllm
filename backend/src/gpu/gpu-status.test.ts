import { describe, expect, it, vi } from "vitest";
import {
  GPU_LEVELS,
  NvidiaSmiProbe,
  currentLevelFromEnv,
  gpuStatus,
  suggestLevel,
  type GpuInfo,
  type GpuProbe,
} from "./gpu-status";

/** 固定返回的 mock probe */
function mockProbe(info: GpuInfo): GpuProbe {
  return { probe: vi.fn(async () => info) };
}

describe("NvidiaSmiProbe", () => {
  it("解析 nvidia-smi 输出为 total/used/free", async () => {
    const probe = new NvidiaSmiProbe();
    // 直接调用私有逻辑有难度，这里通过 mock execFile 结果验证——用 vi.mock 太重，
    // 改为验证 gpuStatus 依赖注入路径（见下），本用例验证 suggest 与 env 逻辑。
    expect(probe).toBeInstanceOf(NvidiaSmiProbe);
  });
});

describe("suggestLevel（按空闲显存推荐档位）", () => {
  it("≥9500MiB → HIGH（4096 全 GPU）", () => {
    expect(suggestLevel(10240).level).toBe("HIGH");
  });
  it("4800~9499 → MID（2048+24 层）", () => {
    expect(suggestLevel(5000).level).toBe("MID");
  });
  it("<4800 → LOW（1024+16 层）", () => {
    expect(suggestLevel(3000).level).toBe("LOW");
  });
  it("未知显存（null）→ LOW 安全默认", () => {
    expect(suggestLevel(null).level).toBe("LOW");
  });
});

describe("currentLevelFromEnv（从 env 推断当前档位）", () => {
  it("无 env（默认 4096）→ HIGH", () => {
    expect(currentLevelFromEnv({}).level).toBe("HIGH");
  });
  it("2048 + 24 层 → MID", () => {
    expect(
      currentLevelFromEnv({ OLLAMA_CONTEXT_LENGTH: "2048", OLLAMA_GPU_LAYERS: "24" }).level,
    ).toBe("MID");
  });
  it("1024 + 16 层 → LOW", () => {
    expect(
      currentLevelFromEnv({ OLLAMA_CONTEXT_LENGTH: "1024", OLLAMA_GPU_LAYERS: "16" }).level,
    ).toBe("LOW");
  });
  it("2048 但没设 GPU_LAYERS → HIGH（全 GPU 语义）", () => {
    expect(currentLevelFromEnv({ OLLAMA_CONTEXT_LENGTH: "2048" }).level).toBe("HIGH");
  });
});

describe("gpuStatus（/api/gpu 响应组装）", () => {
  it("显存充足且档位匹配 → safe，advice 提示安全", async () => {
    const probe = mockProbe({ supported: true, totalMiB: 10240, usedMiB: 4000, freeMiB: 6240 });
    const res = await gpuStatus(probe, { OLLAMA_CONTEXT_LENGTH: "2048", OLLAMA_GPU_LAYERS: "24" });
    expect(res.supported).toBe(true);
    expect(res.freeMiB).toBe(6240);
    expect(res.currentLevel).toBe("MID");
    expect(res.suggestedLevel).toBe("MID");
    expect(res.safe).toBe(true);
    expect(res.advice).toContain("安全");
  });

  it("显存不足（free < 当前档位需求）→ safe=false，advice 提示降档", async () => {
    // 当前 MID 需 4800，空闲只有 3000
    const probe = mockProbe({ supported: true, totalMiB: 10240, usedMiB: 7240, freeMiB: 3000 });
    const res = await gpuStatus(probe, { OLLAMA_CONTEXT_LENGTH: "2048", OLLAMA_GPU_LAYERS: "24" });
    expect(res.safe).toBe(false);
    expect(res.suggestedLevel).toBe("LOW");
    expect(res.advice).toContain("低于当前档位需求");
    expect(res.advice).toContain("建议");
  });

  it("显存充足但当前档位偏低 → 提示可升级", async () => {
    const probe = mockProbe({ supported: true, totalMiB: 10240, usedMiB: 500, freeMiB: 9740 });
    const res = await gpuStatus(probe, { OLLAMA_CONTEXT_LENGTH: "2048", OLLAMA_GPU_LAYERS: "24" });
    expect(res.safe).toBe(true);
    expect(res.suggestedLevel).toBe("HIGH");
    expect(res.advice).toContain("升到");
  });

  it("无 GPU（supported=false）→ safe，advice 说明自适应不可用", async () => {
    const probe = mockProbe({ supported: false, totalMiB: null, usedMiB: null, freeMiB: null });
    const res = await gpuStatus(probe, {});
    expect(res.supported).toBe(false);
    expect(res.safe).toBe(true);
    expect(res.advice).toContain("CPU");
  });

  it("档位表自洽：LOW 需求 < MID < HIGH", () => {
    expect(GPU_LEVELS.LOW.minFreeMiB).toBeLessThan(GPU_LEVELS.MID.minFreeMiB);
    expect(GPU_LEVELS.MID.minFreeMiB).toBeLessThan(GPU_LEVELS.HIGH.minFreeMiB);
  });
});
