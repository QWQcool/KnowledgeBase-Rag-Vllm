import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL 测试隔离：每个用例结束后卸载 DOM，避免跨用例残留元素导致
// "Found multiple elements" 类断言误报。
afterEach(cleanup);
