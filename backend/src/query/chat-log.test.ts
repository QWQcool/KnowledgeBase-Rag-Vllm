import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileChatLogWriter, noopChatLogWriter, readChatLogs, type ChatLogEntry } from "./chat-log";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("FileChatLogWriter", () => {
  it("append 写入 JSONL：一行一条，含全部关键字段", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "chatlog-test-"));
    const writer = new FileChatLogWriter({ dir: tmpDir });

    const entry: ChatLogEntry = {
      ts: "2026-08-10T00:40:00.000Z",
      question: "什么是 RAG？",
      knowledgeBaseId: "qa",
      thinking: true,
      sources: [
        {
          documentId: "doc-1",
          documentName: "01-手册.md",
          chunkIndex: 0,
          score: 0.92,
          snippet: "检索增强生成…",
        },
      ],
      answer: "RAG 是检索增强生成…",
      fallbackNoHits: false,
      elapsedMs: 1234,
    };
    writer.append(entry);

    const content = await readFile(path.join(tmpDir, "2026-08-10.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as ChatLogEntry;
    expect(parsed.question).toBe("什么是 RAG？");
    expect(parsed.sources[0].score).toBeCloseTo(0.92);
    expect(parsed.answer).toContain("RAG");
    expect(parsed.elapsedMs).toBe(1234);
  });

  it("按日期分文件：两次跨天写入落在不同文件", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "chatlog-test-"));
    const writer = new FileChatLogWriter({ dir: tmpDir });

    writer.append({ ...baseEntry, ts: "2026-08-09T23:59:00.000Z" });
    writer.append({ ...baseEntry, ts: "2026-08-10T00:00:00.000Z" });

    const d1 = await readFile(path.join(tmpDir, "2026-08-09.jsonl"), "utf8");
    const d2 = await readFile(path.join(tmpDir, "2026-08-10.jsonl"), "utf8");
    expect(d1.trim().split("\n")).toHaveLength(1);
    expect(d2.trim().split("\n")).toHaveLength(1);
  });

  it("追加不覆盖：同一天多次 append 累积多行", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "chatlog-test-"));
    const writer = new FileChatLogWriter({ dir: tmpDir });

    writer.append({ ...baseEntry, ts: "2026-08-10T00:00:00.000Z", question: "Q1" });
    writer.append({ ...baseEntry, ts: "2026-08-10T00:01:00.000Z", question: "Q2" });

    const content = await readFile(path.join(tmpDir, "2026-08-10.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).question).toBe("Q1");
    expect(JSON.parse(lines[1]).question).toBe("Q2");
  });

  it("noopChatLogWriter 不抛错", () => {
    expect(() => noopChatLogWriter.append(baseEntry)).not.toThrow();
  });

  it("readChatLogs：倒序返回、按日期过滤、limit 截断", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "chatlog-test-"));
    const writer = new FileChatLogWriter({ dir: tmpDir });

    writer.append({ ...baseEntry, ts: "2026-08-09T23:00:00.000Z", question: "Q-day1" });
    writer.append({ ...baseEntry, ts: "2026-08-10T00:00:00.000Z", question: "Q-early" });
    writer.append({ ...baseEntry, ts: "2026-08-10T01:00:00.000Z", question: "Q-late" });

    // 全部：倒序（最新在前）
    const all = readChatLogs(tmpDir);
    expect(all.map((e) => e.question)).toEqual(["Q-late", "Q-early", "Q-day1"]);

    // 按日期过滤
    const d10 = readChatLogs(tmpDir, { date: "2026-08-10" });
    expect(d10.map((e) => e.question)).toEqual(["Q-late", "Q-early"]);

    // limit 截断
    const limited = readChatLogs(tmpDir, { limit: 2 });
    expect(limited.map((e) => e.question)).toEqual(["Q-late", "Q-early"]);

    // 目录不存在 → 空数组不抛错
    expect(readChatLogs(path.join(tmpDir, "nope"))).toEqual([]);
  });
});

const baseEntry: ChatLogEntry = {
  ts: "2026-08-10T00:00:00.000Z",
  question: "测试问题",
  knowledgeBaseId: "qa",
  sources: [],
  elapsedMs: 100,
};
