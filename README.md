# RAG Knowledge Base Web App

> 把本地文档（PDF/MD/TXT）建成知识库，在网页上提问，由大模型基于检索到的内容回答，**答案带原文引用、可溯源**。
> TypeScript 全栈（Node.js 后端 + React 前端 + MCP 服务），本地模型推理，全程 TDD 门禁交付。

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | TypeScript + React + Vite | 问答页、知识库管理、三态主题（system/light/dark） |
| 后端 | TypeScript + Hono/Fastify | 文档摄入、检索编排、SSE 流式 |
| 推理层 | **Ollama / llama.cpp**（OpenAI 兼容 HTTP） | 本地大模型，`LLM_PROVIDER` 环境变量可切换，零代码改动 |
| Agent 编排 | **LangGraph (TS)** + @langchain/openai | 新增 `/api/query/graph`：路由 → 检索 → 相关性判定 → 生成/兜底，复用现有检索与 LLM 服务 |
| 向量库 | **TriviumDB**（Rust 嵌入式：向量+图+文档） | 本地单文件，napi-rs 预编译绑定；替换了初版 LanceDB（Strategy 接口，业务零改动） |
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
                                    │                 │ Ollama / llama.cpp │
                                    ▼                 │ 本地大模型          │
                        ┌────────────────────┐        └────────────────────┘
                        │ TriviumDB 向量库     │
                        │ (QuIVer 索引)       │
                        └────────────────────┘
```

## 功能与设计要点

- **契约先行**：`shared/contract.ts` 为前后端唯一事实源（TS 类型 + Zod schema），接口漂移编译期拦截；流式接口分阶段推送来源引用与回复内容。
- **可替换存储**：向量库通过 Strategy 接口封装（`infra/` 下 LanceDB / TriviumDB 双实现），切换存储业务代码零改动，并重标定相似度阈值。
- **显存自适应**：`GET /api/gpu` 实时探测可用显存，自动在高中低三档（上下文长度 + GPU 层数）间降级，解决 8GB 显卡本地模型 OOM。
- **可证伪评估**：`scripts/evaluate-retrieval.mjs` 以召回/误报双指标评估检索质量，定位根因并规划改进路线（见下方「检索质量评估」）。
- **MCP 集成**：`mcp-server/` 独立 workspace，`retrieve` 工具经 MCP 协议（官方 SDK + stdio）调用后端真实检索。
- **Agentic RAG 编排**：LangGraph 状态图（路由 → 检索 → 相关性判定 → 生成/兜底），复用 `RetrieveService` / `LLMProvider` / TriviumDB，独立端点 `/api/query/graph`，可经 `RAG_GRAPH_ENABLED=0` 关闭；决策可用规则版（`RAG_GRAPH_DECISION=rule`）零额外 LLM 调用。

## 快速开始

```bash
# 1) 安装依赖（monorepo，一次装齐三端）
npm install

# 2) 跑测试（前后端）
cd backend;  npm test
cd frontend; npm test

# 3) 起后端（mock 模式，无需本地模型）
cd backend
export RAG_EMBEDDING=transformers LLM_PROVIDER=mock PORT=3000
npm run start

# 4) 起前端
cd frontend && npm run dev   # 浏览器开 http://localhost:5173
```

**本地模型模式**：安装 Ollama 后 `ollama pull qwen3:8b`，设置
`LLM_PROVIDER=openai OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_MODEL=qwen3:8b` 即可接入，后端零代码改动。
Windows 下双击 `start.bat` 选「1 默认启动」即可一键拉起推理层 + 后端 + 前端（或双击 `start-all.bat` 走命令行参数）。

> 说明：`node_modules/` 不入库（标准 Node 做法），clone 后执行 `npm install` 即可还原；`data/`（向量库落盘）、`*.gguf`（模型文件）同样在 `.gitignore` 中。

## 检索质量评估（诚实记录）

- **评估方式**：`scripts/evaluate-retrieval.mjs` 用小测试集跑召回率 / 误报率双指标，并用 `RAG_MIN_SCORE` 阈值过滤无关问句。
- **已知问题**：multilingual-e5 对中文无关问句的相似度分数普遍偏高（0.83~0.87），单一阈值无法完全区分相关/无关，小测试集下召回 50% / 误报 67%。
- **根因**：多语言 embedding 中文语义分数分布集中、最近邻与非最近邻角度差过小；属 embedding 角度分布问题，非索引层可解。
- **改进路线**：混合检索（BM25 + 向量双通道）→ 重排（rerank）→ 阈值动态化。

## LangGraph Agentic RAG（M6）

在原有线性 RAG 之外，新增一条 LangGraph 编排路径，补充「Agent 编排」能力：

```
START → router（是否检索）
         ├─ rag → retrieve（复用 TriviumDB 检索）
         │        → grade（LLM/规则判定相关性）
         │            ├─ relevant → generate（带引用回答）
         │            └─ irrelevant → fallback（通识兜底）
         └─ fallback → END
```

- 端点：`POST /api/query/graph`，请求体同 `ChatRequest`，响应同 `ChatResponse`。
- 复用：`RetrieveService`、`LLMProvider`、TriviumDB、shared 契约全部复用，未推翻原手写 RAG。
- 切换：`RAG_GRAPH_DECISION=llm`（默认，LangChain ChatOpenAI）或 `rule`（零额外 LLM 调用，规则路由 + 阈值判定）。
- 关闭：`RAG_GRAPH_ENABLED=0` 或 `false` 时不创建 LangGraph 服务，`/api/query/graph` 返回 501。
- 远程 API：`RAG_GRAPH_LLM_BASE_URL` / `RAG_GRAPH_LLM_MODEL` / `RAG_GRAPH_LLM_API_KEY` 可单独给 LangChain 决策器配远程大模型（如 OpenAI），不影响主回答的本地模型。
- 智谱免费档：设置 `ZHIPUAI_API_KEY` 后，LangGraph 决策器自动使用 `glm-4-flash`（`https://open.bigmodel.cn/api/paas/v4`），无需再配 `RAG_GRAPH_LLM_*`；模板见 `.env.example`。

## 启动器 start.bat（M7）

统一交互式启动入口，合并原 `start-all.bat` 与 `start-vllm.bat` 的使用路径：

```
1. 默认启动（推荐参数）
2. 修改相关参数启动
3. 退出
```

「修改相关参数启动」可配置：

- `推理引擎`：ollama / vllm
- `LangGraph 开关`：1 启用 / 0 关闭
- `LangGraph 决策模式`：llm（智谱/远程）/ rule（规则）
- `Embedding 模式`：transformers / openai / mock
- `相关度阈值`：默认 0.80
- `智谱 Key`：可现场输入，不显示明文；留空则继承环境变量

原 `start-all.bat` / `start-vllm.bat` 仍保留，供命令行 / 高级场景直接调用。

## 后续计划

- [x] 推理层迁移 **vLLM**：以更高吞吐与批量推理替换当前 Ollama/llama.cpp，保持 OpenAI 兼容 HTTP 边界不变（双引擎可切换）
- [x] **Agentic RAG 编排**（LangGraph）：路由 → 检索 → 判定 → 生成/兜底，独立端点 `/api/query/graph`
- [ ] 混合检索（BM25 + embedding 双通道合并）
- [ ] 检索结果重排（rerank）与阈值动态化
- [ ] 多知识库隔离增强与权限

## 测试

- 后端：`backend/` 下 vitest，覆盖摄入、分块、检索、流式、GPU 档位、Agentic RAG 等，**145 tests 全绿**
- 前端：`frontend/` 下 vitest + Testing Library，**14 tests 全绿**
- 端到端：`scripts/e2e-check.mjs` / `upload-e2e-check.mjs`

## License

MIT
