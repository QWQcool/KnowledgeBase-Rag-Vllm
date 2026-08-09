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
  /** 思考过程文本（思考模式时先于 text 流式到达） */
  thinking?: string;
  sources?: SourceRef[];
  isStreaming?: boolean;
  /** 首 token 延迟（TTFT，ms）——前端计时，首个 token 事件时记录 */
  ttftMs?: number | null;
  /** 总耗时（ms）——done 事件到达时记录 */
  elapsedMs?: number | null;
}

/** 一次对话（历史记录持久化到 localStorage） */
interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
}

/** 模型信息（来自 llama-server /v1/models） */
interface ModelInfo {
  id: string;
  meta?: {
    n_params?: number;
    n_ctx?: number;
    n_ctx_train?: number;
    n_embd?: number;
    ftype?: string;
    size?: number;
  } | null;
}

/** 对话框（弹窗）打开状态 */
interface ModalState {
  type: "model" | "mcp" | null;
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

/** localStorage 历史对话 key */
const CONV_KEY = "rag.conversations.v1";

/** 读历史对话（防 JSON 损坏） */
function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 数值格式化：参数 → 十亿单位，字节 → GB */
function fmtParams(n?: number): string {
  if (!n) return "未知";
  return `${(n / 1e9).toFixed(2)}B`;
}
function fmtBytes(n?: number): string {
  if (!n) return "未知";
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * M5 美化版 v2 · 初音风格 · 贴近 llama Web UI
 * - 模型信息弹窗（点击模型名 → GET /api/model）
 * - 侧栏历史对话（localStorage 持久化）+ 新建对话 + 可折叠
 * - MCP 服务器面板（GET /api/mcp-tools）
 */
function App() {
  const [question, setQuestion] = useState("");
  const [kbId, setKbId] = useState("default");
  const [state, setState] = useState<AnswerState>(INITIAL);
  const [theme, setTheme] = useState<Theme>("system");
  /** 思考模式开关（true=先思考再回答，缺省开） */
  const [thinking, setThinking] = useState(true);
  /** 历史对话列表 */
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversations(),
  );
  /** 当前对话 id（null = 未命名/欢迎页） */
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  /** 侧栏是否折叠 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** 弹窗 */
  const [modal, setModal] = useState<ModalState>({ type: null });
  /** 模型信息数据 */
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  /** MCP 工具数据 */
  const [mcpData, setMcpData] = useState<{
    servers: { name: string; status: string; tools: { name: string; description: string }[] }[];
  } | null>(null);
  /** 弹窗加载态 */
  const [modalLoading, setModalLoading] = useState(false);
  /** 文档上传：文件名 / 上传中 / 最近结果 */
  const [uploadFileName, setUploadFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  /** 拖拽高亮 */
  const [dragOver, setDragOver] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  /** 持久化历史对话 */
  useEffect(() => {
    try {
      localStorage.setItem(CONV_KEY, JSON.stringify(conversations));
    } catch {
      /* 存储满/隐私模式忽略 */
    }
  }, [conversations]);

  /** 保存当前对话（消息变化时更新历史记录） */
  const saveActiveConversation = useCallback(
    (messages: ChatMessage[]) => {
      setConversations((prev) => {
        if (!activeConvId) return prev;
        const firstUser = messages.find((m) => m.role === "user");
        return prev.map((c) =>
          c.id === activeConvId
            ? {
                ...c,
                title: firstUser?.text.slice(0, 20) || c.title,
                messages,
              }
            : c,
        );
      });
    },
    [activeConvId],
  );

  /** 新建对话 */
  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
    setActiveConvId(null);
    setQuestion("");
  }, []);

  /** 打开历史对话 */
  const openConversation = useCallback(
    (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return;
      abortRef.current?.abort();
      setState({
        ...INITIAL,
        messages: conv.messages.map((m) => ({ ...m, isStreaming: false })),
      });
      setActiveConvId(id);
      setQuestion("");
    },
    [conversations],
  );

  /** 删除历史对话 */
  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === activeConvId) {
      setState(INITIAL);
      setActiveConvId(null);
    }
  }, [activeConvId]);

  /** 上传文档到知识库（md/txt/pdf，经 /api/ingest 入库） */
  const uploadDocument = useCallback(
    async (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!["md", "txt", "pdf"].includes(ext)) {
        setUploadResult({
          ok: false,
          text: `不支持 .${ext}，仅支持 md / txt / pdf`,
        });
        return;
      }
      setUploadFileName(file.name);
      setUploading(true);
      setUploadResult(null);
      try {
        // 统一用 latin1 字符串承载内容：与后端 Buffer.from(content, "latin1")
        // 完全对齐（md/txt 的 ASCII/UTF-8 文本在 latin1 下字节不变，PDF 二进制可无损还原）
        const buf = await file.arrayBuffer();
        const content = new TextDecoder("latin1").decode(buf);
        const res = await fetch(`${API_BASE}/api/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, content, knowledgeBaseId: kbId }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const issues = body?.issues?.map((i: { message: string }) => i.message).join("; ");
          setUploadResult({ ok: false, text: `上传失败 (${res.status})${issues ? `：${issues}` : ""}` });
          return;
        }
        const chunkCount = body?.chunkCount ?? body?.chunks?.length ?? 0;
        const title = body?.document?.title ?? file.name;
        setUploadResult({
          ok: true,
          text: `「${title}」已入库 ✓（${chunkCount} 个分块，知识库 ${kbId}）`,
        });
      } catch (err) {
        setUploadResult({
          ok: false,
          text: `上传出错：${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setUploading(false);
      }
    },
    [kbId],
  );

  /** 文件选择框 change 处理 */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void uploadDocument(file);
      e.target.value = ""; // 允许重复选择同一文件
    },
    [uploadDocument],
  );

  /** 拖拽上传 */
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void uploadDocument(file);
    },
    [uploadDocument],
  );

  /** 加载模型信息（点击模型名触发） */
  const openModelInfo = useCallback(async () => {
    setModal({ type: "model" });
    setModalLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/model`);
      if (!res.ok) {
        setModelInfo(null);
      } else {
        setModelInfo((await res.json()) as ModelInfo);
      }
    } catch {
      setModelInfo(null);
    } finally {
      setModalLoading(false);
    }
  }, []);

  /** 加载 MCP 工具列表 */
  const openMcpPanel = useCallback(async () => {
    setModal({ type: "mcp" });
    setModalLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/mcp-tools`);
      if (res.ok) {
        setMcpData(await res.json());
      } else {
        setMcpData(null);
      }
    } catch {
      setMcpData(null);
    } finally {
      setModalLoading(false);
    }
  }, []);

  const send = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;

      // 首次提问自动创建对话
      if (!activeConvId) {
        const newId = `conv-${Date.now()}`;
        setActiveConvId(newId);
        setConversations((prev) => [
          { id: newId, title: trimmed.slice(0, 20), createdAt: Date.now(), messages: [] },
          ...prev,
        ]);
      }

      setState((prev) => {
        const msgs = [
          ...prev.messages,
          { role: "user" as const, text: trimmed },
          { role: "assistant" as const, text: "", sources: [], isStreaming: true },
        ];
        return { ...prev, error: null, expanded: new Set(), sourcesCollapsed: false, loading: true, messages: msgs };
      });
      setQuestion("");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // 记录请求发出时刻（TTFT 计时起点）
        const reqStart = Date.now();
        const res = await fetch(`${API_BASE}${STREAM_QUERY_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed, knowledgeBaseId: kbId, thinking }),
          signal: controller.signal,
        });

        if (res.status === 422) {
          setState((prev) => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, text: "问题不能为空", isStreaming: false };
            }
            saveActiveConversation(msgs);
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
            saveActiveConversation(msgs);
            return { ...prev, messages: msgs, loading: false, error: "无法连接后端" };
          });
          return;
        }

        // SSE 解析
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let text = "";
        let thinkingText = "";
        let sources: SourceRef[] = [];
        let done = false;
        let errMsg: string | null = null;
        let doneMessage: string | undefined;
        /** 首 token 延迟（TTFT，ms）：从请求发出到第一个正式回答 token */
        let ttft: number | null = null;
        let elapsed: number | null = null;

        const flush = (ev: StreamingEvent) => {
          if (ev.type === "sources") sources = ev.sources;
          else if (ev.type === "thinking") thinkingText += ev.delta;
          else if (ev.type === "token") {
            if (ttft === null) ttft = Date.now() - reqStart;
            text += ev.delta;
          }
          else if (ev.type === "done") { done = true; doneMessage = ev.message; elapsed = ev.elapsedMs ?? Date.now() - reqStart; }
          else if (ev.type === "error") { done = true; errMsg = ev.message; }

          setState((prev) => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              const finalText =
                errMsg === null && done && text === "" && doneMessage
                  ? doneMessage
                  : text;
              msgs[msgs.length - 1] = {
                ...last,
                text: finalText,
                thinking: thinkingText || last.thinking,
                sources: sources.length > 0 ? sources : last.sources,
                isStreaming: !done,
                ttftMs: ttft,
                elapsedMs: elapsed,
              };
            }
            const next = { ...prev, messages: msgs, loading: !done, error: errMsg };
            // 完成后持久化
            if (done) saveActiveConversation(msgs);
            return next;
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
          saveActiveConversation(msgs);
          return { ...prev, messages: msgs, loading: false, error: "无法连接后端" };
        });
      }
    },
    [kbId, activeConvId, saveActiveConversation, thinking],
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

  const closeModal = () => {
    setModal({ type: null });
    setModelInfo(null);
    setMcpData(null);
  };

  return (
    <div className="app">
      {/* 侧栏 */}
      <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        {/* 折叠开关 */}
        <button
          className="sidebar-collapse-btn"
          onClick={() => setSidebarCollapsed((v) => !v)}
          aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
        >
          {sidebarCollapsed ? "»" : "«"}
        </button>

        {!sidebarCollapsed && (
          <>
            <div className="sidebar-header">
              <div className="miku-icon">♪</div>
              <div>
                <h1 className="sidebar-title">RAG 知识库</h1>
                <p className="sidebar-subtitle">Powered by Qwen3-8B</p>
              </div>
            </div>

            {/* 新建对话 */}
            <button className="new-conv-btn" onClick={newConversation}>
              <span className="new-conv-icon">✎</span> 新建对话
            </button>

            {/* 历史对话 */}
            <div className="sidebar-section">
              <label className="sidebar-label">历史对话</label>
              <div className="conv-list">
                {conversations.length === 0 && (
                  <div className="conv-empty">暂无历史对话</div>
                )}
                {conversations.map((c) => (
                  <div
                    key={c.id}
                    className={`conv-item${c.id === activeConvId ? " active" : ""}`}
                    onClick={() => openConversation(c.id)}
                  >
                    <span className="conv-title">{c.title}</span>
                    <button
                      className="conv-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteConversation(c.id);
                      }}
                      aria-label="删除对话"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="sidebar-section">
              <label className="sidebar-label">知识库 ID</label>
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

            {/* 文档上传（md/txt/pdf → /api/ingest 入库） */}
            <div className="sidebar-section">
              <label className="sidebar-label">上传文档</label>
              <label
                className={`upload-drop${dragOver ? " drag-over" : ""}${uploading ? " uploading" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <input
                  type="file"
                  accept=".md,.txt,.pdf"
                  onChange={handleFileChange}
                  disabled={uploading}
                  style={{ display: "none" }}
                  aria-label="选择文档上传"
                />
                <span className="upload-icon">{uploading ? "⏳" : "⇪"}</span>
                <span className="upload-hint">
                  {uploading
                    ? `上传中：${uploadFileName}…`
                    : "点击或拖拽文件（md/txt/pdf）"}
                </span>
              </label>
              {uploadResult && (
                <div className={`upload-result${uploadResult.ok ? " ok" : " fail"}`}>
                  {uploadResult.text}
                </div>
              )}
            </div>

            <div className="sidebar-section">
              <label className="sidebar-label">思考模式</label>
              <button
                type="button"
                className={`thinking-toggle${thinking ? " on" : ""}`}
                onClick={() => setThinking((v) => !v)}
                disabled={busy}
                aria-pressed={thinking}
                title="开启后模型先思考再回答（更慢但更严谨）；关闭后直接回答（更快）"
              >
                <span className="thinking-toggle-track">
                  <span className="thinking-toggle-thumb" />
                </span>
                <span className="thinking-toggle-label">
                  {thinking ? "已开启" : "已关闭"}
                </span>
              </button>
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

            {/* 模型信息 + MCP 入口 */}
            <div className="sidebar-section">
              <label className="sidebar-label">系统</label>
              <button className="side-link" onClick={openModelInfo}>
                <span className="side-link-icon">◈</span> 模型信息
              </button>
              <button className="side-link" onClick={openMcpPanel}>
                <span className="side-link-icon">⇄</span> MCP 服务器
              </button>
            </div>

            <div className="sidebar-info">
              本地大模型推理<br />TS 全栈 + C++ llama.cpp<br />检索命中率 100%
            </div>
          </>
        )}
      </aside>

      {/* 主聊天区 */}
      <main className="chat-main">
        <div className="chat-messages">
          {state.messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-icon">♪</div>
              <h2 className="welcome-title">向知识库提问</h2>
              <p className="welcome-subtitle">基于本地文档的 RAG 问答 · 回答可溯源</p>
              <div className="welcome-tips">
                {QUICK_QUESTIONS.map((q) => (
                  <button key={q} className="welcome-tip" onClick={() => send(q)} disabled={busy}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {state.messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <div className="msg-avatar">{msg.role === "user" ? "你" : "♪"}</div>
              <div className="msg-bubble">
                {msg.role === "assistant" && msg.thinking ? (
                  <details className="thinking-box" open={msg.isStreaming && !msg.text}>
                    <summary className="thinking-summary">
                      <span className="thinking-icon">🧠</span>
                      {msg.isStreaming && !msg.text ? "思考中…" : "思考过程"}
                    </summary>
                    <div className="thinking-content">{msg.thinking}</div>
                  </details>
                ) : null}
                {msg.isStreaming && msg.text === "" ? (
                  <div className="typing-indicator">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </div>
                ) : (
                  msg.text
                )}
                {/* 性能指标：TTFT + 总耗时（done 后显示） */}
                {msg.role === "assistant" && !msg.isStreaming && msg.ttftMs !== null && msg.ttftMs !== undefined && (
                  <div className="msg-metrics">
                    {msg.ttftMs !== null && <>首字 {msg.ttftMs}ms</>}
                    {msg.elapsedMs !== null && msg.elapsedMs !== undefined && (
                      <> · 总耗 {(msg.elapsedMs / 1000).toFixed(2)}s</>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {showSources && (
            <div className="sources">
              <button className="sources-toggle" onClick={toggleSourcesCollapse}>
                <span className={`arrow${state.sourcesCollapsed ? "" : " open"}`}>▸</span>
                引用来源（{lastMessage!.sources!.length}）
              </button>
              {!state.sourcesCollapsed && (
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
                            <span className="source-score">{s.score.toFixed(2)}</span>
                          )}
                          <span className="source-toggle">{open ? "收起" : "展开"}</span>
                        </button>
                        {open && <pre className="source-snippet">{s.snippet}</pre>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {state.error && (
          <div className="error" role="alert" style={{ margin: "0 2rem 0.5rem" }}>
            {state.error}
          </div>
        )}

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

      {/* 模型信息弹窗 */}
      {modal.type === "model" && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>模型信息</h3>
              <button className="modal-close" onClick={closeModal}>×</button>
            </div>
            <div className="modal-body">
              {modalLoading ? (
                <div className="typing-indicator">
                  <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
                </div>
              ) : modelInfo ? (
                <div className="model-info">
                  <div className="model-name" onClick={openModelInfo}>
                    ◈ {modelInfo.id.split("/").pop()?.replace(".gguf", "")}
                  </div>
                  <div className="model-grid">
                    <div className="model-cell">
                      <span className="model-k">参数</span>
                      <span className="model-v">{fmtParams(modelInfo.meta?.n_params)}</span>
                    </div>
                    <div className="model-cell">
                      <span className="model-k">量化</span>
                      <span className="model-v">{modelInfo.meta?.ftype ?? "未知"}</span>
                    </div>
                    <div className="model-cell">
                      <span className="model-k">上下文</span>
                      <span className="model-v">{modelInfo.meta?.n_ctx ?? "未知"} tokens</span>
                    </div>
                    <div className="model-cell">
                      <span className="model-k">文件大小</span>
                      <span className="model-v">{fmtBytes(modelInfo.meta?.size)}</span>
                    </div>
                    <div className="model-cell">
                      <span className="model-k">训练上下文</span>
                      <span className="model-v">{modelInfo.meta?.n_ctx_train ?? "未知"}</span>
                    </div>
                    <div className="model-cell">
                      <span className="model-k">隐藏维度</span>
                      <span className="model-v">{modelInfo.meta?.n_embd ?? "未知"}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="modal-error">无法获取模型信息，请确认 llama-server 已启动</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MCP 弹窗 */}
      {modal.type === "mcp" && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>MCP 服务器</h3>
              <button className="modal-close" onClick={closeModal}>×</button>
            </div>
            <div className="modal-body">
              {modalLoading ? (
                <div className="typing-indicator">
                  <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
                </div>
              ) : mcpData && mcpData.servers.length > 0 ? (
                mcpData.servers.map((srv) => (
                  <div key={srv.name} className="mcp-server">
                    <div className="mcp-server-head">
                      <span className="mcp-dot" />
                      <span className="mcp-name">{srv.name}</span>
                      <span className="mcp-status">{srv.status}</span>
                    </div>
                    <div className="mcp-tools">
                      {srv.tools.map((t) => (
                        <div key={t.name} className="mcp-tool">
                          <span className="mcp-tool-name">{t.name}</span>
                          <span className="mcp-tool-desc">{t.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="modal-error">无法获取 MCP 工具列表</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
