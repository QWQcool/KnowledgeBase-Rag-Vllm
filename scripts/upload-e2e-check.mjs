/* 前端上传链路端到端验证：PDF(latin1) + md → ingest → 检索命中 */
// 构造最小合法 PDF（与后端 parser.test.ts 的 buildMinimalPdf 完全同构）
function buildMinimalPdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    null, // 0 号对象占位
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

(async () => {
  const BASE = "http://localhost:5173"; // 走 vite 代理模拟前端
  const kb = "upload-e2e";
  // 1. PDF：latin1 编码（与前端 TextDecoder('latin1') 一致）
  // 注意：PDF content stream 内的文本须为 ASCII（中文需嵌入字体，手工构造不现实；
  // 真实中文 PDF 由 pdf-parse 正常处理，后端 parser.test.ts 已覆盖 PDF 提取用例）
  const pdfBytes = buildMinimalPdf("Metro ATO automatic train operation improves punctuality");
  const content = pdfBytes.toString("latin1");
  const r1 = await fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "信号系统说明.pdf", content, knowledgeBaseId: kb }),
  });
  const j1 = await r1.json();
  console.log("[PDF ingest]", r1.status, "| title:", j1.document?.title, "| chunks:", j1.chunks?.length);
  // 2. md 文件
  const r2 = await fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: "地铁运营手册.md",
      knowledgeBaseId: kb,
      content: "# 地铁运营\n\n地铁列车通过ATO系统实现自动驾驶，准点率提升到99%。",
    }),
  });
  const j2 = await r2.json();
  console.log("[MD ingest]", r2.status, "| title:", j2.document?.title, "| chunks:", j2.chunks?.length);
  // 3. 检索验证 PDF 内容可命中
  const r3 = await fetch(`${BASE}/api/retrieve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "ATO 自动驾驶 准点率", knowledgeBaseId: kb, topK: 5, minScore: 0.6 }),
  });
  const j3 = await r3.json();
  console.log("[检索] hits:", (j3.hits || []).length);
  for (const h of j3.hits || []) {
    console.log("   score:", h.score.toFixed(4), "|", (h.chunk?.content || "").replace(/\n/g, " ").slice(0, 40));
  }
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
