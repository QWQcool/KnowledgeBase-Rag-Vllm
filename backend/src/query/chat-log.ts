import fs from "node:fs";
import path from "node:path";

/**
 * chat-log.ts —— 对话日志系统（本地 JSONL，仅存本机，不进 git）
 *
 * 为什么有它：
 * - 前端历史对话（localStorage）是「UI 会话记忆」，换浏览器就丢、服务端不可见；
 * - 后端日志是「可审计/可复盘的记录」：每次问答一行 JSON，含问题、知识库、
 *   检索命中、答案、耗时。用于调试、复盘、面试讲"系统可观测性"。
 *
 * 存储：backend/data/chat-logs/YYYY-MM-DD.jsonl（data/ 已在 .gitignore，
 * 天然不会上传 git）。
 *
 * 设计：
 * - 依赖注入：QueryService 只依赖 ChatLogWriter 接口；测试注入 no-op，
 *   生产注入 FileChatLogWriter（写文件）。
 * - 追加写：一行一条 JSON，崩了也不丢已写内容。
 * - 写入失败静默降级（打印警告，不影响问答主流程）。
 */

export interface ChatLogEntry {
  /** ISO 8601 时间戳 */
  ts: string;
  question: string;
  knowledgeBaseId: string;
  thinking?: boolean;
  /** 检索命中（截断 snippet 防日志膨胀） */
  sources: {
    documentId: string;
    documentName: string;
    chunkIndex: number;
    score: number;
    snippet: string;
  }[];
  /** 模型回答（流式结束时聚合完整文本） */
  answer?: string;
  /** 无检索命中时为 true（走 LLM 通识兜底） */
  fallbackNoHits?: boolean;
  elapsedMs: number;
  error?: string;
}

/** 对话日志写入器接口（测试可注入 no-op） */
export interface ChatLogWriter {
  append(entry: ChatLogEntry): void;
}

/** 不落盘：测试环境默认用，避免测试写脏磁盘 */
export const noopChatLogWriter: ChatLogWriter = {
  append() {},
};

/** 文件 JSONL 写入器：backend/data/chat-logs/YYYY-MM-DD.jsonl */
export class FileChatLogWriter implements ChatLogWriter {
  private readonly dir: string;

  constructor(options?: { dir?: string }) {
    this.dir = options?.dir ?? defaultChatLogDir();
  }

  append(entry: ChatLogEntry): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${entry.ts.slice(0, 10)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      // 日志失败不影响问答主流程（可观测性要低侵入）
      console.warn(`[chat-log] 写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 默认日志目录：与向量库 data 同级（backend/data/chat-logs/） */
function defaultChatLogDir(): string {
  // 复用 TRIVIUM_DATA_DIR 的上级（backend/data/），保持"运行时数据都在 data/ 下"的约定
  return path.resolve(process.cwd(), "data", "chat-logs");
}
