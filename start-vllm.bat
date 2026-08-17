@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title RAG Knowledge Base - vLLM Launcher (Windows fork)
echo ========================================
echo   vLLM 启动模板（SystemPanic/vllm-windows 社区 fork）
echo   Qwen3-8B AWQ @ 4060 Ti 16GB
echo ========================================
echo.

REM ======== 0) 配置区（TODO：按本机情况填写） ========
REM 仓库根目录 = 本脚本所在目录（RAG_libraries），相对路径自动成立，无需改
set "ROOT=%~dp0"
REM Python 3.12 专用 venv 目录（vLLM fork 要求 3.12，系统 Python 3.13 不可用！
REM 首次需按 docs\vllm-migration-report.md 建好并装好 wheel，本脚本不负责安装）
set "VLLM_VENV=%USERPROFILE%\venvs\vllm-py312"
REM 模型目录：Qwen3-8B AWQ 的 safetensors + config.json 所在文件夹
REM （用 scripts\vllm-check.mjs 可校验此目录是否齐全）
set "MODEL_DIR=%ROOT%models\Qwen3-8B-AWQ"
REM --served-model-name：必须与 llm-config.json 里 vllm.model 一致（默认已对齐）
set "MODEL_NAME=qwen3-8b-awq"
REM vLLM 服务端口（与 llm-config.json 的 vllm.baseUrl 一致）
set "VLLM_PORT=8000"
REM 显存利用率上限（RTX 3080 10GB 建议 0.85；桌面占显存时可再降到 0.8）
REM 注：本脚本参数按 10GB 卡（工作机 RTX 3080）校准；家庭机 4060Ti 16GB 可改回 GPU_MEM=0.9、MAX_MODEL_LEN=32768
set "GPU_MEM=0.85"
REM 最大上下文长度（AWQ 8B 权重 ~6.1GB + 10GB 卡 → 8192 安全，16384 有 OOM 风险）
set "MAX_MODEL_LEN=8192"
REM CUDA runtime (cudart) 动态库路径。
REM vLLM fork 通过 VLLM_CUDART_SO_PATH 找 cudart64_*.dll；三种常见来源：
REM   A. NVIDIA 驱动自带：%SystemRoot%\System32\DriverStore\FileRepository\nvdm.inf_amd64_*\cudart64_*.dll
REM   B. CUDA Toolkit：C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1\bin\x64\cudart64_13.dll（注意：CUDA 13.x 的 dll 在 bin\x64\ 子目录）
REM 下面优先用已设置的环境变量，否则自动在 A/B 两处查找第一个存在的 dll。
REM 注：if not defined 在 for 块内可即时生效（无需延迟展开），首个命中后即跳过后续。
if not defined VLLM_CUDART_SO_PATH (
    for /f "delims=" %%f in ('dir /b /s "%SystemRoot%\System32\DriverStore\FileRepository\nvdm.inf_amd64_*\cudart64_*.dll" 2^>nul') do if not defined VLLM_CUDART_SO_PATH set "VLLM_CUDART_SO_PATH=%%f"
    for /f "delims=" %%f in ('dir /b /s "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\*\bin\cudart64_*.dll" 2^>nul') do if not defined VLLM_CUDART_SO_PATH set "VLLM_CUDART_SO_PATH=%%f"
    REM CUDA 13.x 的 cudart64_13.dll 在 bin\x64\ 子目录（bin\ 下只有工具链 exe），上面 glob 命中不到，需再扫一层
    for /f "delims=" %%f in ('dir /b /s "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\*\bin\x64\cudart64_*.dll" 2^>nul') do if not defined VLLM_CUDART_SO_PATH set "VLLM_CUDART_SO_PATH=%%f"
)

REM ======== 1) 环境检查（缺失项直接提示，不假装能启动） ========
echo [检查] Python 3.12 venv：%VLLM_VENV%
if not exist "%VLLM_VENV%\Scripts\python.exe" (
    echo   [缺失] 未找到 venv。请先执行：
    echo      py -3.12 -m venv "%VLLM_VENV%"
    echo   （完整安装步骤见 docs\vllm-migration-report.md）
    pause
    exit /b 1
)
echo   [OK] venv 存在

echo [检查] 模型目录：%MODEL_DIR%
if not exist "%MODEL_DIR%\config.json" (
    echo   [缺失] 模型目录缺少 config.json。请下载 Qwen3-8B AWQ（safetensors 版）
    echo          放到 %MODEL_DIR% 下，可用 scripts\vllm-check.mjs 校验。
    pause
    exit /b 1
)
echo   [OK] 模型目录存在

echo [检查] VLLM_CUDART_SO_PATH：%VLLM_CUDART_SO_PATH%
if not defined VLLM_CUDART_SO_PATH (
    echo   [缺失] 未找到 cudart64_*.dll。请手动 set "VLLM_CUDART_SO_PATH=...cudart64_*.dll 路径"
    pause
    exit /b 1
)
if not exist "%VLLM_CUDART_SO_PATH%" (
    echo   [缺失] 路径不存在：%VLLM_CUDART_SO_PATH% 。请改配置文件区第 5 项。
    pause
    exit /b 1
)
echo   [OK] cudart 存在

REM ======== 1.5) MSVC 环境（flashinfer JIT 编译必需，2026-08-17 实测踩坑） ========
REM vLLM 0.26 依赖 flashinfer，其 JIT 首次运行要用 ninja + cl.exe 编译 kernel：
REM   - ninja 需先装：pip install ninja（本脚本在 venv Scripts 里找）
REM   - cl.exe / INCLUDE / LIB 来自 VS 的 vcvars64.bat；缺失会导致
REM     FileNotFoundError: [WinError 2]（ninja 找不到）或 UnicodeDecodeError（GBK 输出）
echo [检查] ninja（flashinfer JIT 构建工具）
if not exist "%VLLM_VENV%\Scripts\ninja.exe" (
    echo   [缺失] 未找到 ninja.exe。请执行：%VLLM_VENV%\Scripts\pip install ninja
    pause
    exit /b 1
)
echo   [OK] ninja 存在
set "PATH=%VLLM_VENV%\Scripts;%PATH%"

echo [检查] MSVC（vcvars64.bat，flashinfer JIT 编译 cl.exe）
set "VCVARS64="
for /f "delims=" %%f in ('dir /b /s "C:\Program Files\Microsoft Visual Studio\2022\*\VC\Auxiliary\Build\vcvars64.bat" 2^>nul') do if not defined VCVARS64 set "VCVARS64=%%f"
if not defined VCVARS64 (
    echo   [缺失] 未找到 vcvars64.bat。flashinfer JIT 需要 MSVC（cl.exe），装 VS2022 C++ 组件后重试
    pause
    exit /b 1
)
echo   [OK] %VCVARS64%
call "%VCVARS64%" >nul 2>&1

REM ======== 2) 启动 vLLM serve ========
echo [启动] vllm serve --model "%MODEL_DIR%" --served-model-name %MODEL_NAME% --port %VLLM_PORT%
call "%VLLM_VENV%\Scripts\activate.bat"
echo 环境：%VLLM_VENV%\Scripts\python.exe（GPU 0），显存上限 %GPU_MEM%
echo 模型：%MODEL_NAME%（AWQ） | 上下文 %MAX_MODEL_LEN%
echo.

vllm serve "%MODEL_DIR%" ^
  --served-model-name %MODEL_NAME% ^
  --port %VLLM_PORT% ^
  --gpu-memory-utilization %GPU_MEM% ^
  --max-model-len %MAX_MODEL_LEN% ^
  --quantization awq ^
  --dtype auto

REM ======== 3) 启动后的提示（vLLM 崩溃/退出后才会执行到这里） ========
echo.
echo [提示] vLLM 已退出。若要切换 RAG 后端到 vLLM：
echo   1. 改 RAG_libraries\llm-config.json 的 engine 为 "vllm"
echo      （或直接运行 start-all.bat --engine vllm）
echo   2. 重启 backend（start-all.bat 会自动读新配置）
echo   3. 打开 http://localhost:3000/api/model 确认模型名变为 %MODEL_NAME%
pause
