import { useState, useRef, useCallback } from "react";
import {
  STREAM_QUERY_PATH,
  type SourceRef,
  type StreamingEvent,
} from "@rag/shared";
import "./App.css";

/** dev 环境用相对路径，缺省空串即同源；可通过 VITE_API_BASE 覆盖 */
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface AnswerState {
  /** 已生成的回答文本（逐字累加） */
  text: string;
  /** 引用来源列表（sources 事件先于 token 到达） */
  sources: SourceRef[];
  /** 流是否结束（done / error） */
  finished: boolean;
  /** 错误文案，null 表示无错误 */
  error: string | null;
  /** 是否正在流式接收 */
  loading: boolean;
}

const INITIAL: AnswerState = {
  text: "",
  sources: [],
  finished: false,
  error: null,
  loading: false,
};

/**
 * M3 流式问答页：
 * - 表单提交后 POST /api/query/stream，SSE 流式接收
 * - sources 先到 → 渲染引用列表；token → 逐字累加；done → 结束；error → 友好文案
 * - 任何错误态都不白屏，可重新输入发送
 */
function App() {
  const [question, setQuestion] = useState("");
  const [kbId, setKbId] = useState("default");
  const [answer, setAnswer] = useState<AnswerState>(INITIAL);
  /** 展开了 snippet 的 documentId 集合 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 中断控制器引用，便于组件卸载时取消（预留） */
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = question.trim();
      if (!q) {
        setAnswer({ ...INITIAL, error: "问题不能为空", finished: true });
        return;
      }
      // 重置状态
      setExpanded(new Set());
      setAnswer({ ...INITIAL, loading: true });
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`${API_BASE}${STREAM_QUERY_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: q,
            knowledgeBaseId: kbId,
          }),
          signal: controller.signal,
        });

        if (res.status === 422) {
          setAnswer({
            ...INITIAL,
            finished: true,
            error: "问题不能为空",
          });
          return;
        }
        if (!res.ok || !res.body) {
          setAnswer({
            ...INITIAL,
            finished: true,
            error: "无法连接后端，请检查服务是否启动",
          });
          return;
        }

        // SSE 解析：按 `data: ...\n\n` 分帧
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let text = "";
        let sources: SourceRef[] = [];
        let done = false;
        let errMsg: string | null = null;
        let doneMessage: string | undefined;

        // 增量更新视图：每解析到一条事件就 setState 一次
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
          setAnswer({
            text,
            sources,
            finished: done,
            error: errMsg,
            loading: !done,
          });
        };

        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          // 按 SSE 帧分隔符切分
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
              // 忽略无法解析的帧，保证流不中断
            }
          }
        }

        // 流结束后：若回答为空且 done.message 存在，把提示作为回答文案
        if (errMsg === null && done && text === "" && doneMessage) {
          setAnswer({
            text: doneMessage,
            sources,
            finished: true,
            error: null,
            loading: false,
          });
        }
      } catch (err) {
        // 网络失败 / abort
        if ((err as Error)?.name === "AbortError") return;
        setAnswer({
          ...INITIAL,
          finished: true,
          error: "无法连接后端，请检查服务是否启动",
        });
      }
    },
    [question, kbId],
  );

  const toggleSource = (docId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const busy = answer.loading;

  return (
    <main className="app">
      <h1>RAG 知识库问答</h1>

      <form className="chat-form" onSubmit={send}>
        <label htmlFor="kbId">知识库 ID</label>
        <input
          id="kbId"
          name="kbId"
          type="text"
          value={kbId}
          onChange={(e) => setKbId(e.target.value)}
          disabled={busy}
          placeholder="default"
        />
        <label htmlFor="question">向知识库提问</label>
        <input
          id="question"
          name="question"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
          placeholder="请输入问题"
        />
        <button type="submit" disabled={busy}>
          {busy ? "思考中…" : "发送"}
        </button>
      </form>

      {answer.error && (
        <div className="error" role="alert">
          {answer.error}
        </div>
      )}

      {answer.sources.length > 0 && (
        <section className="sources" aria-label="引用来源">
          <h2>引用来源（{answer.sources.length}）</h2>
          <ul>
            {answer.sources.map((s) => {
              const open = expanded.has(s.documentId);
              return (
                <li key={s.documentId} className="source-item">
                  <button
                    type="button"
                    className="source-head"
                    onClick={() => toggleSource(s.documentId)}
                    aria-expanded={open}
                  >
                    <span className="source-name">{s.documentName}</span>
                    {typeof s.score === "number" && (
                      <span className="source-score">
                        相关度 {s.score.toFixed(2)}
                      </span>
                    )}
                    <span className="source-toggle">{open ? "收起" : "展开"}</span>
                  </button>
                  {open && <pre className="source-snippet">{s.snippet}</pre>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {answer.text && (
        <section className="answer" aria-label="回答">
          <h2>回答</h2>
          <p className="answer-text">{answer.text}</p>
        </section>
      )}
    </main>
  );
}

export default App;
