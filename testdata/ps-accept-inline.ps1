# M2 E2E 验收 · 逐行命令版（PowerShell 5.1 直接粘贴执行）
# 后端已启动（RAG_EMBEDDING=transformers LLM_PROVIDER=mock PORT=3105）

# ==== 步骤 1：ingest（内联 content，避免文件读取差异）====
$body1 = @{
  filename        = "rag-guide.md"
  chunkStrategy   = "heading"
  knowledgeBaseId = "kb-accept"
  content         = "# RAG 是什么`n`nRAG 是检索增强生成（Retrieval-Augmented Generation），它先从知识库检索相关片段，再让大模型基于片段生成回答。`n`n# 为什么用向量检索`n`n文档被切成块后转成向量，用户的问题也转成向量，用向量相似度找到语义上最相关的块。`n`n# chunk 策略`n`n按标题分块保留语义结构；固定长度分块适合无结构的纯文本，可通过 chunkSize 配置粒度。`n`n# 检索质量`n`n检索时通过 minScore 阈值过滤低相关命中，避免无关问题也返回内容，防止模型编造答案。"
} | ConvertTo-Json
try {
  $r1 = Invoke-RestMethod -Method Post -Uri "http://localhost:3105/api/ingest" -ContentType "application/json" -Body $body1
  Write-Host ("[1] PASS ingest chunkCount = " + $r1.chunkCount) -ForegroundColor Green
} catch {
  $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  Write-Host ("[1] FAIL " + $sr.ReadToEnd()) -ForegroundColor Red
}

# ==== 步骤 2：相关问题 ====
$q1 = @{ question = "RAG 是怎么工作的？"; knowledgeBaseId = "kb-accept" } | ConvertTo-Json
$r2 = Invoke-RestMethod -Method Post -Uri "http://localhost:3105/api/query" -ContentType "application/json" -Body $q1
Write-Host ("[2] sources = " + $r2.sources.Count + " | answer 含原文: " + ($r2.answer -match "检索增强生成")) -ForegroundColor Cyan

# ==== 步骤 3：无关问题 ====
$q2 = @{ question = "今天天气如何？"; knowledgeBaseId = "kb-accept" } | ConvertTo-Json
$r3 = Invoke-RestMethod -Method Post -Uri "http://localhost:3105/api/query" -ContentType "application/json" -Body $q2
Write-Host ("[3] sources = " + $r3.sources.Count + " | 提示未找到: " + ($r3.answer -match "未找到")) -ForegroundColor Cyan

# ==== 步骤 4：非法请求 ====
$bad = @{ question = "" } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri "http://localhost:3105/api/query" -ContentType "application/json" -Body $bad
  Write-Host "[4] FAIL 非法请求竟然成功" -ForegroundColor Red
} catch {
  Write-Host ("[4] PASS 非法请求被拦 HTTP " + [int]$_.Exception.Response.StatusCode) -ForegroundColor Green
}
