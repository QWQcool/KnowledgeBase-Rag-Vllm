// logger.ts —— 后端运行时文件日志（2026-08-17 新增）
//
// 背景：后端自重启时使用 stdio:"ignore"，console 输出会丢失；一旦切换/拉起失败，
// 只靠终端日志很难排查。本模块把 console.log/info/warn/error 同时追加到：
//   ${RAG_LOG_DIR:-%TEMP%\rag-engine-logs}\backend.log
// 入口 index.ts 调用 initFileLogging() 后生效。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getBackendLogPath(): string {
  const dir = process.env.RAG_LOG_DIR ?? path.join(os.tmpdir(), "rag-engine-logs");
  return path.join(dir, "backend.log");
}

let initialized = false;

/** 将 console 输出镜像到 backend.log；重复调用幂等 */
export function initFileLogging(): void {
  if (initialized) return;
  initialized = true;

  const logPath = getBackendLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    // 日志目录不可写时不阻塞后端启动
  }

  function write(level: string, args: unknown[]): void {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((a) => (typeof a === "string" ? a : safeStringify(a)))
      .join(" ")}`;
    try {
      fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {
      // 文件写入失败时静默，避免日志自身导致崩溃
    }
  }

  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    write("log", args);
    origLog(...args);
  };
  console.info = (...args: unknown[]) => {
    write("info", args);
    origInfo(...args);
  };
  console.warn = (...args: unknown[]) => {
    write("warn", args);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    write("error", args);
    origError(...args);
  };

  console.log(`[logger] backend log file: ${logPath}`);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
