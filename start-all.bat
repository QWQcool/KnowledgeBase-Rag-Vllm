@echo off
setlocal EnableDelayedExpansion
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
REM vLLM 默认端口（与 llm-config.json 的 vllm.baseUrl 一致）
set VLLM_PORT=8000

REM ======== 命令行参数：--engine ollama|vllm ========
REM 默认 ollama（行为与旧版完全一致）；--engine vllm 跳过 Ollama 启动，
REM 并让后端经 RAG_LLM_ENGINE=vllm 读取 llm-config.json 里的 vllm 配置。
REM 注：用 for 遍历 %*（不用 shift，shift 在括号块内不可用），支持任意参数顺序。
set "ENGINE=ollama"
set "PENDING_ENGINE=0"
for %%a in (%*) do (
    if "!PENDING_ENGINE!"=="1" (
        set "ENGINE=%%a"
        set "PENDING_ENGINE=0"
    )
    if /i "%%a"=="--engine" set "PENDING_ENGINE=1"
)
set "PENDING_ENGINE="
if /i "%ENGINE%"=="vllm" (set "ENGINE=vllm") else (set "ENGINE=ollama")
echo   Engine: %ENGINE% (--engine ollama|vllm)

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

REM ======== Step 1: 启动推理层（按 --engine 分派）========
echo [1/3] Starting inference engine (engine=%ENGINE%)...
if /i "%ENGINE%"=="vllm" goto :step1_vllm

REM ---- engine=ollama（默认，原行为）----
echo Starting Ollama (LLM inference via OpenAI-compatible API)...
where ollama >nul 2>&1
if %errorlevel%==0 (set OLLAMA_BIN=ollama) else (if exist "%OLLAMA_STANDARD%" (set OLLAMA_BIN=%OLLAMA_STANDARD%) else (goto :no_ollama))
netstat -ano | findstr ":%OLLAMA_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %OLLAMA_PORT% already in use, skip.
) else (
    REM 显存自适应：默认用 scripts/adaptive-ollama.mjs 检测空闲显存自动选档位
    REM   HIGH = 4096ctx 全 GPU（空闲 ≥9.5GB）/ MID = 2048ctx+24 层（≥4.8GB）/ LOW = 1024ctx+16 层（≥3.4GB）
    REM 手动锁定低档位：set RAG_LOW_VRAM=1（等价 LOW，无视检测结果）
    REM 背景：桌面应用占显存时 4096ctx 会 OOM（llama-server process has terminated），
    REM   所以按"当前空闲显存"选档位，避免启动即崩。
    set "OLLAMA_LEVEL=HIGH"
    if defined RAG_LOW_VRAM (
        set "OLLAMA_LEVEL=LOW"
        echo   - RAG_LOW_VRAM=1 → 强制低显存档位
    ) else (
        for /f "tokens=2 delims==" %%i in ('node "%ROOT%scripts\adaptive-ollama.mjs" 2^>nul') do set "OLLAMA_LEVEL=%%i"
        if "!OLLAMA_LEVEL!"=="MID" (echo   - 自适应档位：MID（2048ctx + 24 层 GPU）) else if "!OLLAMA_LEVEL!"=="LOW" (echo   - 自适应档位：LOW（1024ctx + 16 层 GPU）) else (echo   - 自适应档位：HIGH（4096ctx 全 GPU）)
    )
    if "!OLLAMA_LEVEL!"=="MID" (set "OLLAMA_CTX=2048" & set "OLLAMA_LAYERS=24") else if "!OLLAMA_LEVEL!"=="LOW" (set "OLLAMA_CTX=1024" & set "OLLAMA_LAYERS=16") else (set "OLLAMA_CTX=" & set "OLLAMA_LAYERS=")
    start "ollama" cmd /k "set OLLAMA_CONTEXT_LENGTH=!OLLAMA_CTX!&& set OLLAMA_GPU_LAYERS=!OLLAMA_LAYERS!&& %OLLAMA_BIN% serve"
    echo   - Ollama launching in new window... (自适应档位 !OLLAMA_LEVEL!)
)
echo   - 等待 Ollama 拉起模型（首次约需 10s）...
timeout /t 8 >nul
goto :step1_done

:step1_vllm
echo Skipping Ollama. vLLM 需单独启动（默认端口 %VLLM_PORT%）。
netstat -ano | findstr ":%VLLM_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %VLLM_PORT% already in use, assume vLLM is running.
) else (
    echo   - Port %VLLM_PORT% not listening：vLLM 尚未启动。
    echo   - 请先运行 start-vllm.bat 启动 vLLM（或用 scripts\vllm-check.mjs 检查环境），
    echo   - 确认 8000 端口就绪后再重跑本脚本。
)
:step1_done

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
echo [2/3] Starting backend (Hono + RAG pipeline, engine=%ENGINE%)...
REM 后端 LLM 端点环境变量：默认指向 Ollama；--engine vllm 时注入 vllm 端点回退。
REM 注：llm-config.json 存在时后端以 JSON 为准（RAG_LLM_ENGINE=vllm 切换引擎），
REM 下面这些 set 是 JSON 缺失时的兜底，保证两种来源行为一致。
if /i "%ENGINE%"=="vllm" (
    set "LLM_ENGINE_ENV=set LLM_PROVIDER=openai&& set RAG_LLM_ENGINE=vllm&& set OPENAI_BASE_URL=http://127.0.0.1:%VLLM_PORT%/v1&& set OPENAI_MODEL=qwen3-8b-awq&& set OPENAI_API_KEY=EMPTY"
) else (
    set "LLM_ENGINE_ENV=set LLM_PROVIDER=openai&& set OPENAI_BASE_URL=http://127.0.0.1:%OLLAMA_PORT%/v1&& set OPENAI_MODEL=qwen3:8b&& set OPENAI_API_KEY=ollama"
)
netstat -ano | findstr ":%BACKEND_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %BACKEND_PORT% already in use, skip.
) else (
    start "rag-backend" cmd /k "cd /d %ROOT%backend && !LLM_ENGINE_ENV!&& set RAG_EMBEDDING=transformers&& set RAG_MIN_SCORE=0.80&& set PORT=%BACKEND_PORT%&& set OLLAMA_CONTEXT_LENGTH=!OLLAMA_CTX!&& set OLLAMA_GPU_LAYERS=!OLLAMA_LAYERS!&& npm run start"
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
