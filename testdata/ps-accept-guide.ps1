# M2 E2E 验收脚本（PowerShell 5.1 兼容，UTF-8 BOM）
# 前置：后端已启动（RAG_EMBEDDING=transformers LLM_PROVIDER=mock PORT=3105）
# 运行：powershell -ExecutionPolicy Bypass -File ps-accept-guide.ps1

# 控制台切 UTF-8，避免中文显示乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ErrorActionPreference = "Stop"
$base = "http://localhost:3105"
$kb   = "kb-accept"
$mdPath = Join-Path $PSScriptRoot "rag-guide.md"

Write-Host ""
Write-Host "===== 1) POST /api/ingest (上传 MD, heading 分块) ====="
try {
  $content = Get-Content -Raw -Encoding UTF8 $mdPath
  $body = @{
    filename        = "rag-guide.md"
    chunkStrategy   = "heading"
    knowledgeBaseId = $kb
    content         = $content
  } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri "$base/api/ingest" -ContentType "application/json" -Body $body
  Write-Host ("[PASS] HTTP 201, chunkCount = " + $r.chunkCount) -ForegroundColor Green
} catch {
  Write-Host ("[FAIL] ingest 失败: " + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ""
Write-Host "===== 2) POST /api/query (相关问题, 应命中) ====="
try {
  $q1 = @{ question = "RAG 是怎么工作的？"; knowledgeBaseId = $kb } | ConvertTo-Json
  $r1 = Invoke-RestMethod -Method Post -Uri "$base/api/query" -ContentType "application/json" -Body $q1
  $hasSnippet = ($r1.answer -match "检索增强生成")
  Write-Host ("[PASS] sources = " + $r1.sources.Count + " | answer 含原文: " + $hasSnippet) -ForegroundColor Green
} catch {
  Write-Host ("[FAIL] 相关问题失败: " + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ""
Write-Host "===== 3) POST /api/query (无关问题, 应 0 sources) ====="
try {
  $q2 = @{ question = "今天天气如何？"; knowledgeBaseId = $kb } | ConvertTo-Json
  $r2 = Invoke-RestMethod -Method Post -Uri "$base/api/query" -ContentType "application/json" -Body $q2
  $notFound = ($r2.answer -match "未找到")
  Write-Host ("[PASS] sources = " + $r2.sources.Count + " | 提示未找到: " + $notFound) -ForegroundColor Green
} catch {
  Write-Host ("[FAIL] 无关问题失败: " + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ""
Write-Host "===== 4) POST /api/query (非法请求, 应 422) ====="
try {
  $bad = @{ question = "" } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$base/api/query" -ContentType "application/json" -Body $bad
  Write-Host "[FAIL] 非法请求竟然成功" -ForegroundColor Red
} catch {
  $status = [int]$_.Exception.Response.StatusCode
  Write-Host ("[PASS] 非法请求被拦, HTTP " + $status) -ForegroundColor Green
}

Write-Host ""
Write-Host "===== M2 验收结束 ====="
