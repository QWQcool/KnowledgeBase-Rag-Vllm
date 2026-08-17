// scripts/vllm-check.mjs —— vLLM 环境就绪度检查清单
//
// 用途：跑一下就知道本机离「能用 vLLM 跑 Qwen3-8B-AWQ」还差什么。
// 用法：
//   node scripts/vllm-check.mjs
//   node scripts/vllm-check.mjs --venv C:\venvs\vllm-py312   （指定 Python 3.12 venv）
//   node scripts/vllm-check.mjs --model-dir D:\models\Qwen3-8B-AWQ
//
// 输出：每项 ✅/❌ + 汇总「还差什么」；全部通过退出码 0，否则 1。
// 只读检查，不安装任何东西（安装步骤见 docs/vllm-migration-report.md）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = []; // { ok, label, detail }

/** 收集一项检查结果 */
function report(ok, label, detail = "") {
  results.push({ ok, label, detail });
  const icon = ok ? "✅" : "❌";
  console.log(`  ${icon} ${label}${detail ? ` —— ${detail}` : ""}`);
}

/** 同步执行命令，返回 { status, stdout, stderr }；失败/不存在返回 status=null */
function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    ...opts,
  });
  if (r.error) return { status: null, stdout: "", stderr: String(r.error.message ?? r.error) };
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/** 解析命令行参数（--key value 与 --key=value 都支持） */
function parseArgs(argv) {
  const opts = { venv: undefined, modelDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--venv") opts.venv = argv[++i];
    else if (a === "--model-dir") opts.modelDir = argv[++i];
    else if (a.startsWith("--venv=")) opts.venv = a.slice("--venv=".length);
    else if (a.startsWith("--model-dir=")) opts.modelDir = a.slice("--model-dir=".length);
  }
  return opts;
}

/** 探测 vLLM 专用 venv 里的 python.exe（Windows 布局） */
function findVenvPython(venv) {
  if (!venv) return null;
  const candidates = [
    path.join(venv, "Scripts", "python.exe"), // Windows
    path.join(venv, "bin", "python"), // Linux/macOS
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** 收集可用的 python 解释器候选：venv → py -3.12 → python */
function collectPythonCandidates(venv) {
  const list = [];
  const venvPy = findVenvPython(venv);
  if (venvPy) list.push({ name: `venv: ${venvPy}`, cmd: venvPy });
  // 系统 python（可能是 3.13，vLLM fork 不认，会在这里暴露出来）
  const sysPy = run("python", ["--version"]);
  if (sysPy.status !== null) list.push({ name: "python (PATH)", cmd: "python" });
  // py launcher 显式 3.12（Windows 多版本共存时最可靠）
  const py312 = run("py", ["-3.12", "--version"]);
  if (py312.status === 0) list.push({ name: "py -3.12", cmd: "py", args: ["-3.12"] });
  return list;
}

/** 在指定解释器里执行 python 表达式，返回 stdout 或 null */
function pyEval(py, code) {
  const args = (py.args ?? []).concat(["-c", code]);
  const r = run(py.cmd, args);
  return r.status === 0 ? r.stdout : null;
}

// ==================== 主流程 ====================
const opts = parseArgs(process.argv.slice(2));
console.log("================================================");
console.log("  vLLM 环境就绪度检查（只读，不安装任何东西）");
console.log("  仓库根目录:", ROOT);
console.log("================================================");

// ---- 1) Python 3.12 环境 ----
const candidates = collectPythonCandidates(opts.venv);
if (candidates.length === 0) {
  report(false, "Python 解释器", "未找到 venv 或 python/py，请先建 Python 3.12 venv");
} else {
  for (const py of candidates) {
    const ver = pyEval(py, "import sys; print(sys.version.split()[0])");
    if (ver === null) {
      report(false, py.name, "无法执行");
      continue;
    }
    const is312 = ver.startsWith("3.12");
    report(is312, `${py.name} = Python ${ver}`, is312 ? "" : "vLLM fork 要求 3.12（3.13 不可用）");
  }
}
// 选第一个可用的 3.12 解释器作为后续检查对象
const py312 =
  candidates.find((py) => (pyEval(py, "import sys; print(sys.version.split()[0])") ?? "").startsWith("3.12")) ??
  candidates[0] ??
  null;

// ---- 2) vLLM 安装 ----
if (py312) {
  const vllmVer = pyEval(py312, "import vllm; print(vllm.__version__)");
  if (vllmVer !== null) {
    report(true, "vLLM 已安装", `vllm ${vllmVer}`);
  } else {
    report(false, "vLLM 未安装", "请按 docs/vllm-migration-report.md 安装 SystemPanic/vllm-windows wheel");
  }
  // 辅助包（缺了也能跑，但影响性能/功能，标注为可选）
  const triton = pyEval(py312, "import triton; print(triton.__version__)");
  report(
    triton !== null,
    "triton-windows",
    triton !== null ? `triton ${triton}` : "可选：缺少数值算子加速，建议装 triton-windows",
  );
  const flashinfer = pyEval(py312, "import flashinfer; print(getattr(flashinfer, '__version__', 'ok'))");
  report(
    flashinfer !== null,
    "flashinfer",
    flashinfer !== null ? `flashinfer ${flashinfer}` : "可选：attention 后端，缺省回退 triton/xformers",
  );
  // torch + CUDA 可用性
  const torch = pyEval(
    py312,
    "import torch; print(torch.__version__); print(torch.version.cuda or 'cpu'); print(torch.cuda.is_available())",
  );
  if (torch !== null) {
    const [tv, tcuda, tava] = torch.split("\n");
    report(tava === "True", "torch + CUDA", `torch ${tv} / cuda ${tcuda} / cuda.is_available=${tava}`);
  } else {
    report(false, "torch 未安装或不可导入", "需装 CUDA 版 torch（见报告第 1 步）");
  }
} else {
  report(false, "vLLM / torch 检查", "被跳过：无可用 Python 3.12 解释器");
}

// ---- 3) GPU 显存（复用 adaptive-ollama 的 nvidia-smi 探测思路） ----
const gpu = run("nvidia-smi", [
  "--query-gpu=name,memory.total,memory.used,driver_version",
  "--format=csv,noheader,nounits",
]);
if (gpu.status !== null && gpu.stdout) {
  const first = gpu.stdout.split("\n")[0];
  const m = first.split(",").map((s) => s.trim());
  const [name, total, used, driver] = m;
  const totalNum = parseInt(total, 10);
  const usedNum = parseInt(used, 10);
  // CUDA 驱动版本：nvidia-smi 头部 "CUDA Version: Y"（旧版）或 "CUDA UMD Version: Y"（新版）
  const header = run("nvidia-smi");
  const cudaVerMatch =
    header.status === 0 ? header.stdout.match(/CUDA\s+(?:UMD\s+)?Version\s*:\s*([\d.]+)/i) : null;
  const cudaVer = cudaVerMatch ? cudaVerMatch[1] : "未知";
  if (!Number.isNaN(totalNum) && !Number.isNaN(usedNum)) {
    const free = totalNum - usedNum;
    const enough = free >= 9000; // Qwen3-8B AWQ 建议 ≥9GB 空闲
    report(
      enough,
      `GPU 显存（${name} / driver ${driver} / CUDA ${cudaVer}）`,
      `空闲 ${free}MiB / 共 ${totalNum}MiB${enough ? "" : " —— AWQ 8B 建议空闲 ≥9GB"}`,
    );
  } else {
    report(false, "GPU 显存", `解析失败：${first}`);
  }
} else {
  report(false, "GPU 显存", "nvidia-smi 不可用：无 NVIDIA GPU 或未安装驱动");
}

// ---- 4) 模型文件（Qwen3-8B AWQ safetensors） ----
const modelDir = opts.modelDir ?? process.env.VLLM_MODEL_DIR ?? path.join(ROOT, "models", "Qwen3-8B-AWQ");
const hasConfig = fs.existsSync(path.join(modelDir, "config.json"));
let safetensorCount = 0;
if (fs.existsSync(modelDir)) {
  try {
    safetensorCount = fs
      .readdirSync(modelDir)
      .filter((f) => f.endsWith(".safetensors")).length;
  } catch {
    /* 目录读取失败按 0 处理 */
  }
}
if (hasConfig && safetensorCount > 0) {
  report(true, "模型文件", `${modelDir}：config.json + ${safetensorCount} 个 *.safetensors`);
} else {
  const missing = [];
  if (!hasConfig) missing.push("缺 config.json");
  if (safetensorCount === 0) missing.push("缺 *.safetensors");
  report(
    false,
    "模型文件",
    `${modelDir}：${missing.join("、")}。请下载 Qwen3-8B-AWQ 放这里，或 --model-dir 指定`,
  );
}

// ---- 5) VLLM_CUDART_SO_PATH（Windows fork 找 cudart 的必需变量） ----
let cudart = process.env.VLLM_CUDART_SO_PATH ?? "";
if (!cudart) {
  // Windows 特有来源：驱动 Store 与 CUDA Toolkit（与 start-vllm.bat 逻辑一致）
  const driverStore = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "DriverStore", "FileRepository");
  const cudaToolkit = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA";
  for (const base of [driverStore, cudaToolkit]) {
    if (!fs.existsSync(base)) continue;
    const found = findCudartRecursive(base, 4);
    if (found) {
      cudart = found;
      break;
    }
  }
}
if (cudart && fs.existsSync(cudart)) {
  report(true, "VLLM_CUDART_SO_PATH", `${cudart}`);
} else if (cudart) {
  report(false, "VLLM_CUDART_SO_PATH", `已设置但文件不存在：${cudart}`);
} else {
  report(false, "VLLM_CUDART_SO_PATH", "未设置。请 set VLLM_CUDART_SO_PATH=...cudart64_*.dll（见报告第 2 步）");
}

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log("================================================");
if (failed.length === 0) {
  console.log("🎉 全部通过！本机已具备启动 vLLM 的条件，直接运行 start-vllm.bat 即可。");
  process.exit(0);
} else {
  console.log(`共 ${results.length} 项检查，${failed.length} 项未通过：`);
  for (const f of failed) console.log(`  ❌ ${f.label}`);
  console.log("\n下一步：对照 docs/vllm-migration-report.md 的「实操步骤」逐项补齐后重跑本脚本。");
  process.exit(1);
}

/**
 * 在目录内递归查找第一个 cudart64_*.dll（限制深度，避免全盘扫描太慢）。
 * 返回完整路径或 null。
 */
function findCudartRecursive(dir, maxDepth) {
  const stack = [{ dir, depth: 0 }];
  while (stack.length > 0) {
    const { dir: d, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        stack.push({ dir: path.join(d, e.name), depth: depth + 1 });
      } else if (e.isFile() && /^cudart64_.*\.dll$/i.test(e.name)) {
        return path.join(d, e.name);
      }
    }
  }
  return null;
}
