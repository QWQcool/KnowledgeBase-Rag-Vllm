import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";
import type { StreamingEvent } from "@rag/shared";

/**
 * M3 流式问答页测试。
 *
 * jsdom 本身不实现 fetch 流式读取，这里用 `vi.stubGlobal("fetch", ...)`
 * 返回一个 Response-like 对象，其 body 是符合 `getReader()` 接口的假流：
 * 按 chunks 数组分批 push，模拟后端 SSE 分帧推送。
 */

/** 把若干 StreamingEvent 编码成 SSE 帧字符串：`data: {JSON}\n\n` */
function sse(...events: StreamingEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** 构造假 ReadableStream：按给定字符串数组依次 enqueue，再 close */
function fakeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

/** 构造 fetch 的 mock：返回带 body 的 Response */
function mockFetch(body: ReadableStream<Uint8Array>, status = 200) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    // 启动时的知识库列表请求：返回空列表
    if (typeof url === "string" && url.includes("/api/knowledge-bases")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
        body: null,
        text: async () => "[]",
      });
    }
    // 其余请求（流式问答/上传等）：返回调用方给的 body
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      body,
      json: async () => ({}),
      text: async () => "",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 拼一帧 SSE 字符串再切片成 Uint8Array 的便捷工具 */
function sseChunks(...events: StreamingEvent[]): string[] {
  return [sse(...events)];
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M3 流式问答页", () => {
  it("逐字渲染回答并展示引用来源", async () => {
    const stream = fakeReadableStream(
      sseChunks(
        {
          type: "sources",
          sources: [
            {
              documentId: "d1",
              documentName: "产品手册.pdf",
              snippet: "GLM 是一款大语言模型。",
              chunkIndex: 0,
              score: 0.92,
            },
          ],
        },
        { type: "token", delta: "你" },
        { type: "token", delta: "好" },
        { type: "done", elapsedMs: 42 },
      ),
    );
    const fetchMock = mockFetch(stream);

    render(<App />);

    // 填表
    fireEvent.change(screen.getByPlaceholderText(/向知识库提问/), {
      target: { value: "你好" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    // 等待回答文本逐字累加完成（消息气泡内，排除历史对话标题）
    const answer = await screen.findAllByText("你好", {}, { timeout: 2000 });
    expect(answer.length).toBeGreaterThan(0);

    // 引用列表出现
    expect(await screen.findByText("产品手册.pdf")).toBeTruthy();
    // 相关度展示
    expect(screen.getByText(/0\.92/)).toBeTruthy();

    // 无错误
    expect(screen.queryByText(/无法连接后端/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // 发送时已发出 POST 到流式端点（另有一次启动时的 knowledge-bases 请求）
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const streamCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/query/stream"));
    expect(streamCall).toBeTruthy();
    const [url, init] = streamCall!;
    expect(url).toMatch(/\/api\/query\/stream$/);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.question).toBe("你好");
    expect(body.knowledgeBaseId).toBe("default");
  });

  it("SSE error 事件展示友好文案且不白屏，可重新输入", async () => {
    const stream = fakeReadableStream(
      sseChunks({
        type: "error",
        message: "LLM 服务繁忙，请稍后再试",
      }),
    );
    mockFetch(stream);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/向知识库提问/), {
      target: { value: "测试错误" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    expect(await screen.findByText(/LLM 服务繁忙/)).toBeTruthy();
    // 不白屏：标题仍在、输入框仍在
    expect(screen.getByRole("heading", { name: /RAG/ })).toBeTruthy();
    // 可重新输入发送（按钮恢复可用）
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /发送/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });

  it("空命中：sources 为空 + done.message 显示未找到提示", async () => {
    const stream = fakeReadableStream(
      sseChunks(
        { type: "sources", sources: [] },
        { type: "done", elapsedMs: 10, message: "未在知识库中找到相关内容" },
      ),
    );
    mockFetch(stream);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/向知识库提问/), {
      target: { value: "不存在的问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    expect(await screen.findByText(/未在知识库中找到相关内容/)).toBeTruthy();
    // 引用列表为空：不出现任何来源卡片
    expect(screen.queryByText(/产品手册/)).toBeNull();
  });

  it("网络失败：显示无法连接后端", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/向知识库提问/), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    expect((await screen.findAllByText(/无法连接后端/)).length).toBeGreaterThan(0);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /发送/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });

  it("422 非法请求：显示问题不能为空", async () => {
    // 422 时后端可能不返回流，给一个立即关闭的空流
    const stream = fakeReadableStream([]);
    mockFetch(stream, 422);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/向知识库提问/), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    expect((await screen.findAllByText(/问题不能为空/)).length).toBeGreaterThan(0);
  });

  it("点击引用可展开/收起 snippet", async () => {
    const stream = fakeReadableStream(
      sseChunks(
        {
          type: "sources",
          sources: [
            {
              documentId: "d1",
              documentName: "手册.pdf",
              snippet: "这是原始片段内容",
              score: 0.8,
            },
          ],
        },
        { type: "token", delta: "答" },
        { type: "done", elapsedMs: 1 },
      ),
    );
    mockFetch(stream);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/向知识库提问/), {
      target: { value: "q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    // 等待来源卡片出现
    await screen.findByText("手册.pdf");
    // snippet 默认收起
    expect(screen.queryByText("这是原始片段内容")).toBeNull();

    // 点击展开
    fireEvent.click(screen.getByText("手册.pdf"));
    expect(screen.getByText("这是原始片段内容")).toBeTruthy();

    // 再次点击收起
    fireEvent.click(screen.getByText("手册.pdf"));
    expect(screen.queryByText("这是原始片段内容")).toBeNull();
  });
});

describe("文档上传", () => {
  /** 可感知 knowledge-bases 启动请求的 fetch mock（上传测试用） */
  function mockDispatchFetch(handler: (url: string, init?: RequestInit) => unknown) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/knowledge-bases")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
          body: null,
          text: async () => "[]",
        });
      }
      return Promise.resolve(handler(url, init));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("选择 .md 文件 → POST /api/ingest → 展示分块数", async () => {
    const fetchMock = mockDispatchFetch(() => ({
      ok: true,
      status: 201,
      json: async () => ({
        document: { title: "测试指南", filename: "guide.md" },
        chunkCount: 3,
        chunks: [],
      }),
    }));

    render(<App />);
    const input = screen.getByLabelText("选择文档上传");
    const file = new File(["# 测试\n内容"], "guide.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/已入库/)).toBeTruthy();
    expect(screen.getByText(/3 个分块/)).toBeTruthy();
    // 请求体带 filename/content/knowledgeBaseId（跳过启动时的 knowledge-bases 调用）
    const ingestCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/ingest"));
    expect(ingestCall).toBeTruthy();
    const [url, init] = ingestCall!;
    expect(url).toMatch(/\/api\/ingest$/);
    const body = JSON.parse(init?.body as string);
    expect(body.filename).toBe("guide.md");
    expect(body.knowledgeBaseId).toBe("default");
    expect(typeof body.content).toBe("string");
  });

  it("不支持的文件类型（.exe）提示且不发请求", async () => {
    const fetchMock = mockDispatchFetch(() => {
      throw new Error("不应调用");
    });

    render(<App />);
    const input = screen.getByLabelText("选择文档上传");
    const file = new File(["x"], "run.exe", { type: "application/octet-stream" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/不支持 .exe/)).toBeTruthy();
    const ingestCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/ingest"));
    expect(ingestCalls).toHaveLength(0);
  });

  it("上传失败（500）展示错误信息", async () => {
    const fetchMock = mockDispatchFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "服务器内部错误" }),
    }));

    render(<App />);
    const input = screen.getByLabelText("选择文档上传");
    const file = new File(["data"], "doc.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/上传失败 \(500\)/)).toBeTruthy();
  });
});

describe("对话日志面板", () => {
  it("点击「对话日志」→ GET /api/chat-logs → 渲染日志条目", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/knowledge-bases")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [], body: null });
      }
      if (String(url).includes("/api/chat-logs")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            total: 1,
            entries: [
              {
                ts: "2026-08-10T00:00:00.000Z",
                question: "什么是RAG？",
                knowledgeBaseId: "default",
                sources: [{ documentId: "d1", documentName: "手册.md", score: 0.92 }],
                answer: "RAG 是检索增强生成…",
                fallbackNoHits: false,
                elapsedMs: 1234,
              },
            ],
          }),
          body: null,
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), body: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /对话日志/ }));

    expect(await screen.findByText("什么是RAG？")).toBeTruthy();
    expect(screen.getByText(/手册\.md/)).toBeTruthy();
    expect(screen.getByText(/1234ms/)).toBeTruthy();
  });
});

describe("多知识库下拉", () => {
  it("启动加载知识库列表 → 下拉可选已知库与自定义", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/knowledge-bases")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ id: "default", name: "default", documentIds: [] }],
          body: null,
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), body: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    // 等待下拉出现（选项 default + 自定义）
    const select = await screen.findByRole("combobox");
    expect(select).toBeTruthy();
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("default");
    expect(options).toContain("自定义…");
  });
});

/** 推理引擎切换（GET/PUT /api/llm-engine） */
describe("推理引擎切换", () => {
  const llmEngineStatus = {
    engine: "ollama",
    engines: {
      ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", apiKey: "ollama" },
      vllm: { baseUrl: "http://127.0.0.1:8000/v1", model: "qwen3-8b-awq", apiKey: "EMPTY" },
    },
    configPath: "llm-config.json",
    requiresRestart: true,
  };

  function mockEngineFetch(putImpl?: (url: string, init?: RequestInit) => Promise<unknown>) {
    const engineServices = {
      ollama: { engine: "ollama", state: "running", pid: null },
      vllm: { engine: "vllm", state: "running", pid: null },
    };
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/knowledge-bases")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [], body: null });
      }
      if (typeof url === "string" && url.includes("/api/engine-services")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => engineServices, body: null });
      }
      if (typeof url === "string" && url.includes("/api/llm-engine") && init?.method === "PUT") {
        return Promise.resolve(putImpl ? putImpl(url, init) : { ok: true, status: 200, json: async () => ({ ...llmEngineStatus, engine: "vllm" }) });
      }
      if (typeof url === "string" && url.includes("/api/llm-engine")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => llmEngineStatus, body: null });
      }
      if (typeof url === "string" && url.includes("/api/model")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: "qwen3:8b", meta: { n_params: 8_000_000_000, n_ctx: 4096 } }),
          body: null,
        });
      }
      if (typeof url === "string" && url.includes("/api/gpu")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ supported: true, totalMiB: 16380, usedMiB: 2000, freeMiB: 14380, currentLevel: "HIGH", currentLabel: "HIGH", suggestedLevel: "HIGH", suggestedLabel: "HIGH", safe: true, advice: "", levels: [] }),
          body: null,
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), body: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("打开模型信息弹窗 → 加载并展示当前引擎（Ollama）", async () => {
    mockEngineFetch();
    render(<App />);

    // 打开模型信息弹窗：点击模型名（弹窗标题「模型信息」）
    fireEvent.click(screen.getByRole("button", { name: /模型信息/ }));
    // 引擎区块出现并显示当前引擎
    const engineText = await screen.findByText(/推理引擎：Ollama/);
    expect(engineText).toBeTruthy();
    expect(screen.getByText(/qwen3:8b @ http:\/\/127\.0\.0\.1:11434/)).toBeTruthy();
    // 两个切换按钮（当前引擎禁用）
    expect(screen.getByText("vLLM")).toBeTruthy();
  });

  it("切换到 vLLM → PUT 请求体 {engine:vllm} → 展示重启提示", async () => {
    const fetchMock = mockEngineFetch();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /模型信息/ }));
    await screen.findByText(/推理引擎：Ollama/);

    fireEvent.click(screen.getByText("vLLM"));
    // 断言 PUT 请求体
    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        ([url, init]) => typeof init === "object" && init?.method === "PUT" && String(url ?? "").includes("/api/llm-engine"),
      );
      expect(putCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(String(putCalls[0][1]?.body ?? "{}"));
      expect(body.engine).toBe("vllm");
    });
    // 成功提示（后端自动重启 + 前端轮询恢复后的最终态）
    expect(await screen.findByText(/后端已重启，vLLM 引擎生效/)).toBeTruthy();
  });

  it("切换失败（500）→ 展示错误信息", async () => {
    mockEngineFetch(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: "写入 llm-config.json 失败，请检查文件是否只读/被占用" }),
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /模型信息/ }));
    await screen.findByText(/推理引擎：Ollama/);

    fireEvent.click(screen.getByText("vLLM"));
    expect(await screen.findByText(/写入 llm-config\.json 失败/)).toBeTruthy();
  });
});
