import { describe, expect, it } from "vitest";
import { createChunkStrategy } from "./chunker";

const HEADING_MD = `# 第一章 概述

这是第一章正文的第一段。
这是第一章正文的第二段。

## 1.1 背景

背景内容说明。

### 1.1.1 子节

子节详细内容。

## 1.2 方法

方法内容。`;

describe("heading 策略", () => {
  it("按 #/##/### 切块，数量与内容归属正确", () => {
    const chunks = createChunkStrategy("heading").chunk(HEADING_MD, { chunkSize: 100 });
    expect(chunks.length).toBe(4);

    // 每个 chunk 归属到最近标题，正文段不错位
    expect(chunks[0].content).toContain("第一章正文的第一段");
    expect(chunks[0].source?.heading).toBe("第一章 概述");

    expect(chunks[1].content).toContain("背景内容说明");
    expect(chunks[1].source?.heading).toBe("1.1 背景");

    expect(chunks[2].content).toContain("子节详细内容");
    expect(chunks[2].source?.heading).toBe("1.1.1 子节");

    expect(chunks[3].content).toContain("方法内容");
    expect(chunks[3].source?.heading).toBe("1.2 方法");
  });

  it("标题前无标题的正文成为独立 chunk，且不带 heading", () => {
    const md = `开头段落没有标题。

# 标题A

正文A。`;
    const chunks = createChunkStrategy("heading").chunk(md);
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toContain("开头段落没有标题");
    expect(chunks[0].source?.heading).toBeUndefined();
    expect(chunks[1].source?.heading).toBe("标题A");
    expect(chunks[1].content).toContain("正文A");
  });

  it("无任何标题时回落到固定长度分块", () => {
    const text = "这是一段没有标题的纯文本内容。".repeat(40);
    const chunks = createChunkStrategy("heading").chunk(text, { chunkSize: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    const strip = (s: string) => s.replace(/\s+/g, "");
    expect(strip(chunks.map((c) => c.content).join(""))).toBe(strip(text));
  });
});

describe("fixed 策略", () => {
  it("按固定长度切块，数量≈ceil(len/size) 且内容不丢", () => {
    const sentence = "这是一个用于测试固定长度分块算法的中文句子，用来验证分块逻辑是否正确。";
    const text = sentence.repeat(20);
    const chunkSize = 500;
    const strip = (s: string) => s.replace(/\s+/g, "");

    const chunks = createChunkStrategy("fixed").chunk(text, { chunkSize });
    const expected = Math.ceil(strip(text).length / chunkSize);

    expect(chunks.length).toBeGreaterThanOrEqual(expected);
    // 内容不丢：拼接还原后与原文一致（忽略空白差异）
    expect(strip(chunks.map((c) => c.content).join(""))).toBe(strip(text));
    // 尽量在句子边界断开 → 每个 chunk 不超过 chunkSize
    expect(Math.max(...chunks.map((c) => c.content.length))).toBeLessThanOrEqual(chunkSize);
  });

  it("缺省 chunkSize 为 500", () => {
    const sentence = "缺省分块大小的验证句子。"; // 12 字符
    const text = sentence.repeat(45); // 540 字符 > 500
    const chunks = createChunkStrategy("fixed").chunk(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].content.length).toBeLessThanOrEqual(500);
  });

  it("可在换行处断开", () => {
    const line = "第N行内容，以换行结尾。\n";
    const text = line.repeat(30); // 行长 < chunkSize
    const chunks = createChunkStrategy("fixed").chunk(text, { chunkSize: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content).toContain("第N行内容");
  });
});
