# RAG 知识库问答 Web App

> 把本地文档（PDF/MD/TXT）建成知识库，在网页上提问，由大模型基于检索到的内容回答，**答案带原文引用、可溯源**。
> 这是「AI 全栈开发工程师 / Agent 编排」转型的**作品集主项目**——TS 全栈 + C++(llama.cpp) 推理层的完整 AI 应用，全程多 Agent 编排交付、TDD 门禁。

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | TypeScript + React + Vite | 问答页、知识库管理、三态主题（system/light/dark） |
| 后端 | TypeScript + Hono/Fastify | 文档摄入、检索编排、SSE 流式 |
| 推理层 | **C++ llama.cpp（llama-server）** | 本地大模型，OpenAI 兼容 HTTP API |
| 向量库 | LanceDB / sqlite-vec | 本地轻量内嵌，无原生编译坑 |
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
- [ ] M1 骨架 + 前后端契约（`shared/contract.ts` + health 端点 + TDD 就绪）
- [ ] M2 RAG 流水线（文档→chunk→embedding→入库→检索→回答）
- [ ] M3 问答体验（SSE 流式 + 引用标注 + 错误态）
- [ ] M4 C++ 推理层（llama.cpp / llama-server 接入）
- [ ] M5 验收 + 打磨 + 性能数字 + 面试手册回填

## 快速开始（当前处于 M0 → M1）

1. 打开 `01-项目规划与执行手册.md`，从 **M1 骨架 + 契约** 开始。
2. 每个里程碑：**先读 AC → 照抄「派单提示词」派 Agent → TDD 门禁（`npm test` 全绿）→ 勾掉 AC → 更新本 README 进度**。
3. 环境要求：Node 22+（前端/后端）、Git；**本地 LLM 推理层到 M4 才需要**（llama.cpp，Windows 本机运行）。
4. 面试资产：每完成一个里程碑，把真实数字（检索命中率 / tok/s / 量化档位）回填进 `02-面试学习手册.md` 的速记卡。

## 约定

- 本项目所有文档与代码统一放本目录 `RAG_libraries/`。
- 前后端契约以 `shared/contract.ts` 为唯一事实源，Agent 不得自创字段。
- 记忆文件（`.workbuddy/memory/`）随代码一起 commit。
- 端口冲突：先 `netstat -ano | findstr :<port>` 查 PID，`taskkill /PID <id> /F` 关不掉才换端口。
