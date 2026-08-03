import { API_PREFIX } from "@rag/shared";

/**
 * M1 占位页：只渲染标题 + 空表单，不实现任何 RAG 功能。
 * 从 shared/contract 引入 API_PREFIX（value import），
 * 用于验证跨目录引用在 Vite dev/build 与 vitest 下都能解析。
 */
function App() {
  return (
    <main className="app">
      <h1>RAG 知识库问答</h1>
      <p className="hint">
        占位页 · 后端端点前缀：{API_PREFIX}（M2 起填充 RAG 能力）
      </p>
      <form className="chat-form" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="question">向知识库提问</label>
        <input
          id="question"
          name="question"
          type="text"
          placeholder="请输入问题（M2 实现）"
          disabled
        />
        <button type="submit" disabled>
          发送
        </button>
      </form>
    </main>
  );
}

export default App;
