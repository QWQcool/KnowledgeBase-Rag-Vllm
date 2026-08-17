// restart.ts —— 推理引擎切换后的后端自重启（2026-08-17 新增）
//
// 背景：切换推理引擎（PUT /api/llm-engine）只改写 llm-config.json，推理层是重资源进程，
// 无法热切换，此前需要用户手动重启后端。本模块让后端在响应写盘成功后自动重启自身，
// 前端配合轮询 /health 即可实现"切换 → 自动重启 → 自动恢复"的无缝体验。
//
// 时序：响应已发出 → 延迟 delayMs（保证 HTTP 响应 flush）→ spawn 新进程（同入口，detached）
//       → 旧进程立即退出。新进程启动（tsx 加载 ~1-2s）时旧进程已释放 3000 端口，避免 EADDRINUSE。
//
// 注意：生产（npm start）默认启用；测试环境（NODE_ENV=test，vitest 默认设置）由
// app.ts 的 defaultRestartScheduler 降级为 no-op，不会 spawn 真实进程。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

let scheduled = false;

/** 是否已处于重启调度中（避免并发 PUT 触发多次重启） */
export function isRestartScheduled(): boolean {
  return scheduled;
}

/**
 * 调度后端自重启。调用后 delayMs 毫秒：
 * 1. 用当前 node 进程 + tsx CLI 重新拉起自身（npm start 等价：tsx src/index.ts）
 * 2. 旧进程立即退出，让出 3000 端口
 *
 * @param delayMs 延迟毫秒，默认 600（给当前 HTTP 响应足够时间发送完成）
 */
export function scheduleSelfRestart(delayMs = 600): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    try {
      const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
      // tsx CLI 真实入口（workspaces 提升到仓库根 node_modules，createRequire 可解析）
      const tsxCli = require.resolve("tsx/cli");
      const child = spawn(process.execPath, [tsxCli, entry], {
        detached: true, // 独立进程组：父退出后子进程继续运行
        stdio: "ignore",
        cwd: process.cwd(),
        env: {
          ...process.env,
          RAG_AUTORESTARTED: "1", // 标记本次为自重启（可用于日志/监控区分）
        },
      });
      child.unref();
    } catch (err) {
      console.error("[restart] 自重启 spawn 失败：", err instanceof Error ? err.message : err);
      scheduled = false; // 允许重试
      return;
    }
    // spawn 成功后立即退出旧进程，释放端口；子进程 detached 不受影响
    process.exit(0);
  }, delayMs);
}
