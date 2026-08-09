/* 端到端校验脚本：health → ingest → SSE query → 校验答案与 sources */
const BASE = "http://localhost:3000";

async function main() {
  // 1. health
  const h = await (await fetch(`${BASE}/health`)).json();
  console.log("[1] health:", JSON.stringify(h));

  // 2. ingest 中文测试文档（knowledgeBaseId 统一用 qa）
  const doc = {
    filename: "rag-e2e-check.md",
    knowledgeBaseId: "qa",
    content: [
      "# 向量检索（RAG）原理速查",
      "",
      "向量检索是 RAG（检索增强生成）的核心环节。它先把文档切成文本块，再用嵌入模型把每个块转成向量，存进向量数据库。",
      "查询时，把用户问题也转成向量，然后计算余弦相似度，找出最相近的文本块，作为上下文交给大语言模型生成回答。",
      "",
      "## 关键参数",
      "- topK：返回最相近的文本块数量，默认 5。",
      "- minScore：相似度阈值，低于该阈值的命中会被丢弃，默认 0.30。",
      "- embedding 维度：multilingual-e5-small 输出 384 维向量。",
      "",
      "## 为什么叫检索增强",
      "大模型的知识有截止时间，且无法覆盖私有文档。RAG 通过把外部知识检索出来拼进提示词，让模型基于真实文档作答，减少幻觉。",
    ].join("\n"),
  };

  const ingestResp = await fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  const ingestBody = await ingestResp.text();
  console.log("[2] ingest:", ingestResp.status, ingestBody.slice(0, 400));

  // 3. SSE query
  const q = { question: "什么是向量检索？它和 RAG 有什么关系？", knowledgeBaseId: "qa" };
  const resp = await fetch(`${BASE}/api/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(q),
  });
  console.log("[3] query status:", resp.status, resp.headers.get("content-type"));

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8", { stream: true });
  let buf = "";
  let sources = null, tokens = 0, thinkings = 0, done = null, error = null;
  const tokenTail = [], thinkingTail = [];

  while (true) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += decoder.decode(value, { stream: true });
    // 按 SSE 事件切分（\n\n 分隔）
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let evt;
      try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      if (evt.type === "sources") { sources = evt; console.log("   [event] sources:", JSON.stringify(evt).slice(0, 500)); }
      else if (evt.type === "token") { tokens++; tokenTail.push(evt.delta ?? evt.data ?? evt.content); }
      else if (evt.type === "thinking") { thinkings++; thinkingTail.push(evt.delta ?? evt.data ?? evt.content); }
      else if (evt.type === "done") { done = evt; console.log("   [event] done:", JSON.stringify(evt).slice(0, 300)); }
      else if (evt.type === "error") { error = evt; console.log("   [event] error:", JSON.stringify(evt)); }
      else console.log("   [event] other:", evt.type, JSON.stringify(evt).slice(0, 200));
    }
  }

  console.log("[4] 汇总:");
  console.log("   token 事件数:", tokens, "/ thinking 事件数:", thinkings);
  if (sources) {
    const hits = sources.sources ?? sources.data ?? [];
    console.log("   sources 数:", Array.isArray(hits) ? hits.length : "n/a");
    console.log("   source 摘要:", JSON.stringify(Array.isArray(hits) ? hits.map((x) => ({ id: x.id ?? x.chunkId ?? x.documentId, score: x.score, doc: x.filename ?? x.documentName ?? x.source })) : hits).slice(0, 600));
  }
  console.log("   done 事件:", JSON.stringify(done)?.slice(0, 200));
  console.log("   error 事件:", error ? JSON.stringify(error) : null);
  const answerText = tokenTail.join("");
  console.log("   答案前 600 字:", answerText.slice(0, 600));
  console.log("   答案总字数:", answerText.length);
  if (thinkings > 0) {
    const t = thinkingTail.join("");
    console.log("   thinking 前 300 字:", t.slice(0, 300), "...(共", t.length, "字)");
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
