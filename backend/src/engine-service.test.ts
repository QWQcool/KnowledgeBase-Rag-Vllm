// engine-service.test.ts —— 引擎服务管理器（DefaultEngineServiceManager）单元测试
//
// 隔离方案：注入 mock prober + allowSpawn=false，绝不真启动 vLLM/Ollama 进程。
// 覆盖：状态判定（running/stopped）、启动流程（就绪/禁 spawn 报错）、停止流程。

import { describe, expect, it, vi } from "vitest";
import {
  DefaultEngineServiceManager,
  type ServiceProber,
} from "./engine-service";

/** 构造一个受控的 manager：probe 结果由外部数组驱动 */
function makeManager(probeResults: boolean[]) {
  let call = 0;
  const prober: ServiceProber = {
    probe: vi.fn(async () => {
      const r = probeResults[Math.min(call, probeResults.length - 1)] ?? false;
      call += 1;
      return r;
    }),
  };
  const manager = new DefaultEngineServiceManager({
    engines: {
      ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" },
      vllm: { baseUrl: "http://127.0.0.1:8000/v1", model: "qwen3-8b-awq" },
    },
    prober,
    allowSpawn: false, // 测试绝不允许真实 spawn
  });
  return { manager, prober };
}

describe("DefaultEngineServiceManager.getStatus", () => {
  it("健康端点可达 → running", async () => {
    const { manager } = makeManager([true]);
    const s = await manager.getStatus("ollama");
    expect(s.state).toBe("running");
  });

  it("健康端点不可达 → stopped", async () => {
    const { manager } = makeManager([false]);
    const s = await manager.getStatus("vllm");
    expect(s.state).toBe("stopped");
  });
});

describe("DefaultEngineServiceManager.start", () => {
  it("服务已在运行 → 直接返回 running（不重复启动）", async () => {
    const { manager, prober } = makeManager([true]);
    const s = await manager.start("ollama");
    expect(s.state).toBe("running");
    expect(prober.probe).toHaveBeenCalledTimes(1); // 只探测一次，未进入轮询
  });

  it("服务未运行 + 禁 spawn（测试环境）→ error 且不轮询", async () => {
    const { manager, prober } = makeManager([false]);
    const s = await manager.start("vllm");
    expect(s.state).toBe("error");
    expect(s.message).toContain("测试环境");
    expect(prober.probe).toHaveBeenCalledTimes(1);
  });
});

describe("DefaultEngineServiceManager.stop", () => {
  it("无 spawn 子进程 + 探测仍可达 → running（端口级判定）", async () => {
    const { manager, prober } = makeManager([true]); // 停止后探测仍健康（如其他进程占用端口）
    const s = await manager.stop("ollama");
    expect(s.state).toBe("running");
    expect(prober.probe).toHaveBeenCalledTimes(1); // stop 只做一次端口探测
  });

  it("无 spawn 子进程 + 探测不可达 → stopped", async () => {
    const { manager } = makeManager([false]);
    const s = await manager.stop("ollama");
    expect(s.state).toBe("stopped");
  });
});
