import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

describe("M1 占位页", () => {
  it("渲染标题", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "RAG 知识库问答" })).toBeTruthy();
  });

  it("渲染空表单（输入框 + 发送按钮存在）", () => {
    render(<App />);
    expect(screen.getByPlaceholderText("请输入问题（M2 实现）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });

  it("展示后端端点前缀（验证 shared/contract 跨目录 value import 可用）", () => {
    render(<App />);
    expect(screen.getByText(/\/api/)).toBeTruthy();
  });
});
