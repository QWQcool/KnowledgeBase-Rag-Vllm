# RAG 知识库问答 Web App

> 把本地文档（PDF/MD/TXT）建成知识库，在网页上提问，由大模型基于检索到的内容回答，**答案带原文引用、可溯源**。
> 这是「AI 全栈开发工程师 / Agent 编排」转型的**作品集主项目**——TS 全栈 + C++(llama.cpp) 推理层的完整 AI 应用，全程多 Agent 编排交付、TDD 门禁。

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | TypeScript + React + Vite | 问答页、知识库管理、三态主题（system/light/dark） |
| 后端 | TypeScript + Hono/Fastify | 文档摄入、检索编排、SSE 流式 |
| 推理层 | **C++ llama.cpp（llama-server）** | 本地大模型，OpenAI 兼容 HTTP API |
| 向量库 | **TriviumDB**（Rust 嵌入式：向量+图+文档） | 本地单文件，napi-rs 预编译绑定；替换了初版 LanceDB（见 01 手册选型记录） |
| Embedding | Transformers.js 或 llama-server /v1/embeddings | 抽象接口（Strategy）可切换 |
| 契约 | `shared/contract.ts`（TS 类型 + Zod） | 前后端唯一事实源，编译期拦截漂移 |

### 架构

```
┌─────────────┐   SSE 流式   ┌──────────────────────────┐
│ React 前端    │ ──────────▶ │ TS 后端 (Hono/Fastify)     │
│ TS/React/Vite│             │  · 文档上传/解析/编排        │
└─────────────┘             │  · 检索 + 生成编排          │
                            └───────┬──────────┬─────────┘
                                    │          │
                        embedding  │          │ LLM 生成（OpenAI 兼容 HTTP）
                        Transformers.js 或    ▼
                        llama-server /v1/embeddings   ┌────────────────────┐
                                    │                 │ C++ llama.cpp       │
                                    ▼                 │ llama-server 进程    │
                        ┌────────────────────┐        │ (GGUF 量化模型)      │
                        │ 向量库 LanceDB/     │        └────────────────────┘
                        │ sqlite-vec          │
                        └────────────────────┘
```

**为什么 TS + C++？** 选型依据见 `docs/RAG后端语言选型-对比与建议.md`（三路 Agent 调研）：
- **TS 全栈**：前后端同语言，契约共享一份类型，接口漂移编译期拦截；SSE 原生顺手。
- **C++ 推理层**：跑正经本地大模型（量化/长上下文/性能）llama.cpp 是事实标准；llama-server 暴露 OpenAI 兼容 API，TS 与 C++ 之间是**干净的 HTTP 边界**——换模型不换代码，也发挥你的 C++/UE5 背景。

## 文档地图

| 文档 | 是什么 | 什么时候看 |
|---|---|---|
| `01-项目规划与执行手册.md` | SPEC / 架构 / 里程碑 M1–M5（各含 AC + **Agent 派单提示词模板** + Skill + MCP 接法）/ 选型记录 | **开发时**（高频改动） |
| `02-面试学习手册.md` | 项目话术 + 概念拆解 + 17 道高频题 + 问答情景 + 速记卡 | **面试前**（低频稳定） |
| `docs/RAG后端语言选型-对比与建议.md` | TS/Python/C++ 三路调研与选型结论 | 复习选型理由时 |
| `docs/面试高频问点-设计范式-MCP-Skill-RAG.md` | 通用概念（设计范式/MCP/Skill/RAG） | 面试前与 02 互补 |

## 进度

- [x] **M0 立项**：目录、文档体系（本 README + 01 + 02）
- [x] **M1 骨架 + 前后端契约**：workspaces monorepo（backend/frontend/shared）、`shared/contract.ts`（Zod 契约）、`GET /health`、占位页；后端 6 + 前端 3 tests 全绿
- [x] **M2 RAG 流水线**：解析(MD/TXT/PDF)→分块(heading/fixed)→embedding(Transformers/Mock)→**TriviumDB 入库**→检索(topK+minScore 阈值)→LLM 回答(mock/OpenAI 兼容)；`POST /api/ingest` + `POST /api/query`；后端 48 tests 全绿、端到端实测通过（向量库 2026-08-03 由 LanceDB 换为 TriviumDB，业务零改动）
- [x] **M2 补做 · MCP 接法**：`mcp-server/` 独立 workspace，`retrieve` 工具经 MCP 协议（官方 SDK + stdio）调用 backend `/api/retrieve` 真实检索；mcp-server 5 tests + 端到端实测通过；沉淀 skill `mcp-server-scaffold`
- [x] **M3 问答体验**：`POST /api/query/stream` SSE 流式（sources→token*→done/error）；前端 `ReadableStream` reader + `TextDecoder` 逐字渲染 + 引用列表可展开 + 错误态不白屏；后端 56 + 前端 6 tests 全绿，端到端实测通过
- [x] **M4 C++ 推理层**：新增 `OpenAICompatibleEmbeddingProvider`（走 `/v1/embeddings`，含维度校验），`EMBEDDING_DIM` 改可环境变量覆盖；LLM 侧零代码改动（`OpenAICompatibleLLMProvider` 早已预留 llama-server 接入）；后端 61 tests 全绿。本机部署 llama-server（qwen2.5-7b-q4 / qwen3-8b）+ 指向后端 + 性能基准脚本见下方「M4 本机推理层部署」
- [x] **M5 验收打磨**：检索命中率 **100%**（10 个测试问题：5 相关全命中 + 5 无关全过滤）；minScore 阈值经三轮实测定到 0.85；02 速记卡回填全部真实数字（TTFT 287ms / 103.4 tok/s / GPU 9686 MiB）；后端 61 tests 全绿。**项目完成**
- [x] **完工后打磨（2026-08-06）**：① 换 Qwen3-8B（5.2GB，Adapter 零代码切换，回答更结构化）；② 前端初音风格聊天式布局 + 模型信息弹窗 + 历史对话侧栏（localStorage）+ MCP 面板；③ 修复 Qwen3 思考模式导致流式空响应（llama-server 加 `--reasoning off`）；④ **一键启动 `start-all.bat`**（双击自动拉起 llama-server + 后端 + 前端）。后端 61 + 前端 6 tests 全绿

## 快速开始（项目已完成，一键启动）

1. **双击 `start-all.bat`** → 自动开 3 个窗口启动 llama-server（:8080）+ 后端（:3000）+ 前端（:5173），浏览器访问 http://localhost:5173
2. 所有里程碑 M1→M5 已完成，详见 `01-项目规划与执行手册.md`。
3. 环境要求：Node 22+（前端/后端）、Git；**本地 LLM 推理层（M4）需 llama.cpp + GGUF 模型**，见下方「M4 本机推理层部署」；换机先跑 `node scripts/deploy-llm.mjs` 一键部署模型。
4. 面试资产：真实数字已回填进 `02-面试学习手册.md` 的速记卡。
5. 依赖安装：根目录 `npm install`（workspaces 一次装齐三端），测试分别在 backend/ 与 frontend/ 下 `npm test`。
6. 后端运行（mock 模式，无需推理层）：`cd backend && $env:RAG_EMBEDDING="transformers"; $env:LLM_PROVIDER="mock"; $env:PORT="3000"; npm run start`。

## 新人上手（换机 / 他人 clone 本仓库）

```powershell
# 1) 安装依赖（node_modules 不入库，必须执行这一步）
cd RAG_libraries
npm install

# 2) 跑测试（前后端各 1 次）
cd backend;  npm test    # 预期 6 passed
cd frontend; npm test    # 预期 3 passed

# 3) 起后端（验证 /health）
cd backend; $env:PORT = "3100"; npm run start
# 另开终端：curl.exe http://localhost:3100/health   → {"status":"ok",...}

# 4) 起前端
cd frontend; npm run dev  # 浏览器开 http://localhost:5173
```

**关于 `node_modules`（为什么不入库、clone 后怎么还原）**：
- `node_modules/` 已被 `.gitignore` 忽略，**不会**提交进 git——这是 Node 生态的**标准做法**，不是疏漏。
- 依赖清单由 `package.json`（声明了哪些包）和 `package-lock.json`（锁定了精确版本）两份文件承载，二者入库；任何人 clone 后执行一次 `npm install` 即可**精确还原**同样的依赖树（含根 workspaces 三端依赖）。
- 原理：依赖装在**项目本地**而非全局，是为了**版本隔离**——A 项目用 zod v3、B 项目用 zod v4 互不干扰；全局安装（`npm install -g`）反而会造成版本冲突，只在装 CLI 工具时用。
- 进阶：如果觉得多个项目重复下载浪费磁盘/带宽，可换 **pnpm**（npm 的替代包管理器）：全局只存一份内容寻址的依赖仓库，各项目 `node_modules` 用硬链接指向它，既省空间又保持版本隔离。本仓库当前用 npm，未来如需可迁移。

## M4 本机推理层部署（llama.cpp / llama-server）

M4 的核心：把后端的 LLM 生成从 Mock 切到本机真大模型，**TS 后端零代码改动**（Adapter 模式回报：`OpenAICompatibleLLMProvider` 早已预留 llama-server 接入，只设环境变量）。Embedding 侧也补了 `OpenAICompatibleEmbeddingProvider` 满足「可切换」AC，但默认仍用 Transformers.js 不破坏现有索引。

> **⚠️ 推理层默认走 Ollama（非 llama.cpp）**：llama.cpp 在加载从 Ollama 抽出的 Qwen3-8B GGUF 时会**卡死在 "loading model"**（b10330 已知问题，GPU/CPU、加不加 `--embedding`/`--no-mmap` 都复现）。因此 **`start-all.bat` 已改为用本机 Ollama 的 OpenAI 兼容接口（`:11434/v1`）当推理层**——`ollama pull qwen3:8b` 拉模型、`ollama serve` 暴露 API，后端 `OPENAI_BASE_URL` 指向它即可，无需 llama.cpp。llama.cpp 仍可装到任意目录备用。下面 llama.cpp 小节仅作备选参考。
>
> **模型来源提示**：若网络环境拦截 HuggingFace（`huggingface.co`，某些代理/公司网络常见），LLM 权重走 **Ollama**（`registry.ollama.ai` 通常可达）；Embedding 模型 `Xenova/multilingual-e5-small` 可改从 **ModelScope**（`modelscope.cn`）取 ONNX 缓存到本地目录。

### 1. 选 GGUF 模型（按硬件档位）

| 硬件 | 推荐模型 | 大小 | 速度参考 | 说明 |
|---|---|---|---|---|
| **N 卡 ≥8GB 显存**（本项目档 / 16GB 卡甜点） | `qwen3-8b-instruct-q4_k_m` | ~5.2GB | 几十 tok/s | Qwen3 推理/中文更强；思考模式已用 `--reasoning off` 适配；本项目与 4060Ti 16GB 的甜点档 |
| N 卡 4–6GB 显存 | `qwen3-4b-instruct-q4_k_m` | ~3GB | 二十+ tok/s | 显存不够 8b 时的退档 |
| 核显/无独显，≥16GB 内存 | `qwen3-1.7b-instruct-q4_k_m` | ~1.2GB | 个位数 tok/s | 纯 CPU 推理，能跑但慢 |

量化档位（Q4_K_M 是性价比甜点；Q5/Q6 更准但更慢、Q2/Q3 失真多）。模型从 [HuggingFace](https://huggingface.co/Qwen) 或 [ModelScope](https://modelscope.cn) 下，文件 `.gguf` 放本机任意目录（**不入 git**，已 gitignore）。

### 2. 装 llama.cpp（用预编译包，不自己编译）

到 https://github.com/ggml-org/llama.cpp/releases 下最新 `llama-<版本>-bin-win-cuda-cu12-x64.zip`（CUDA 版，N 卡用；核显下 `bin-win-avx2-x64.zip`）。解压到任意目录（如 `.\llama.cpp\`），里面有 `llama-server.exe`。

### 3. 起 llama-server（N 卡 + 7b 档）

```powershell
# PowerShell 5.1：环境变量与参数分行，避免分号吞引号坑
cd <你的 llama.cpp 目录>
$env:CUDA_VISIBLE_DEVICES = "0"
.\llama-server.exe `
  --model ".\models\qwen3-8b-q4_k_m.gguf" `
  --host 0.0.0.0 --port 8080 `
  --n-gpu-layers 99 `
  --ctx-size 4096 `
  --embedding
```

- `--n-gpu-layers 99`：尽量把层卸载到 GPU（N 卡加速关键；99 表示全卸）。
- `--ctx-size 4096`：上下文窗口，RAG 检索片段 + 提问通常够。
- `--embedding`：同时开 `/v1/embeddings` 端点（若要把 embedding 也切到 llama-server 才需要；默认用 Transformers.js 可不加）。
- 起来后访问 http://localhost:8080 看到 Web UI 即成功；`/v1/chat/completions` 与 `/v1/embeddings` 自动可用。

### 4. 后端指向 llama-server

```powershell
cd RAG_libraries\backend
# LLM 切到 llama-server（Adapter：只改环境变量，不改代码）
$env:LLM_PROVIDER = "openai"
$env:OPENAI_BASE_URL = "http://localhost:8080/v1"
$env:OPENAI_MODEL = "qwen3-8b-instruct"   # llama-server 用模型文件名/别名
$env:OPENAI_API_KEY = "not-needed"           # llama-server 不校验，但 Provider 要非空串
# Embedding 保持 Transformers.js（已验证、不重索引）
$env:RAG_EMBEDDING = "transformers"
$env:PORT = "3000"
npm run start
```

> **Embedding 切 llama-server（可选）**：`$env:RAG_EMBEDDING="openai"; $env:OPENAI_EMBEDDING_MODEL="bge-m3"; $env:RAG_EMBEDDING_DIM="1024"`。⚠️ **维度变 = 已入库向量作废**：必须先 `Remove-Item -Recurse backend\data\trivium\*` 再重新 ingest。代码里有维度校验第一时间报错。

### 5. 端到端验证 + 性能基准

```powershell
# 起 frontend（另一终端）
cd RAG_libraries\frontend; npm run dev   # http://localhost:5173 提问，看流式真生成
```

跑性能基准脚本（首 token 延迟 / tok/s / 内存占用）：
```powershell
cd RAG_libraries\scripts
node bench-llama.mjs   # 输出 bench-result.md；用 node 是为精准计时 SSE 流式
```

### 设计要点（面试）

- **为什么 C++？** llama.cpp 是本地大模型推理事实标准，量化 + SIMD 优化，性能远超 Python GIL 受限的推理。
- **GGUF 量化是什么？** 把 float16 权重压成 4-bit（Q4_K_M 等），显存/内存降 4 倍，精度损失可控。
- **TS↔C++ 边界为什么是 HTTP？** llama-server 暴露 OpenAI 兼容协议——TS 这边只是个 HTTP 客户端，换模型/换后端不换代码（Adapter 模式）；C++ 进程崩了不影响 TS，进程隔离。
- **维度陷阱**：embedding 模型维度不同（384/1024/1536），切换必须清库重建——代码里 `OpenAICompatibleEmbeddingProvider` 有维度校验兜底。

## 约定

- 本项目所有文档与代码统一放本目录 `RAG_libraries/`。
- 前后端契约以 `shared/contract.ts` 为唯一事实源，Agent 不得自创字段。
- 记忆文件（`.workbuddy/memory/`）随代码一起 commit。
- 端口冲突：先 `netstat -ano | findstr :<port>` 查 PID，`taskkill /PID <id> /F` 关不掉才换端口。
