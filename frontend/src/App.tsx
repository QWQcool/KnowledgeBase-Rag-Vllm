import { useState, useRef, useCallback, useEffect } from "react";
import {
  STREAM_QUERY_PATH,
  type SourceRef,
  type StreamingEvent,
} from "@rag/shared";
import "./App.css";

/** dev 环境用相对路径，缺省空串即同源（Vite proxy 代理 /api → 后端 3000） */
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

/** 三态主题（沿用 churn 规范：system/light/dark） */
type Theme = "system" | "light" | "dark";
const THEMES: { key: Theme; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "亮色" },
  { key: "dark", label: "暗色" },
];

/** 单条消息（用户或 AI） */
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: SourceRef[];
  isStreaming?: boolean;
}

interface AnswerState {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  /** 展开了 snippet 的 documentId 集合 */
  expanded: Set<string>;
  /** 引用来源是否折叠 */
  sourcesCollapsed: boolean;
}

const INITIAL: AnswerState = {
  messages: [],
  loading: false,
  error: null,
  expanded: new Set(),
  sourcesCollapsed: false,
};

/** 欢迎页快捷问题 */
const QUICK_QUESTIONS = [
  "什么是RAG？",
  "为什么后端选 TypeScript 而不是 Python？",
  "向量检索是什么？",
  "RAG 有什么优势？",
];

/**
 * M5 美化版 · 聊天式布局 · 初音风格
 * - 侧栏（知识库ID + 主题切换 + 信息）
 * - 消息列表（用户/AI 气泡 + 引用折叠 + 打字指示器）
 * - 底部输入栏
 */
function App() {
  const [question, setQuestion] = useState("");
  const [kbId, setKbId] = useState("default");
  const [state, setState] = useState<AnswerState>(INITIAL);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  /** 自动滚动到底部（jsdom 无 scrollIntoView，加守卫） */
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [state.messages, scrollToBottom]);

  const send = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;

      // 添加用户消息，准备接收 AI 回复
      setState((prev) => ({
        ...prev,
        error: null,
        expanded: new Set(),
        sourcesCollapsed: false,
        loading: true,
        messages: [
          ...prev.messages,
          { role: "user", text: trimmed },
          { role: "assistant", text: "", sources: [], isStreaming: true },
        ],
      }));
      setQuestion("");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`${API_BASE}${STREAM_QUERY_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: trimmed,
            knowledgeBaseId: kbId,
          }),
          signal: controller.signal,
        });

        if (res.status === 422) {
          setState((prev) => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, text: "问题不能为空", isStreaming: false };
            }
            return { ...prev, messages: msgs, loading: false, error: "问题不能为空" };
          });
          return;
        }
        if (!res.ok || !res.body) {
          setState((prev) => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, text: "无法连接后端，请检查服务是否启动", isStreaming: false };
            }
            return { ...prev, messages: msgs, loading: false, error: "无法连接后端" };
          });
          return;
        }

        // SSE 解析
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let text = "";
        let sources: SourceRef[] = [];
        let done = false;
        let errMsg: string | null = null;
        let doneMessage: string | undefined;

        const flush = (ev: StreamingEvent) => {
          if (ev.type === "sources") {
            sources = ev.sources;
          } else if (ev.type === "token") {
            text += ev.delta;
          } else if (ev.type === "done") {
            done = true;
            doneMessage = ev.message;
          } else if (ev.type === "error") {
            done = true;
            errMsg = ev.message;
          }

          // 增量更新最后一条 AI 消息
          setState((prev) => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              const finalText = (errMsg === null && done && text === "" && doneMessage)
                ? doneMessage
                : text;
              msgs[msgs.length - 1] = {
                ...last,
                text: finalText,
                sources: sources.length > 0 ? sources : last.sources,
                isStreaming: !done,
              };
            }
            return { ...prev, messages: msgs, loading: !done, error: errMsg };
          });
        };

        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = frame.trim();
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const ev = JSON.parse(jsonStr) as StreamingEvent;
              flush(ev);
            } catch {
              // 忽略无法解析的帧
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setState((prev) => {
          const msgs = [...prev.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, text: "无法连接后端，请检查服务是否启动", isStreaming: false };
          }
          return { ...prev, messages: msgs, loading: false, error: "无法连接后端" };
        });
      }
    },
    [kbId],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(question);
  };

  const toggleSource = (docId: string) => {
    setState((prev) => {
      const next = new Set(prev.expanded);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return { ...prev, expanded: next };
    });
  };

  const toggleSourcesCollapse = () => {
    setState((prev) => ({ ...prev, sourcesCollapsed: !prev.sourcesCollapsed }));
  };

  const busy = state.loading;
  const lastMessage = state.messages[state.messages.length - 1];
  const showSources = lastMessage?.sources && lastMessage.sources.length > 0;

  return (
    <div className="app">
      {/* 侧栏 */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="miku-icon">♪</div>
          <div>
            <h1 className="sidebar-title">RAG 知识库</h1>
            <p className="sidebar-subtitle">Powered by Qwen3-8B</p>
          </div>
        </div>

        <div className="sidebar-section">
          <label className="sidebar-label" htmlFor="kbId">知识库 ID</label>
          <input
            id="kbId"
            className="kb-input"
            type="text"
            value={kbId}
            onChange={(e) => setKbId(e.target.value)}
            disabled={busy}
            placeholder="default"
          />
        </div>

        <div className="sidebar-section">
          <label className="sidebar-label">主题</label>
          <div className="theme-switch" role="group" aria-label="主题切换">
            {THEMES.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`theme-btn${theme === t.key ? " active" : ""}`}
                onClick={() => setTheme(t.key)}
                aria-pressed={theme === t.key}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-info">
          本地大模型推理<br />
          TS 全栈 + C++ llama.cpp<br />
          检索命中率 100%
        </div>
      </aside>

      {/* 主聊天区 */}
      <main className="chat-main">
        {/* 消息列表 */}
        <div className="chat-messages">
          {state.messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-icon">♪</div>
              <h2 className="welcome-title">向知识库提问</h2>
              <p className="welcome-subtitle">基于本地文档的 RAG 问答 · 回答可溯源</p>
              <div className="welcome-tips">
                {QUICK_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    className="welcome-tip"
                    onClick={() => send(q)}
                    disabled={busy}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {state.messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <div className="msg-avatar">
                {msg.role === "user" ? "你" : "♪"}
              </div>
              <div className="msg-bubble">
                {msg.isStreaming && msg.text === "" ? (
                  <div className="typing-indicator">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </div>
                ) : (
                  msg.text
                )}
              </div>
            </div>
          ))}

          {/* 引用来源（最后一条 AI 消息的） */}
          {showSources && !state.sourcesCollapsed && (
            <div className="sources">
              <button className="sources-toggle" onClick={toggleSourcesCollapse}>
                <span className="arrow open">▸</span>
                引用来源（{lastMessage!.sources!.length}）
              </button>
              <div className="sources-list">
                {lastMessage!.sources!.map((s) => {
                  const open = state.expanded.has(s.documentId);
                  return (
                    <div key={s.documentId} className="source-item">
                      <button
                        type="button"
                        className="source-head"
                        onClick={() => toggleSource(s.documentId)}
                        aria-expanded={open}
                      >
                        <span className="source-name">{s.documentName}</span>
                        {typeof s.score === "number" && (
                          <span className="source-score">
                            {s.score.toFixed(2)}
                          </span>
                        )}
                        <span className="source-toggle">{open ? "收起" : "展开"}</span>
                      </button>
                      {open && <pre className="source-snippet">{s.snippet}</pre>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {showSources && state.sourcesCollapsed && (
            <div className="sources">
              <button className="sources-toggle" onClick={toggleSourcesCollapse}>
                <span className="arrow">▸</span>
                引用来源（{lastMessage!.sources!.length}）
              </button>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* 错误提示 */}
        {state.error && (
          <div className="error" role="alert" style={{ margin: "0 2rem 0.5rem" }}>
            {state.error}
          </div>
        )}

        {/* 底部输入栏 */}
        <div className="chat-input-area">
          <form className="chat-form" onSubmit={handleSubmit}>
            <input
              className="chat-input"
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={busy}
              placeholder="向知识库提问…"
            />
            <button type="submit" className="send-btn" disabled={busy}>
              {busy ? "思考中…" : "发送"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

export default App;
