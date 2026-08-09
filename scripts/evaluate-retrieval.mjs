/**
 * evaluate-retrieval.mjs —— 检索质量评估脚本（面试数字可复现）
 *
 * 用法：
 *   node scripts/evaluate-retrieval.mjs                # 用默认测试集跑
 *   node scripts/evaluate-retrieval.mjs --min-score 0.85   # 覆盖阈值对比
 *   node scripts/evaluate-retrieval.mjs --kb qa        # 换知识库
 *
 * 指标：
 *   - 相关问句召回率：expectHit=true 的用例，标准答案是否出现在 top-k 检索结果里
 *   - 无关问句误报率：expectHit=false 的用例，是否错误命中了知识库
 *   - 分数分布：相关/无关问句的相似度均值与范围（验证 minScore 分界合理性）
 *
 * 输出直接可用于面试：「在 5 个测试问题上，相关召回率 X%，无关误报率 Y%，
 * 相关平均分 0.87 / 无关平均分 0.79，阈值 0.80 分界清晰。」
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_FILE = path.join(__dirname, "retrieval-eval-cases.json");

// 解析命令行参数（--min-score 0.85 / --kb qa / --top-k 5 / --endpoint http://localhost:3000）
function parseArgs(argv) {
  const out = { minScore: undefined, kb: undefined, topK: undefined, endpoint: "http://localhost:3000" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--min-score") out.minScore = Number(argv[++i]);
    else if (a === "--kb") out.kb = argv[++i];
    else if (a === "--top-k") out.topK = Number(argv[++i]);
    else if (a === "--endpoint") out.endpoint = argv[++i].replace(/\/+$/, "");
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = JSON.parse(await readFile(CASES_FILE, "utf8"));

  const kb = args.kb ?? raw.knowledgeBaseId;
  const topK = args.topK ?? raw.topK;
  const minScore = args.minScore ?? raw.minScore;
  const endpoint = args.endpoint;

  console.log("══════════════════════════════════════════════");
  console.log("  RAG 检索质量评估");
  console.log(`  知识库: ${kb} | topK: ${topK} | minScore: ${minScore}`);
  console.log(`  端点: ${endpoint}/api/retrieve`);
  console.log("══════════════════════════════════════════════");

  const related = raw.cases.filter((c) => c.expectHit);
  const unrelated = raw.cases.filter((c) => !c.expectHit);

  let relatedHit = 0;
  let unrelatedFalsePositive = 0;
  const relatedScores = [];
  const unrelatedScores = [];

  for (const c of raw.cases) {
    const resp = await fetch(`${endpoint}/api/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: c.question, knowledgeBaseId: kb, topK, minScore }),
    });
    if (!resp.ok) {
      console.log(`  ✗ [请求失败 ${resp.status}] ${c.question.slice(0, 30)}`);
      continue;
    }
    const { hits } = await resp.json();
    const scores = (hits ?? []).map((h) => h.score);
    const texts = (hits ?? []).map((h) => h.chunk?.content ?? "");

    // 命中判定：expectHit=true 需期望关键词出现；expectHit=false 需无命中（或命中但关键词不匹配）
    const hasKeyword = c.expectKeywords.some((kw) => texts.some((t) => t.includes(kw)));
    const isHit = c.expectHit ? hasKeyword : !hasKeyword;

    if (c.expectHit) {
      relatedScores.push(...scores);
      if (isHit) relatedHit++;
      console.log(`  ${isHit ? "✓" : "✗"} [相关] ${c.question.slice(0, 34)}`);
      console.log(`       命中分数: ${scores.map((s) => s.toFixed(3)).join(", ") || "无"}`);
    } else {
      unrelatedScores.push(...scores);
      if (isHit) unrelatedFalsePositive++;
      console.log(`  ${isHit ? "✓" : "✗"} [无关] ${c.question.slice(0, 34)}`);
      console.log(`       命中分数: ${scores.map((s) => s.toFixed(3)).join(", ") || "无"}`);
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const rRecall = related.length ? (relatedHit / related.length) * 100 : 0;
  const uFP = unrelated.length ? (unrelatedFalsePositive / unrelated.length) * 100 : 0;

  console.log("──────────────────────────────────────────────");
  console.log("  结果汇总");
  console.log(`  相关问句召回率: ${relatedHit}/${related.length} = ${rRecall.toFixed(0)}%`);
  console.log(`  无关问句误报率: ${unrelatedFalsePositive}/${unrelated.length} = ${uFP.toFixed(0)}%`);
  if (relatedScores.length) {
    console.log(`  相关命中平均分: ${avg(relatedScores).toFixed(3)}（范围 ${Math.min(...relatedScores).toFixed(3)}~${Math.max(...relatedScores).toFixed(3)}）`);
  }
  if (unrelatedScores.length) {
    console.log(`  无关命中平均分: ${avg(unrelatedScores).toFixed(3)}（范围 ${Math.min(...unrelatedScores).toFixed(3)}~${Math.max(...unrelatedScores).toFixed(3)}）`);
  }
  console.log("══════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
