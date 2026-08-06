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
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    body,
    json: async () => ({}),
    text: async () => "",
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

    // 等待回答文本逐字累加完成
    const answer = await screen.findByText("你好", {}, { timeout: 2000 });
    expect(answer).toBeTruthy();

    // 引用列表出现
    expect(await screen.findByText("产品手册.pdf")).toBeTruthy();
    // 相关度展示
    expect(screen.getByText(/0\.92/)).toBeTruthy();

    // 无错误
    expect(screen.queryByText(/无法连接后端/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // 发送时已发出 POST 到流式端点
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
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
