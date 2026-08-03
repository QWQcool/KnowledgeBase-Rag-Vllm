import { defineConfig } from "vitest/config";

export default defineConfig({
  // 放行跨目录引用 ../shared/contract.ts
  // （Vite/Vitest 的 fs.allow 默认只允许工作区根，测试共享契约文件会 403）
  server: {
    fs: {
      allow: [".."],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
