import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BRIDGE_VERSION = "0.3.0";
export const CODEX_ACP_VERSION = "1.6.2";
export const DEFAULT_SLUG = "codex-devbox";
export const DEFAULT_DISPLAY_NAME = "Codex Devbox";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

export function validateSlug(slug) {
  if (slug === "default" || !SLUG_PATTERN.test(slug)) {
    throw new Error("Bot slug 必须匹配 [a-z0-9][a-z0-9_-]{0,31}，且不能为 default");
  }
  return slug;
}

export function validateDisplayName(name) {
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Bot 名称长度必须为 1-64，且不能包含控制字符");
  }
  return name;
}

export function normalizeHomeEnv(env = process.env) {
  const configuredHome = env.HOME || os.homedir();
  const realHome = fs.realpathSync(configuredHome);
  return { ...env, HOME: realHome };
}

export function resolveProjectPath(projectPath, { requireGit = true } = {}) {
  const resolved = path.resolve(projectPath || process.cwd());
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`项目目录不存在或不是目录: ${resolved}`);
  if (stat.isSymbolicLink()) throw new Error(`项目目录不能是符号链接: ${resolved}`);
  const real = fs.realpathSync(resolved);
  if (requireGit) {
    const result = run("git", ["-C", real, "rev-parse", "--show-toplevel"], {
      allowFailure: true,
    });
    if (result.status !== 0) {
      throw new Error(`项目目录不是 Git 仓库: ${real}`);
    }
    const root = fs.realpathSync(result.stdout.trim());
    if (root !== real) {
      throw new Error(`项目目录必须是 Git 仓库根目录: ${real}；实际根目录是 ${root}`);
    }
  }
  return real;
}

export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  const normalized = {
    status: result.status ?? (result.signal ? 128 + (os.constants.signals[result.signal] || 0) : 1),
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
  if (normalized.status !== 0 && !options.allowFailure) {
    const detail = normalized.signal ? `被信号 ${normalized.signal} 终止`
      : normalized.stderr.trim() || normalized.stdout.trim() || result.error?.message;
    throw new CommandError(`${command} 执行失败${detail ? `: ${detail}` : ""}`, normalized);
  }
  return normalized;
}

export function commandExists(command, env = process.env) {
  return run("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
    env,
    allowFailure: true,
  }).status === 0;
}

export function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 未返回有效 JSON: ${error.message}`);
  }
}

export function getDataRoot(env = process.env) {
  return path.resolve(path.join(env.HOME || os.homedir(), ".feishu-runtime"));
}

export function listBots({ env = process.env } = {}) {
  const output = run("feishu-runtime", ["bots", "list", "--json"], { env }).stdout;
  const value = parseJsonOutput(output, "feishu-runtime bots list");
  if (!Array.isArray(value.bots)) throw new Error("feishu-runtime bots list 响应缺少 bots");
  return value.bots;
}

export function findBot(slug, options = {}) {
  validateSlug(slug);
  return listBots(options).find((bot) => bot.slug === slug && !bot.archived);
}

export function runtimePaths(bot, env = process.env) {
  if (!bot || !UUID_PATTERN.test(bot.runtimeId || "")) {
    throw new Error("Bot Runtime ID 无效");
  }
  const dataRoot = getDataRoot(env);
  const botsRoot = path.join(dataRoot, "bots");
  const root = path.join(botsRoot, bot.runtimeId);
  const relative = path.relative(botsRoot, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Runtime 路径越界");
  return {
    dataRoot,
    root,
    config: path.join(root, "feishu-runtime.json"),
    metadata: path.join(root, "runtime.json"),
    log: path.join(root, "logs", "feishu-runtime.log"),
  };
}

export function readRuntimeConfig(bot, env = process.env) {
  const file = runtimePaths(bot, env).config;
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Runtime 配置缺失或不安全: ${file}`);
  }
  return parseJsonOutput(fs.readFileSync(file, "utf8"), "Runtime 配置");
}

export function secureConfig(current, { projectPath, displayName = DEFAULT_DISPLAY_NAME } = {}) {
  const project = resolveProjectPath(projectPath, { requireGit: true });
  return {
    ...current,
    feishu: { ...current.feishu, enabled: true, domain: current.feishu?.domain || "feishu" },
    group: { ...current.group, replyPolicy: "mention", defaultMode: "thread" },
    weixin: { ...current.weixin, enabled: false },
    project: { path: project, name: displayName },
    agents: {
      ...current.agents,
      defaultAgent: "codex",
      enableAutoStart: true,
      acpInitializeTimeoutMs: current.agents?.acpInitializeTimeoutMs || 120000,
    },
    sessions: {
      ...current.sessions,
      maxQueueSize: 3,
      autoCleanup: true,
      cleanupIntervalMinutes: current.sessions?.cleanupIntervalMinutes || 60,
    },
    permissions: {
      ...current.permissions,
      strategy: "ask",
      allowedTools: [],
      deniedTools: current.permissions?.deniedTools || [],
      timeoutSeconds: 300,
    },
    deduplication: {
      ...current.deduplication,
      enabled: true,
      maxRecords: current.deduplication?.maxRecords || 10000,
      expireHours: current.deduplication?.expireHours || 168,
    },
    shell: { ...current.shell, enabled: false },
    logging: { ...current.logging, level: "info" },
    power: { ...current.power, keepAwake: false },
  };
}

export function assertCredentials(config) {
  if (!config.feishu?.appId || !config.feishu?.appSecret) {
    throw new Error("飞书凭证尚未配置，请先运行 setup");
  }
}

export function replaceRuntimeConfig(slug, current, next, { env = process.env } = {}) {
  const request = JSON.stringify({ config: next, expectedConfig: current });
  run("feishu-runtime", ["bots", "config", "replace", slug, "--stdin"], {
    env,
    input: request,
  });
}

export function inspectSecurity(config, metadata, status) {
  const issues = [];
  if (!config.feishu?.appId || !config.feishu?.appSecret) issues.push("飞书凭证未配置");
  if (!config.feishu?.allowedUsers?.length) issues.push("飞书用户白名单未配置");
  if (config.agents?.defaultAgent !== "codex") issues.push("默认 Agent 不是 codex");
  if (config.permissions?.strategy !== "ask") issues.push("权限策略必须为 ask");
  if ((config.permissions?.allowedTools || []).length > 0) issues.push("allowedTools 必须为空");
  if (config.shell?.enabled !== false) issues.push("飞书裸 Shell 必须关闭");
  if (config.group?.replyPolicy !== "mention") issues.push("群聊必须只响应 mention");
  if (config.weixin?.enabled === true) issues.push("未使用的微信通道必须关闭");
  if (metadata?.workspaceMode !== "per-session-worktree") {
    issues.push("workspaceMode 必须为 per-session-worktree");
  }
  if (status?.nobind === true) issues.push("Runtime 不能以 --nobind 启动");
  return issues;
}

export function preflight(projectPath, {
  env = process.env, commandRunner = run, exists = commandExists,
  resolveProject = resolveProjectPath,
} = {}) {
  const checks = [];
  const add = (name, ok, message) => checks.push({ name, ok, message });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 20, `Node.js ${process.versions.node} (${process.execPath})，要求 >= 20`);
  const bundled = exists("codex-acp", env);
  let codexReady = false;
  for (const name of ["npm", "git", "codex"]) {
    const command = name === "codex" && bundled ? "codex-acp" : name;
    const prefix = name === "codex" && bundled ? ["cli"] : [];
    if (!exists(command, env)) {
      const hint = name === "codex" ? "请运行 install 安装 Codex ACP 或安装 Codex CLI"
        : name === "npm" ? "请安装包含 npm 的 Node.js 20+，并检查 PATH" : "请先安装 Git，并检查 PATH";
      add(name, false, `${name} 未安装或不在 PATH 中；${hint}`);
      continue;
    }
    const version = commandRunner(command, [...prefix, "--version"], { env, allowFailure: true });
    const output = (version.stdout || version.stderr).trim();
    const ready = version.status === 0 && output.length > 0;
    add(name, ready, ready ? output : `${name} --version 无法正常执行；请检查安装和 PATH`);
    if (name === "codex") codexReady = ready;
  }
  const resolved = path.resolve(projectPath || process.cwd());
  try { add("project", true, `Git 仓库根目录: ${resolveProject(resolved)}`); }
  catch (error) { add("project", false, error.message); }
  if (codexReady) {
    const command = bundled ? "codex-acp" : "codex";
    const prefix = bundled ? ["cli"] : [];
    const auth = commandRunner(command, [...prefix, "login", "status"], { env, allowFailure: true });
    add("codex-auth", auth.status === 0, auth.status === 0 ? "Codex 已登录"
      : `Codex 未登录或登录状态检查失败；一键部署将引导设备登录，亦可运行 ${command} ${prefix.join(" ")} login --device-auth`);
  }
  add("platform", true, process.platform === "linux" ? "Linux Devbox" : `当前是 ${process.platform}；部署目标必须在 Linux Devbox 上复检`);
  return checks;
}

export function installPinnedPackages({ env = process.env, inherit = true } = {}) {
  return run("npm", ["ci", "--registry=https://registry.npmjs.org/"], {
    env, inherit, cwd: fileURLToPath(new URL("../", import.meta.url)),
  });
}

export function ensureBot(slug, displayName, { env = process.env } = {}) {
  let bot = findBot(slug, { env });
  if (bot) return { bot, created: false };
  run("feishu-runtime", ["bots", "add", slug, "--name", displayName], { env });
  bot = findBot(slug, { env });
  if (!bot) throw new Error(`创建 Runtime 后仍无法找到: ${slug}`);
  return { bot, created: true };
}

export function botStatus(slug, { env = process.env, allowFailure = false } = {}) {
  const result = run("feishu-runtime", ["bots", "status", slug, "--json"], {
    env,
    allowFailure,
  });
  if (!result.stdout.trim()) return { status: "unknown", error: result.stderr.trim() };
  return parseJsonOutput(result.stdout, "feishu-runtime bots status");
}

export function fileMode(file) {
  return fs.statSync(file).mode & 0o777;
}
