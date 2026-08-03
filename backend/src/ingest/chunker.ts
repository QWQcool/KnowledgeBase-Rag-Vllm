import type { ChunkStrategyType } from "@rag/shared";

/**
 * chunker.ts —— 分块策略（Strategy 模式）。
 *
 * 两种可配置策略，统一走 ChunkStrategy 接口：
 *   - heading：按 Markdown 标题（#/##/###）切块，无标题时回落到 fixed；
 *   - fixed：按固定长度切（chunkSize 默认 500），尽量在句子边界/换行处断开。
 *
 * 输出 RawChunk[]（content + 来源元数据），由 ingest-service 组装成
 * 契约 DocumentChunk[]（补 id / documentId / index）。
 */

export interface ChunkOptions {
  /** fixed 策略的固定长度（默认 500） */
  chunkSize?: number;
}

/** chunk 来源元数据（对应契约 DocumentChunk.source，仅填有值的字段） */
export interface ChunkSource {
  heading?: string;
  page?: number;
}

export interface RawChunk {
  content: string;
  source?: ChunkSource;
}

export interface ChunkStrategy {
  readonly type: ChunkStrategyType;
  chunk(text: string, options?: ChunkOptions): RawChunk[];
}

/* ===================== heading 策略 ===================== */

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;

function chunkByHeading(text: string, options?: ChunkOptions): RawChunk[] {
  const lines = text.split(/\r?\n/);
  const raw: RawChunk[] = [];
  let heading: string | undefined;
  let headingSeen = false;
  let current: string[] = [];

  const flush = () => {
    const content = current.join("\n").trim();
    if (content) {
      raw.push(
        heading ? { content, source: { heading } } : { content },
      );
    }
    current = [];
  };

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flush();
      headingSeen = true;
      heading = match[2];
    }
    current.push(line);
  }
  flush();

  // 无任何标题：回落到固定长度分块（01 手册：可配置策略的兜底）
  if (!headingSeen) {
    return chunkFixed(text, options);
  }
  return raw;
}

/* ===================== fixed 策略 ===================== */

const DEFAULT_CHUNK_SIZE = 500;
/** 句子/换行边界字符（中文标点优先，含英文标点与换行） */
const BOUNDARY_CHARS = new Set(["\n", "\r", "。", "！", "？", ".", "!", "?"]);

function chunkFixed(text: string, options?: ChunkOptions): RawChunk[] {
  const size = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const raw: RawChunk[] = [];
  const len = text.length;
  // 达到 chunkSize 后，最多往回扫这么多字符找边界
  const lookback = Math.min(size, 200);

  let start = 0;
  while (start < len) {
    let end = Math.min(start + size, len);
    if (end < len) {
      // 尽量在句子边界/换行处断开，找不到才硬切
      const windowStart = Math.max(start, end - lookback);
      for (let i = end - 1; i >= windowStart; i--) {
        if (BOUNDARY_CHARS.has(text[i])) {
          end = i + 1;
          break;
        }
      }
    }
    const piece = text.slice(start, end).trim();
    if (piece) raw.push({ content: piece });
    start = end;
  }
  return raw;
}

/* ===================== 策略注册表 ===================== */

const strategies: Record<ChunkStrategyType, ChunkStrategy> = {
  heading: { type: "heading", chunk: chunkByHeading },
  fixed: { type: "fixed", chunk: chunkFixed },
};

/** 按策略类型取实现（Strategy 模式入口） */
export function createChunkStrategy(type: ChunkStrategyType): ChunkStrategy {
  return strategies[type];
}
