# M2 E2E 验收脚本（PowerShell 5.1 兼容，UTF-8 BOM）
# 前置：后端已启动（RAG_EMBEDDING=transformers LLM_PROVIDER=mock PORT=3105）
# 运行：powershell -ExecutionPolicy Bypass -File ps-accept-guide.ps1

# 控制台切 UTF-8，避免中文显示乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ErrorActionPreference = "Stop"
$base = "http://localhost:3105"
$kb   = "kb-accept"

# 测试文档内容（here-string，与 rag-guide.md 一致；避免文件编码/读取差异）
$docContent = @"
# RAG 是什么

RAG 是检索增强生成（Retrieval-Augmented Generation），它先从知识库检索相关片段，再让大模型基于片段生成回答。

# 为什么用向量检索

文档被切成块后转成向量，用户的问题也转成向量，用向量相似度找到语义上最相关的块。

# chunk 策略

按标题分块保留语义结构；固定长度分块适合无结构的纯文本，可通过 chunkSize 配置粒度。

# 检索质量

检索时通过 minScore 阈值过滤低相关命中，避免无关问题也返回内容，防止模型编造答案。
"@

function Invoke-JsonPost($uri, $obj) {
  $json = $obj | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json" -Body $json
    return @{ ok = $true; data = $resp }
  } catch {
    # 尝试解析响应体里的 issues（422 时后端返回 { error, issues }）
    $body = ""
    try {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $body = $reader.ReadToEnd()
    } catch {}
    return @{ ok = $false; http = [int]$_.Exception.Response.StatusCode; body = $body }
  }
}

Write-Host ""
Write-Host "===== 1) POST /api/ingest (上传 MD, heading 分块) ====="
$ingestResult = Invoke-JsonPost "$base/api/ingest" @{
  filename        = "rag-guide.md"
  chunkStrategy   = "heading"
  knowledgeBaseId = $kb
  content         = $docContent
}
if ($ingestResult.ok) {
  Write-Host ("[PASS] HTTP 201, chunkCount = " + $ingestResult.data.chunkCount) -ForegroundColor Green
} else {
  Write-Host ("[FAIL] ingest HTTP " + $ingestResult.http) -ForegroundColor Red
  Write-Host ("  响应体: " + $ingestResult.body) -ForegroundColor Yellow
}

Write-Host ""
Write-Host "===== 2) POST /api/query (相关问题, 应命中) ====="
$q1Result = Invoke-JsonPost "$base/api/query" @{ question = "RAG 是怎么工作的？"; knowledgeBaseId = $kb }
if ($q1Result.ok) {
  $hasSnippet = ($q1Result.data.answer -match "检索增强生成")
  Write-Host ("[PASS] sources = " + $q1Result.data.sources.Count + " | answer 含原文: " + $hasSnippet) -ForegroundColor Green
} else {
  Write-Host ("[FAIL] query HTTP " + $q1Result.http + " | " + $q1Result.body) -ForegroundColor Red
}

Write-Host ""
Write-Host "===== 3) POST /api/query (无关问题, 应 0 sources) ====="
$q2Result = Invoke-JsonPost "$base/api/query" @{ question = "今天天气如何？"; knowledgeBaseId = $kb }
if ($q2Result.ok) {
  $notFound = ($q2Result.data.answer -match "未找到")
  Write-Host ("[PASS] sources = " + $q2Result.data.sources.Count + " | 提示未找到: " + $notFound) -ForegroundColor Green
} else {
  Write-Host ("[FAIL] query HTTP " + $q2Result.http + " | " + $q2Result.body) -ForegroundColor Red
}

Write-Host ""
Write-Host "===== 4) POST /api/query (非法请求, 应 422) ====="
$badResult = Invoke-JsonPost "$base/api/query" @{ question = "" }
if ($badResult.ok) {
  Write-Host "[FAIL] 非法请求竟然成功" -ForegroundColor Red
} else {
  Write-Host ("[PASS] 非法请求被拦, HTTP " + $badResult.http) -ForegroundColor Green
}

Write-Host ""
Write-Host "===== M2 验收结束 ====="
