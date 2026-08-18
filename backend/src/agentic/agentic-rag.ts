/**
 * agentic/agentic-rag.ts —— LangGraph Agentic RAG 编排层（2026-08 新增）
 *
 * 目标：
 * - 在不推翻手写 RAG 主链路的前提下，用 LangGraph 补上「Agent 编排」能力；
 * - 保留原有 /api/query（快速线性 RAG），新增 /api/query/graph（Agent 路径）；
 * - 复用现有 RetrieveService / LLMProvider / TriviumDB / shared 契约。
 *
 * 图结构：
 *   START → route（决定走 RAG 检索还是直接通识回答）
 *             ├─ rag → retrieve（复用现有检索服务）
 *             │          → grade（LLM/规则判定检索片段是否足够相关）
 *             │              ├─ relevant → generate（带引用回答）
 *             │              └─ irrelevant → fallback（通识回答）
 *             └─ fallback → END
 *
 * 设计取舍：
 * - 默认使用 RuleBasedGraphDecisionMaker（零额外 LLM 调用，性能开销可忽略）；
 *   生产可切换 LangChainGraphDecisionMaker（ChatOpenAI + OpenAI 兼容端点），
 *   用 LLM 做路由与相关性判定，体现 Agentic RAG 的「路由 → 检索 → 判定 → 生成」编排思想。
 * - 原 /api/query 保持不动，LangGraph 层作为独立增强端点，避免影响原有 123 测试。
 */

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import {
  ChatResponse,
  type ChatRequest,
  type RetrievalHit,
  type SourceRef,
} from "@rag/shared";
import type { LLMProvider } from "../infra/types";
import type { RetrieveService } from "../query/query-service";
import { getLlmConfigField } from "../infra/config";

/* ===================== 决策接口 ===================== */

export interface RouteDecision {
  needsRag: boolean;
  reason: string;
}

export interface GradeDecision {
  relevant: boolean;
  reason: string;
}

/** 负责「路由」和「相关性判定」的决策器；测试注入假实现，生产可用 LLM 实现 */
export interface GraphDecisionMaker {
  decideRoute(question: string): Promise<RouteDecision>;
  gradeDocuments(question: string, hits: RetrievalHit[]): Promise<GradeDecision>;
}

/** 默认阈值（与 query-service 对齐） */
export const DEFAULT_MIN_SCORE = 0.85;

/**
 * 规则版决策器：
 * - 打招呼/闲聊直接走通识回答，不检索（节省一次 LLM 调用）；
 * - 检索后按 minScore 阈值判定相关性。
 * 用于默认生产（零额外 LLM 开销）和测试（确定性）。
 */
export class RuleBasedGraphDecisionMaker implements GraphDecisionMaker {
  constructor(private readonly minScore = DEFAULT_MIN_SCORE) {}

  async decideRoute(question: string): Promise<RouteDecision> {
    const trimmed = question.trim();
    if (/^(你好|您好|hi|hello|hey|谢谢|感谢|再见|拜拜)/i.test(trimmed)) {
      return { needsRag: false, reason: "rule: trivial greeting, skip retrieval" };
    }
    return { needsRag: true, reason: "rule: default to RAG" };
  }

  async gradeDocuments(_question: string, hits: RetrievalHit[]): Promise<GradeDecision> {
    if (hits.length === 0) {
      return { relevant: false, reason: "rule: no hits" };
    }
    const maxScore = Math.max(...hits.map((h) => h.score));
    if (maxScore >= this.minScore) {
      return { relevant: true, reason: `rule: max score ${maxScore.toFixed(3)} >= ${this.minScore}` };
    }
    return { relevant: false, reason: `rule: max score ${maxScore.toFixed(3)} < ${this.minScore}` };
  }
}

/**
 * LangChain 版决策器：用 ChatOpenAI 调 OpenAI 兼容端点（Ollama / llama.cpp / vLLM）。
 * - 路由：让模型判断当前问题是否需要查知识库；
 * - 相关性：让模型判断检索到的片段是否足以回答。
 * 这是「LangGraph + LangChain」在项目里的真实落点。
 */
export class LangChainGraphDecisionMaker implements GraphDecisionMaker {
  private readonly model: ChatOpenAI;

  constructor(config: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  } = {}) {
    // 智谱 Key 兼容：ZHIPUAI_API_KEY（DeepSeek_Harness/.env 中已有）或 ZHIPU_API_KEY
    const zhipuApiKey =
      process.env.ZHIPUAI_API_KEY ?? process.env.ZHIPU_API_KEY;

    // 是否已显式指定 LangChain 决策器的专属配置
    // 只要显式指定了，就完全按用户配置走；否则检测到智谱 Key 时整套默认走 GLM-4-Flash
    const hasGraphOverride = Boolean(
      process.env.RAG_GRAPH_LLM_BASE_URL ||
      process.env.RAG_GRAPH_LLM_MODEL ||
      process.env.RAG_GRAPH_LLM_API_KEY ||
      config.baseUrl ||
      config.model ||
      config.apiKey,
    );
    const useZhipuAuto = !hasGraphOverride && Boolean(zhipuApiKey);

    // 优先级：
    // RAG_GRAPH_LLM_* 专属环境变量 > 构造参数 > 智谱 GLM-4-Flash（自动） > llm-config.json
    // > 通用 OPENAI_* 环境变量 > 本地 Ollama
    // 注意：ChatOpenAI 的 baseURL 需要保留 /v1 或 /v4，SDK 会再拼 /chat/completions
    const baseUrl = (
      process.env.RAG_GRAPH_LLM_BASE_URL ??
      config.baseUrl ??
      (useZhipuAuto
        ? "https://open.bigmodel.cn/api/paas/v4"
        : getLlmConfigField("baseUrl") ??
          process.env.OPENAI_BASE_URL ??
          "http://127.0.0.1:11434/v1")
    ).replace(/\/+$/, "");

    this.model = new ChatOpenAI({
      model:
        process.env.RAG_GRAPH_LLM_MODEL ??
        config.model ??
        (useZhipuAuto
          ? "glm-4-flash"
          : getLlmConfigField("model") ??
            process.env.OPENAI_MODEL ??
            "qwen3:8b"),
      apiKey:
        process.env.RAG_GRAPH_LLM_API_KEY ??
        config.apiKey ??
        (useZhipuAuto
          ? zhipuApiKey
          : getLlmConfigField("apiKey") ??
            process.env.OPENAI_API_KEY ??
            "ollama"),
      temperature: 0,
      configuration: { baseURL: baseUrl },
    });
  }

  async decideRoute(question: string): Promise<RouteDecision> {
    try {
      const parsed = await this.askJson(
        "你是 RAG 系统的路由决策器。只输出 JSON，不要解释。",
        `判断以下用户问题是否需要检索知识库才能回答。\n` +
          `- 如果问题是常识、闲聊、问候、或不需要外部资料即可回答，输出 {"needsRag": false, "reason": "简短原因"}\n` +
          `- 如果问题涉及具体文档、项目、技术细节，需要检索知识库，输出 {"needsRag": true, "reason": "简短原因"}\n\n` +
          `用户问题：${question}`,
      );
      return {
        needsRag: parsed.needsRag === true,
        reason: typeof parsed.reason === "string" ? parsed.reason : "llm: route",
      };
    } catch {
      // LLM 解析失败时降级为规则：默认走 RAG（宁肯多检索，不漏答）
      return { needsRag: true, reason: "llm fallback: default to RAG" };
    }
  }

  async gradeDocuments(question: string, hits: RetrievalHit[]): Promise<GradeDecision> {
    if (hits.length === 0) {
      return { relevant: false, reason: "no hits" };
    }
    try {
      const docs = hits
        .slice(0, 3)
        .map(
          (h, i) =>
            `[${i + 1}] score=${h.score.toFixed(3)}\n${h.chunk.content.slice(0, 200)}`,
        )
        .join("\n\n");
      const parsed = await this.askJson(
        "你是 RAG 检索质量评审。只输出 JSON，不要解释。",
        `用户问题：${question}\n\n检索到的候选片段：\n${docs}\n\n` +
          `判断这些片段是否足以回答用户问题。` +
          `如果至少一个片段相关，输出 {"relevant": true, "reason": "简短原因"}；` +
          `否则输出 {"relevant": false, "reason": "简短原因"}。`,
      );
      return {
        relevant: parsed.relevant === true,
        reason: typeof parsed.reason === "string" ? parsed.reason : "llm: grade",
      };
    } catch {
      // LLM 失败时按分数阈值兜底
      const maxScore = Math.max(...hits.map((h) => h.score));
      return {
        relevant: maxScore >= DEFAULT_MIN_SCORE,
        reason: `llm fallback: max score ${maxScore.toFixed(3)}`,
      };
    }
  }

  private async askJson(system: string, user: string): Promise<Record<string, unknown>> {
    const res = await this.model.invoke([
      new SystemMessage(system),
      new HumanMessage(user),
    ]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`GraphLLM 返回非 JSON: ${text.slice(0, 200)}`);
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

/* ===================== LangGraph 状态 ===================== */

const AgentStateAnnotation = Annotation.Root({
  question: Annotation<string>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => "",
  }),
  knowledgeBaseId: Annotation<string>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => "default",
  }),
  route: Annotation<"rag" | "fallback">({
    reducer: (_prev, next) => next ?? _prev,
    default: () => "rag",
  }),
  hits: Annotation<RetrievalHit[]>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => [],
  }),
  relevant: Annotation<boolean>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => false,
  }),
  reason: Annotation<string>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => "",
  }),
  answer: Annotation<string>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => "",
  }),
  sources: Annotation<SourceRef[]>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => [],
  }),
});

type AgentState = typeof AgentStateAnnotation.State;

/* ===================== 服务与图构建 ===================== */

export interface AgenticRagService {
  query(req: ChatRequest): Promise<ChatResponse>;
}

export interface AgenticRagServiceOptions {
  retrieveService: RetrieveService;
  llmProvider: LLMProvider;
  /** 路由/相关性决策器；缺省规则版（零额外 LLM 调用） */
  decisionMaker?: GraphDecisionMaker;
  topK?: number;
  /** 规则版决策器的相关度阈值；缺省 0.85 */
  minScore?: number;
}

/** 构造 systemPrompt：与 query-service 行为一致，检索为空时提示通识兜底 */
function buildSystemPrompt(hitCount: number): string {
  if (hitCount === 0) {
    return (
      "你是知识库问答助手。本次没有在知识库中检索到相关资料（检索为空）。" +
      "请直接根据你自己的知识回答用户问题，并在回答末尾注明「知识库中未找到相关内容，以下为模型通识回答」。"
    );
  }
  return (
    "你是一个基于知识库回答问题的助手。" +
    "请优先依据用户给出的检索片段作答，回答时尽量引用片段原文。" +
    "若检索片段与问题明显不相关、或不足以回答问题（例如创作类问题只命中了无关的技术文档），" +
    "请基于你自己的知识回答，并在末尾注明「知识库片段与本问题相关性较低，以下为模型通识回答」。"
  );
}

function buildSources(hits: RetrievalHit[]): SourceRef[] {
  return hits.map((hit) => ({
    documentId: hit.chunk.documentId,
    documentName: hit.chunk.source?.title ?? `文档 ${hit.chunk.documentId}`,
    chunkIndex: hit.chunk.index,
    snippet: hit.chunk.content.slice(0, 200),
    score: Math.min(1, Math.max(0, hit.score)),
  }));
}

export function createAgenticRagService(
  opts: AgenticRagServiceOptions,
): AgenticRagService {
  const decisionMaker =
    opts.decisionMaker ?? new RuleBasedGraphDecisionMaker(opts.minScore);
  const topK = opts.topK ?? 5;

  const routeNode = async (state: AgentState) => {
    const decision = await decisionMaker.decideRoute(state.question);
    return {
      route: decision.needsRag ? ("rag" as const) : ("fallback" as const),
      reason: decision.reason,
    };
  };

  const retrieveNode = async (state: AgentState) => {
    // 不在检索层预过滤：把全部 topK 交给 grade 判定，符合 Agentic RAG 模式
    const { hits } = await opts.retrieveService.retrieve({
      question: state.question,
      knowledgeBaseId: state.knowledgeBaseId,
      topK,
    });
    return { hits };
  };

  const gradeNode = async (state: AgentState) => {
    if (state.hits.length === 0) {
      return { relevant: false, reason: "no hits" };
    }
    const grade = await decisionMaker.gradeDocuments(state.question, state.hits);
    return { relevant: grade.relevant, reason: grade.reason };
  };

  const generateNode = async (state: AgentState) => {
    const { answer } = await opts.llmProvider.generate({
      systemPrompt: buildSystemPrompt(state.hits.length),
      contextChunks: state.hits.map((hit) => ({
        content: hit.chunk.content,
        source: hit.chunk.source?.title ?? hit.chunk.documentId,
      })),
      question: state.question,
    });
    return { answer, sources: buildSources(state.hits) };
  };

  const fallbackNode = async (state: AgentState) => {
    const { answer } = await opts.llmProvider.generate({
      systemPrompt: buildSystemPrompt(0),
      contextChunks: [],
      question: state.question,
    });
    return { answer, sources: [], reason: state.reason || "fallback" };
  };

  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("router", routeNode)
    .addNode("retrieve", retrieveNode)
    .addNode("grade", gradeNode)
    .addNode("generate", generateNode)
    .addNode("fallback", fallbackNode)
    .addEdge(START, "router")
    .addConditionalEdges("router", (state) =>
      state.route === "rag" ? "retrieve" : "fallback",
    )
    .addEdge("retrieve", "grade")
    .addConditionalEdges("grade", (state) =>
      state.relevant ? "generate" : "fallback",
    )
    .addEdge("generate", END)
    .addEdge("fallback", END)
    .compile();

  return {
    async query(req: ChatRequest): Promise<ChatResponse> {
      const startedAt = Date.now();
      const state = await graph.invoke({
        question: req.question,
        knowledgeBaseId: req.knowledgeBaseId,
      });

      return ChatResponse.parse({
        answer: state.answer,
        sources: state.sources,
        elapsedMs: Date.now() - startedAt,
      });
    },
  };
}

/** 生产工厂：使用 LangChain ChatOpenAI 做路由/相关性决策（可经 RAG_GRAPH_DECISION=rule|llm 切换） */
export function createProductionAgenticRagService(
  deps: Pick<AgenticRagServiceOptions, "retrieveService" | "llmProvider">,
): AgenticRagService {
  // LLM_PROVIDER=mock 时默认规则版，避免没起推理层时 graph 端点也去请求 Ollama
  const decisionMode =
    process.env.RAG_GRAPH_DECISION ??
    (process.env.LLM_PROVIDER === "mock" ? "rule" : "llm");
  const decisionMaker =
    decisionMode === "llm"
      ? new LangChainGraphDecisionMaker()
      : new RuleBasedGraphDecisionMaker();
  return createAgenticRagService({ ...deps, decisionMaker });
}
