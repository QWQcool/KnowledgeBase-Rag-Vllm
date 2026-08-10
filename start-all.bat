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
REM   薄膜逻辑（见下方「Embedding 模型路径薄膜」），无需手动 set：
REM     - 你已设 RAG_EMBEDDING_MODEL       → 直接继承，不做任何覆盖
REM     - 否则本机有本地缓存（RAG_EMBEDDING_LOCAL_CACHE，默认 C:\models\e5-small）
REM                                       → 自动指向，本机零配置
REM     - 都没有                          → 保持未定义，backend 自动下载（需联网）
REM   注：C:\models\e5-small 仅作「本机本地缓存默认路径」，可用
REM       RAG_EMBEDDING_LOCAL_CACHE 覆盖；克隆到别的机器若无此目录会优雅回退自动下载。

REM ======== Step 1: 启动 Ollama（若未运行）========
echo [1/3] Starting Ollama (LLM inference via OpenAI-compatible API)...
where ollama >nul 2>&1
if %errorlevel%==0 (set OLLAMA_BIN=ollama) else (if exist "%OLLAMA_STANDARD%" (set OLLAMA_BIN=%OLLAMA_STANDARD%) else (goto :no_ollama))
netstat -ano | findstr ":%OLLAMA_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %OLLAMA_PORT% already in use, skip.
) else (
    REM 纯文本 qwen3:8b，默认 4096 上下文（空闲显存需 ~9.3GB）。
    REM 显存降级开关：桌面应用占显存导致 OOM 时（llama-server process has terminated），
    REM   设 RAG_LOW_VRAM=1 → 以 2048 上下文启动（实测 ~5GB，稳定）。
    REM   例：set RAG_LOW_VRAM=1 然后运行本脚本。
    REM 注：qwen3-vl 视觉 warmup 会撑爆显存（4096ctx 时 OOM），如换回 VL 需加
    REM   set OLLAMA_CONTEXT_LENGTH=2048
    if defined RAG_LOW_VRAM (
        start "ollama" cmd /k "set OLLAMA_CONTEXT_LENGTH=2048&& %OLLAMA_BIN% serve"
        echo   - Ollama launching... (RAG_LOW_VRAM=1 → 2048 上下文低显存模式)
    ) else (
        start "ollama" cmd /k "%OLLAMA_BIN% serve"
        echo   - Ollama launching in new window... (qwen3:8b 纯文本，默认 4096 上下文)
    )
)
echo   - 等待 Ollama 拉起模型（首次约需 10s）...
timeout /t 8 >nul

REM ======== Embedding 模型路径薄膜（有则继承，无则本地默认/自动下载）========
if defined RAG_EMBEDDING_MODEL (
    echo   - 沿用已设置的 RAG_EMBEDDING_MODEL=%RAG_EMBEDDING_MODEL%
) else (
    if not defined RAG_EMBEDDING_LOCAL_CACHE set "RAG_EMBEDDING_LOCAL_CACHE=C:\models\e5-small"
    if exist "%RAG_EMBEDDING_LOCAL_CACHE%" (
        set "RAG_EMBEDDING_MODEL=%RAG_EMBEDDING_LOCAL_CACHE%"
        echo   - 已自动指向本地 embedding 缓存：%RAG_EMBEDDING_MODEL%
    ) else (
        echo   - 未设 RAG_EMBEDDING_MODEL 且无本地缓存，backend 将自动下载 multilingual-e5-small
    )
)

REM ======== Step 2: 启动后端（Hono + RAG 流水线）========
echo [2/3] Starting backend (Hono + RAG pipeline)...
netstat -ano | findstr ":%BACKEND_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %BACKEND_PORT% already in use, skip.
) else (
    start "rag-backend" cmd /k "cd /d %ROOT%backend && set LLM_PROVIDER=openai&& set OPENAI_BASE_URL=http://127.0.0.1:%OLLAMA_PORT%/v1&& set OPENAI_MODEL=qwen3:8b&& set OPENAI_API_KEY=ollama&& set RAG_EMBEDDING=transformers&& set RAG_MIN_SCORE=0.80&& set PORT=%BACKEND_PORT%&& npm run start"
    echo   - Backend launching in new window... (RAG_EMBEDDING_MODEL 由父环境继承：薄膜已设或留空用默认)
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
