@echo off
chcp 65001 >nul
title RAG Knowledge Base - One Click Start
echo ========================================
echo   RAG Knowledge Base Launcher
echo   LLM Server + Backend + Frontend
echo ========================================
echo.

REM ======== 路径约定（全部相对/标准，绝不写死本机绝对路径）========
REM ROOT = 本脚本所在目录（即 RAG_libraries）。任意机器 clone 后都正确，无需改路径。
set "ROOT=%~dp0"
REM Ollama 的 Windows 标准安装位置；找不到再提示用户自行安装。
set "OLLAMA_STANDARD=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
set OLLAMA_PORT=11434
set BACKEND_PORT=3000
set FRONTEND_PORT=5173

REM ======== 推理层说明 ========
REM 默认走 Ollama（OpenAI 兼容接口 :11434/v1）。
REM 原因：llama.cpp 在加载从 Ollama 抽出的 Qwen3-8B GGUF 时会卡死（b10330 已知问题），
REM       故 M4 改由 Ollama 直接服务 Qwen3-8B-Instruct。
REM 模型权重：ollama pull qwen3:8b（约 5.2GB，Q4_K_M）。
REM Embedding：默认用 Transformers.js 自动下载 multilingual-e5-small（首次联网）。
REM   若你已把模型缓存到本地目录，可在运行本脚本前设环境变量：
REM   set RAG_EMBEDDING_MODEL=<你的本地模型目录 或 HF 模型名>

REM ======== Step 1: 启动 Ollama（若未运行）========
echo [1/3] Starting Ollama (LLM inference via OpenAI-compatible API)...
where ollama >nul 2>&1
if %errorlevel%==0 (set OLLAMA_BIN=ollama) else (if exist "%OLLAMA_STANDARD%" (set OLLAMA_BIN=%OLLAMA_STANDARD%) else (goto :no_ollama))
netstat -ano | findstr ":%OLLAMA_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %OLLAMA_PORT% already in use, skip.
) else (
    start "ollama" cmd /k "%OLLAMA_BIN% serve"
    echo   - Ollama launching in new window...
)
echo   - 等待 Ollama 拉起模型（首次约需 10s）...
timeout /t 8 >nul

REM ======== Step 2: 启动后端（Hono + RAG 流水线）========
echo [2/3] Starting backend (Hono + RAG pipeline)...
netstat -ano | findstr ":%BACKEND_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %BACKEND_PORT% already in use, skip.
) else (
    start "rag-backend" cmd /k "cd /d %ROOT%backend && set LLM_PROVIDER=openai&& set OPENAI_BASE_URL=http://127.0.0.1:%OLLAMA_PORT%/v1&& set OPENAI_MODEL=qwen3:8b&& set OPENAI_API_KEY=ollama&& set RAG_EMBEDDING=transformers&& set PORT=%BACKEND_PORT%&& npm run start"
    echo   - Backend launching in new window...
)

REM ======== Step 3: 启动前端（Vite）========
echo [3/3] Starting frontend (Vite)...
netstat -ano | findstr ":%FRONTEND_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %FRONTEND_PORT% already in use, skip.
) else (
    start "rag-frontend" cmd /k "cd /d %ROOT%frontend && npm run dev"
    echo   - Frontend launching in new window...
)

echo.
echo All processes started. Wait ~10s, then open:
echo   http://localhost:%FRONTEND_PORT%
echo.
echo Press any key to close this window...
pause >nul
goto :eof

:no_ollama
echo.
echo [错误] 未找到 Ollama。请先安装 Ollama（https://ollama.com），
echo        或将其加入 PATH / 放到 %LOCALAPPDATA%\Programs\Ollama\ollama.exe。
echo        安装后运行：ollama pull qwen3:8b
pause
