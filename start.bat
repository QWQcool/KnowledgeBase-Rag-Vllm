@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title RAG Knowledge Base Launcher

set "ROOT=%~dp0"
set "VLLM_PORT=8000"

REM ===== 默认推荐参数 =====
set "ENGINE=ollama"
set "RAG_GRAPH_ENABLED=1"
set "RAG_GRAPH_DECISION=llm"
set "EMBEDDING=transformers"
set "MIN_SCORE=0.80"
set "ZHIPU_KEY_ENTERED=0"

:main_menu
cls
echo ============================================
echo   RAG Knowledge Base 启动器
echo   1. 默认启动（推荐参数）
echo   2. 修改相关参数启动
echo   3. 退出
echo ============================================
echo.
set /p "MAIN_CHOICE=请选择 [1/2/3]: "
if "!MAIN_CHOICE!"=="1" goto :default_start
if "!MAIN_CHOICE!"=="2" goto :config_menu
if "!MAIN_CHOICE!"=="3" exit /b 0
goto :main_menu

:default_start
set "ENGINE=ollama"
set "RAG_GRAPH_ENABLED=1"
set "RAG_GRAPH_DECISION=llm"
set "EMBEDDING=transformers"
set "MIN_SCORE=0.80"
echo.
echo 使用默认推荐参数启动：
echo   Engine      : !ENGINE!
echo   LangGraph   : !RAG_GRAPH_ENABLED!
echo   Decision    : !RAG_GRAPH_DECISION!
echo   Embedding   : !EMBEDDING!
echo   MinScore    : !MIN_SCORE!
echo.
goto :launch

:config_menu
cls
echo ============================================
echo   启动配置
echo ============================================
echo.
echo   当前配置：
echo     [1] 推理引擎        : !ENGINE!   (ollama / vllm)
echo     [2] LangGraph 开关   : !RAG_GRAPH_ENABLED!   (1=启用 0=关闭)
echo     [3] LangGraph 决策   : !RAG_GRAPH_DECISION!  (llm=远程/智谱  rule=规则)
echo     [4] Embedding 模式  : !EMBEDDING!   (transformers / openai / mock)
echo     [5] 相关度阈值       : !MIN_SCORE!
if "!ZHIPU_KEY_ENTERED!"=="1" (
    echo     [6] 智谱 Key          : 已输入（不显示明文）
) else (
    echo     [6] 智谱 Key          : 继承环境变量 / 未设置
)
echo     [7] 开始启动
echo     [8] 返回主菜单
echo.
set /p "CONF_CHOICE=请选择配置项 [1-8]: "
if "!CONF_CHOICE!"=="1" goto :conf_engine
if "!CONF_CHOICE!"=="2" goto :conf_langgraph_enable
if "!CONF_CHOICE!"=="3" goto :conf_langgraph_decision
if "!CONF_CHOICE!"=="4" goto :conf_embedding
if "!CONF_CHOICE!"=="5" goto :conf_min_score
if "!CONF_CHOICE!"=="6" goto :conf_zhipu
if "!CONF_CHOICE!"=="7" goto :launch
if "!CONF_CHOICE!"=="8" goto :main_menu
goto :config_menu

:conf_engine
set /p "ENGINE_INPUT=请输入推理引擎 [ollama/vllm]: "
if /i "!ENGINE_INPUT!"=="vllm" (set "ENGINE=vllm") else (set "ENGINE=ollama")
goto :config_menu

:conf_langgraph_enable
set /p "RAG_GRAPH_ENABLED_INPUT=启用 LangGraph Agentic RAG? [1/0]: "
if "!RAG_GRAPH_ENABLED_INPUT!"=="0" (set "RAG_GRAPH_ENABLED=0") else (set "RAG_GRAPH_ENABLED=1")
goto :config_menu

:conf_langgraph_decision
set /p "RAG_GRAPH_DECISION_INPUT=LangGraph 决策模式 [llm/rule]: "
if /i "!RAG_GRAPH_DECISION_INPUT!"=="rule" (set "RAG_GRAPH_DECISION=rule") else (set "RAG_GRAPH_DECISION=llm")
goto :config_menu

:conf_embedding
set /p "EMBEDDING_INPUT=Embedding 模式 [transformers/openai/mock]: "
if /i "!EMBEDDING_INPUT!"=="openai" (set "EMBEDDING=openai") else if /i "!EMBEDDING_INPUT!"=="mock" (set "EMBEDDING=mock") else (set "EMBEDDING=transformers")
goto :config_menu

:conf_min_score
set /p "MIN_SCORE_INPUT=相关度阈值 [0.80]: "
if "!MIN_SCORE_INPUT!"=="" (set "MIN_SCORE=0.80") else (set "MIN_SCORE=!MIN_SCORE_INPUT!")
goto :config_menu

:conf_zhipu
set /p "ZHIPU_KEY_INPUT=请输入智谱 Key（留空=继承环境变量，不显示明文）: "
if not "!ZHIPU_KEY_INPUT!"=="" (
    set "ZHIPUAI_API_KEY=!ZHIPU_KEY_INPUT!"
    set "ZHIPU_KEY_ENTERED=1"
)
goto :config_menu

:launch
set "RAG_EMBEDDING=!EMBEDDING!"
set "RAG_MIN_SCORE=!MIN_SCORE!"
if /i "!ENGINE!"=="vllm" goto :launch_vllm
call "%ROOT%start-all.bat" --engine ollama
goto :eof

:launch_vllm
echo.
echo 正在新窗口启动 vLLM...
start "vllm" cmd /k "cd /d %ROOT% && call start-vllm.bat"
echo 等待 vLLM 端口 %VLLM_PORT% 就绪（首次加载模型可能需要几分钟）...
set /a VLLM_WAIT=0
:wait_vllm
netstat -ano | findstr ":%VLLM_PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :vllm_ready
set /a VLLM_WAIT+=1
if !VLLM_WAIT! GEQ 60 (
    echo.
    echo [超时] 等待 vLLM 端口 %VLLM_PORT% 超时，请检查 start-vllm.bat 窗口日志。
    pause
    exit /b 1
)
timeout /t 3 >nul
goto :wait_vllm
:vllm_ready
echo vLLM 已就绪，继续启动后端/前端...
call "%ROOT%start-all.bat" --engine vllm
goto :eof