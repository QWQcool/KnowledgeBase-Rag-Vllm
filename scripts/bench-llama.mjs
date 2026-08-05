#!/usr/bin/env node
/**
 * bench-llama.mjs —— llama-server 性能基准（M4）
 *
 * 测量：
 *   1. 首 token 延迟（TTFT）：从发请求到收到第一个 delta 的时间
 *   2. 生成速度（tok/s）：总生成 token 数 / 总耗时
 *   3. llama-server 进程内存占用（RSS，MB）—— Windows 下用 tasklist 反查
 *
 * 用法：
 *   node bench-llama.mjs [baseUrl] [model]
 *   默认 http://localhost:8080/v1  qwen2.5-7b-instruct
 *
 * 输出 bench-result.md（同目录），同时打印到 stdout。
 * 设计：与前端 SSE 消费同一套模式（fetch + ReadableStream reader + TextDecoder），
 *      计时精准、跨平台、无 PS5.1 编码/流处理坑。
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const baseUrl = (process.argv[2] ?? "http://localhost:8080/v1")
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "");
const model = process.argv[3] ?? "qwen2.5-7b-instruct";

const prompt = "用三句话解释什么是检索增强生成（RAG）。";

function fmtMs(ms) {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

async function bench() {
  console.log(`\n=== llama-server 性能基准 ===`);
  console.log(`endpoint: ${baseUrl}/v1/chat/completions`);
  console.log(`model:    ${model}`);
  console.log(`prompt:   ${prompt}\n`);

  const url = `${baseUrl}/v1/chat/completions`;
  const t0 = performance.now();

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`请求失败 ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let firstTokenAt = null;
  let tokenCount = 0;
  let fullText = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") continue;
      if (payload === "") continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          tokenCount++;
          fullText += delta;
        }
      } catch {
        /* 心跳行 */
      }
    }
  }

  const tEnd = performance.now();
  const totalMs = tEnd - t0;
  const ttftMs = firstTokenAt ? firstTokenAt - t0 : null;
  // 估算 token：流式每个 delta 事件约 1 token（llama-server 按 token 切片）
  const genMs = firstTokenAt ? tEnd - firstTokenAt : totalMs;
  const tokPerSec = genMs > 0 ? (tokenCount / genMs) * 1000 : 0;

  // 进程内存（Windows tasklist 反查 llama-server.exe）
  let memMb = "N/A";
  try {
    const out = execSync(
      'tasklist /fi "imagename eq llama-server.exe" /fo csv /nh',
      { encoding: "utf8" },
    ).trim();
    if (out) {
      // csv: "llama-server.exe","<PID>","Console","<N> K"
      const m = out.match(/"(\d+) K"/);
      if (m) memMb = (Number(m[1]) / 1024).toFixed(0) + " MB";
    }
  } catch {
    /* 非 Windows 或进程未跑 */
  }

  const result = {
    endpoint: `${baseUrl}/v1/chat/completions`,
    model,
    prompt,
    firstTokenLatency: ttftMs != null ? fmtMs(ttftMs) : "N/A",
    totalTime: fmtMs(totalMs),
    generatedTokens: tokenCount,
    tokPerSec: tokPerSec.toFixed(1),
    processMemory: memMb,
    sample: fullText.slice(0, 120),
  };

  const lines = [
    `# llama-server 性能基准结果`,
    ``,
    `- 时间：${new Date().toISOString()}`,
    `- endpoint：\`${result.endpoint}\``,
    `- model：\`${result.model}\``,
    `- prompt：${prompt}`,
    ``,
    `| 指标 | 数值 |`,
    `|---|---|`,
    `| 首 token 延迟 (TTFT) | ${result.firstTokenLatency} |`,
    `| 总耗时 | ${result.totalTime} |`,
    `| 生成 token 数 | ${result.generatedTokens} |`,
    `| 生成速度 | ${result.tokPerSec} tok/s |`,
    `| llama-server 进程内存 | ${result.processMemory} |`,
    ``,
    `**回答样本**：`,
    `> ${result.sample}…`,
  ].join("\n");

  const outPath = resolve(__dirname, "bench-result.md");
  writeFileSync(outPath, lines, "utf8");

  console.log(lines);
  console.log(`\n结果已写入 ${outPath}`);
}

bench().catch((err) => {
  console.error("基准失败：", err.message);
  console.error("确认 llama-server 已起来（默认 http://localhost:8080）且模型加载完成。");
  process.exit(1);
});
