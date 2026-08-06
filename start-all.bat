@echo off
chcp 65001 >nul
title RAG Knowledge Base - One Click Start
echo ========================================
echo   RAG Knowledge Base Launcher
echo   LLM Server + Backend + Frontend
echo ========================================
echo.

set ROOT=C:\Users\v_chchsli\Desktop\AICodingPrjStudy\RAG_libraries
set LLAMA_DIR=C:\llama.cpp
set MODEL=C:\models\qwen3-8b-q4_k_m.gguf
set LLAMA_PORT=8080
set BACKEND_PORT=3000
set FRONTEND_PORT=5173

REM ======== Step 1: Start llama-server ========
echo [1/3] Starting llama-server (LLM inference)...
netstat -ano | findstr ":%LLAMA_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %LLAMA_PORT% already in use, skip.
) else (
    start "llama-server" cmd /k "%LLAMA_DIR%\llama-server.exe --model %MODEL% --host 127.0.0.1 --port %LLAMA_PORT% --n-gpu-layers 99 --ctx-size 4096 --embedding --reasoning off"
    echo   - llama-server launching in new window...
)

REM ======== Step 2: Start backend ========
echo [2/3] Starting backend (Hono + RAG pipeline)...
netstat -ano | findstr ":%BACKEND_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %BACKEND_PORT% already in use, skip.
) else (
    start "rag-backend" cmd /k "cd /d %ROOT%\backend && set LLM_PROVIDER=openai&& set OPENAI_BASE_URL=http://127.0.0.1:%LLAMA_PORT%/v1&& set OPENAI_MODEL=%MODEL%&& set OPENAI_API_KEY=not-needed&& set RAG_EMBEDDING=transformers&& set HF_ENDPOINT=https://hf-mirror.com&& set PORT=%BACKEND_PORT%&& npm run start"
    echo   - Backend launching in new window...
)

REM ======== Step 3: Start frontend ========
echo [3/3] Starting frontend (Vite)...
netstat -ano | findstr ":%FRONTEND_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   - Port %FRONTEND_PORT% already in use, skip.
) else (
    start "rag-frontend" cmd /k "cd /d %ROOT%\frontend && npm run dev"
    echo   - Frontend launching in new window...
)

echo.
echo All processes started. Wait ~10s for model load, then open:
echo   http://localhost:%FRONTEND_PORT%
echo.
echo Press any key to close this window...
pause >nul
