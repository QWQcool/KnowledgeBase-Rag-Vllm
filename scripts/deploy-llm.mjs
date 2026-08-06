#!/usr/bin/env node
/**
 * deploy-llm.mjs —— 一键部署本地 LLM 推理层（Windows）
 *
 * 自动完成：
 *   1. 下载 llama.cpp 预编译包（CUDA 版，N 卡用）
 *   2. 下载 CUDA 运行时 DLL
 *   3. 下载 GGUF 模型（默认 Qwen3-8B Q4_K_M，~5GB）
 *   4. 启动 llama-server
 *   5. 验证 /v1/models 端点
 *
 * 用法：
 *   node deploy-llm.mjs                    # 默认 Qwen3-8B，装到 C:\llama.cpp + C:\models
 *   node deploy-llm.mjs Qwen2.5-7B         # 指定模型
 *   node deploy-llm.mjs Qwen3-8B C:\custom # 自定义安装目录
 *
 * 前提：N 卡 + 已装 NVIDIA 驱动（nvidia-smi 可用）
 * 换模型只改 OPENAI_MODEL 环境变量，代码零改动（Adapter 模式）
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { resolve, join } from "node:path";

// ===== 配置 =====
const LLAMA_VERSION = "b10276";
const CUDA_VERSION = "12.4";

const MODELS = {
  "Qwen3-8B": {
    url: "https://hf-mirror.com/lm-kit/qwen-3-8b-instruct-gguf/resolve/main/qwen-3-8b-instruct-q4_k_m.gguf",
    file: "qwen3-8b-q4_k_m.gguf",
    size: "~5GB",
    note: "Qwen3-8B Q4_K_M，3080 10GB 显存推荐",
  },
  "Qwen2.5-7B": {
    url: "https://hf-mirror.com/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    file: "qwen2.5-7b-instruct-q4_k_m.gguf",
    size: "~4.7GB",
    note: "Qwen2.5-7B Q4_K_M，项目原始模型",
  },
  "Qwen3-4B": {
    url: "https://hf-mirror.com/SonyaCat/Qwen3-4B-Instruct-2507-q4-k-m-gguf/resolve/main/qwen3-4b-instruct-2507-q4-k-m.gguf",
    file: "qwen3-4b-instruct-2507-q4-k-m.gguf",
    size: "~2.5GB",
    note: "Qwen3-4B Q4_K_M，显存紧张时用",
  },
};

const llamaDir = "C:\\llama.cpp";
const modelsDir = "C:\\models";

const modelKey = process.argv[2] ?? "Qwen3-8B";
const model = MODELS[modelKey];
if (!model) {
  console.error(`未知模型：${modelKey}。可选：${Object.keys(MODELS).join(" / ")}`);
  process.exit(1);
}

function download(url, dest) {
  console.log(`  下载 → ${dest} (${model.size})`);
  execSync(`curl.exe -L -o "${dest}" "${url}"`, { stdio: "inherit" });
}

function fileSizeMB(path) {
  return Math.round(statSync(path).size / 1024 / 1024);
}

console.log("=== RAG 本地 LLM 推理层一键部署 ===\n");
console.log(`模型：${modelKey} (${model.note})`);
console.log(`安装目录：${llamaDir} + ${modelsDir}\n`);

// Step 1: 检查 nvidia-smi
console.log("Step 0: 检查 GPU...");
try {
  const gpu = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", { encoding: "utf8" }).trim();
  console.log(`  ✓ ${gpu}`);
} catch {
  console.error("  ✗ nvidia-smi 不可用。请确认已装 NVIDIA 驱动。");
  console.error("    核显/CPU 机器请用 Vulkan 版 llama.cpp（手动下载）。");
  process.exit(1);
}

// Step 2: 下载 llama.cpp（如已存在跳过）
console.log("\nStep 1: llama.cpp 预编译包...");
const llamaServer = join(llamaDir, "llama-server.exe");
if (existsSync(llamaServer)) {
  console.log(`  ✓ 已存在：${llamaServer}`);
} else {
  mkdirSync(llamaDir, { recursive: true });
  const binUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-win-cuda-${CUDA_VERSION}-x64.zip`;
  const cudartUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/cudart-llama-bin-win-cuda-${CUDA_VERSION}-x64.zip`;
  console.log("  下载主程序...");
  execSync(`curl.exe -L -o "${llamaDir}\\llama-bin.zip" "${binUrl}"`, { stdio: "inherit" });
  console.log("  下载 CUDA 运行时...");
  execSync(`curl.exe -L -o "${llamaDir}\\cudart.zip" "${cudartUrl}"`, { stdio: "inherit" });
  console.log("  解压...");
  execSync(`powershell -Command "Expand-Archive -Path '${llamaDir}\\llama-bin.zip' -DestinationPath '${llamaDir}' -Force"`);
  execSync(`powershell -Command "Expand-Archive -Path '${llamaDir}\\cudart.zip' -DestinationPath '${llamaDir}' -Force"`);
  console.log(`  ✓ 安装完成：${llamaServer}`);
}

// Step 3: 下载模型
console.log(`\nStep 2: GGUF 模型 (${modelKey})...`);
const modelPath = join(modelsDir, model.file);
if (existsSync(modelPath) && fileSizeMB(modelPath) > 100) {
  console.log(`  ✓ 已存在：${modelPath} (${fileSizeMB(modelPath)} MB)`);
} else {
  mkdirSync(modelsDir, { recursive: true });
  download(model.url, modelPath);
  console.log(`  ✓ 下载完成：${modelPath} (${fileSizeMB(modelPath)} MB)`);
}

// Step 4: 启动 llama-server
console.log("\nStep 3: 启动 llama-server...");
const PORT = 8080;
console.log(`  端口：${PORT}`);
console.log(`  命令：${llamaServer} --model "${modelPath}" --host 127.0.0.1 --port ${PORT} --n-gpu-layers 99 --ctx-size 4096 --embedding\n`);

const server = spawn(llamaServer, [
  "--model", modelPath,
  "--host", "127.0.0.1",
  "--port", String(PORT),
  "--n-gpu-layers", "99",
  "--ctx-size", "4096",
  "--embedding",
], { stdio: "inherit" });

// 等待启动
setTimeout(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
    if (res.ok) {
      const data = await res.json();
      console.log("\n✅ llama-server 启动成功！");
      console.log(`  Web UI: http://127.0.0.1:${PORT}`);
      console.log(`  API:    http://127.0.0.1:${PORT}/v1/chat/completions`);
      console.log(`\n后端连接环境变量（PowerShell 分行设置）：`);
      console.log(`  $env:LLM_PROVIDER = "openai"`);
      console.log(`  $env:OPENAI_BASE_URL = "http://127.0.0.1:${PORT}/v1"`);
      console.log(`  $env:OPENAI_MODEL = "${modelPath}"`);
      console.log(`  $env:OPENAI_API_KEY = "not-needed"`);
      console.log(`  $env:RAG_EMBEDDING = "transformers"`);
      console.log(`  $env:HF_ENDPOINT = "https://hf-mirror.com"`);
      console.log(`  $env:PORT = "3000"`);
      console.log(`\n然后：cd RAG_libraries\\backend; npm run start`);
    } else {
      console.error("\n⚠ llama-server 起来了但 /v1/models 返回非 200，等模型加载完再试。");
    }
  } catch {
    console.error("\n⚠ 还在加载模型，等几秒后访问 http://127.0.0.1:" + PORT + " 验证。");
  }
}, 15000);

server.on("exit", (code) => {
  console.log(`\nllama-server 退出（code=${code}）`);
});
