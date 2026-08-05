import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 跨目录引用 ../shared/contract.ts 的关键配置：
  // Vite/Vitest 默认只允许访问工作区根目录下的文件，
  // 放行项目根（RAG_libraries/）才能让 ../shared 被 import。
  server: {
    fs: {
      allow: [".."],
    },
    // dev 时把 /api/* 代理到后端（默认 3000），前端代码用相对路径即可
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
