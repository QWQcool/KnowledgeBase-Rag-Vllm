import type { LLMProvider } from "../infra/types";

/**
 * query/llm-provider.ts —— LLMProvider 接口实现（Strategy 模式）
 *
 * 只做「把检索上下文喂给模型生成回答」，不关心检索本身。
 * - MockLLMProvider：离线/测试用，确定性伪回答，从 contextChunks 里挑最相关
 *   片段拼进回答（命中已按相关度降序，故取第一条），便于集成验证「真用了检索结果」。
 * - OpenAICompatibleLLMProvider：标准 OpenAI 兼容协议（POST /v1/chat/completions），
 *   baseURL / 模型名 / apiKey 从环境变量读取，不硬编码密钥。
 */

/** Mock：从 contextChunks 挑最相关片段拼进回答模板 */
export class MockLLMProvider implements LLMProvider {
  async generate(params: {
    systemPrompt: string;
    contextChunks: { content: string; source: string }[];
    question: string;
  }): Promise<{ answer: string }> {
    const { contextChunks, question } = params;

    if (contextChunks.length === 0) {
      return { answer: "（Mock）未检索到相关内容，无法回答该问题。" };
    }

    // 命中已按相关度降序排列 → 第一条即最相关片段
    const best = contextChunks[0];
    const excerpt = best.content.trim().slice(0, 100);
    return {
      answer:
        `基于检索到的 ${contextChunks.length} 个片段，针对「${question}」的模拟回答：\n` +
        `"${excerpt}"\n` +
        `（片段来源：${best.source}）`,
    };
  }
}

export interface OpenAICompatibleLLMConfig {
  /** 如 https://api.openai.com/v1 或 http://localhost:8080/v1（llama-server） */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** OpenAI 兼容协议实现：fetch POST /v1/chat/completions */
export class OpenAICompatibleLLMProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(config: OpenAICompatibleLLMConfig = {}) {
    // 优先显式配置，其次环境变量；不带 /v1 尾巴，统一在请求时拼
    this.baseUrl = (config.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    this.model = config.model ?? process.env.OPENAI_MODEL ?? "";
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  }

  async generate(params: {
    systemPrompt: string;
    contextChunks: { content: string; source: string }[];
    question: string;
  }): Promise<{ answer: string }> {
    const { systemPrompt, contextChunks, question } = params;

    if (!this.model) {
      throw new Error("未配置模型名：请设置 OPENAI_MODEL 环境变量");
    }

    const contextText =
      contextChunks.length === 0
        ? "（未检索到相关资料）"
        : contextChunks
            .map((c, i) => `[片段${i + 1}] ${c.content}`)
            .join("\n\n");

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `以下是检索到的参考资料：\n${contextText}\n\n用户问题：${question}`,
      },
    ];

    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, messages, temperature: 0.2 }),
    });
    if (!res.ok) {
      throw new Error(`LLM API 请求失败 ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== "string") {
      throw new Error("LLM API 返回格式异常：缺少 choices[0].message.content");
    }
    return { answer };
  }
}

export type LLMProviderKind = "mock" | "openai";

/** 工厂：按配置切换实现（缺省 mock，可经 LLM_PROVIDER 环境变量覆盖） */
export function createLLMProvider(
  kind?: LLMProviderKind,
): LLMProvider {
  const resolved: string = kind ?? process.env.LLM_PROVIDER ?? "mock";
  switch (resolved) {
    case "mock":
      return new MockLLMProvider();
    case "openai":
      return new OpenAICompatibleLLMProvider();
    default:
      throw new Error(`未知的 LLM_PROVIDER: ${resolved}（可选 mock / openai）`);
  }
}
