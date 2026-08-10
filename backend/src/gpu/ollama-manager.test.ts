import { describe, expect, it, vi } from "vitest";
import {
  SpawnOllamaManager,
  createMockOllamaManager,
  parseOllamaPid,
  parseOllamaPsSize,
  waitOllamaReady,
} from "./ollama-manager";

describe("parseOllamaPid（netstat 输出解析）", () => {
  it("从 LISTENING 行解析 PID", () => {
    const out = `  TCP    127.0.0.1:11434     0.0.0.0:0    LISTENING    131508`;
    expect(parseOllamaPid(out)).toBe(131508);
  });
  it("多行混合时取 11434 监听行", () => {
    const out = `  TCP    0.0.0.0:3000     0.0.0.0:0    LISTENING    136324
  TCP    127.0.0.1:11434     0.0.0.0:0    LISTENING    138488`;
    expect(parseOllamaPid(out)).toBe(138488);
  });
  it("无监听 → null", () => {
    expect(parseOllamaPid("  TCP    0.0.0.0:3000     0.0.0.0:0    LISTENING    1\n")).toBeNull();
  });
});

describe("waitOllamaReady（端口就绪轮询）", () => {
  it("fetch 返回 200 → true", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true } as Response));
    expect(await waitOllamaReady(11434, 5000, fetchMock as typeof fetch)).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
  it("一直失败 → false（不无限等）", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect refused");
    });
    expect(await waitOllamaReady(11434, 1000, fetchMock as typeof fetch)).toBe(false);
  });
});

describe("SpawnOllamaManager.findPid", () => {
  it("注入 netstatImpl 解析 PID", async () => {
    const m = new SpawnOllamaManager();
    const pid = await m.findPid(
      async () => `  TCP    127.0.0.1:11434     0.0.0.0:0    LISTENING    99887`,
    );
    expect(pid).toBe(99887);
  });
  it("netstat 抛错 → null（不崩）", async () => {
    const m = new SpawnOllamaManager();
    const pid = await m.findPid(async () => {
      throw new Error("boom");
    });
    expect(pid).toBeNull();
  });
});

describe("createMockOllamaManager（测试注入）", () => {
  it("默认返回 ok", async () => {
    const res = await createMockOllamaManager().restart("MID");
    expect(res.ok).toBe(true);
  });
  it("可覆盖行为", async () => {
    const m = createMockOllamaManager({
      restart: async () => ({ ok: false, message: "显存不足" }),
    });
    const res = await m.restart("HIGH");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("显存不足");
  });
});

describe("parseOllamaPsSize（ollama ps SIZE 解析）", () => {
  it("解析 GB/MB 混合行并求和", () => {
    const out = `NAME        ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen3:8b    500a1f067a9f    5.1 GB    100% GPU     1024       4 minutes from now
qwen2:7b    abc             512 MB    100% GPU     2048       5 minutes from now`;
    expect(parseOllamaPsSize(out)).toBe(Math.round(5.1 * 1024 + 512));
  });
  it("无模型 → 0", () => {
    expect(parseOllamaPsSize("NAME    ID    SIZE    PROCESSOR    CONTEXT    UNTIL\n")).toBe(0);
  });
});

describe("SpawnOllamaManager.estimateOllamaVramMiB", () => {
  it("注入 psImpl 解析模型占用", async () => {
    const m = new SpawnOllamaManager();
    const miB = await m.estimateOllamaVramMiB(
      async () => `NAME        ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen3:8b    500a1f067a9f    4.7 GB    100% GPU     1024       4 minutes from now`,
    );
    expect(miB).toBe(Math.round(4.7 * 1024));
  });
  it("ps 抛错 → 0（不崩）", async () => {
    const m = new SpawnOllamaManager();
    const miB = await m.estimateOllamaVramMiB(async () => {
      throw new Error("boom");
    });
    expect(miB).toBe(0);
  });
});
