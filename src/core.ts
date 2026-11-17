import type { Environment, RunOptions, CommandRunner, RuntimeConfig, BotMetadata, RuntimeStatus, RuntimePaths, PreflightCheck } from "./types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "./paths.js";
import { localCodexPath } from "./local-codex.js";
import { APP_ID, APP_DISPLAY_NAME } from './identity.js';

export const BRIDGE_VERSION = "0.3.0";
export const CODEX_ACP_VERSION = "1.6.2";
export const DEFAULT_SLUG = APP_ID;
export const DEFAULT_DISPLAY_NAME = APP_DISPLAY_NAME;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CommandError extends Error {
  result: ReturnType<typeof run>;
  constructor(message: string, result: ReturnType<typeof run>) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

export function validateSlug(slug: string) {
  if (slug === "default" || !SLUG_PATTERN.test(slug)) {
    throw new Error("Bot slug 必须匹配 [a-z0-9][a-z0-9_-]{0,31}，且不能为 default");
  }
  return slug;
}

export function validateDisplayName(name: string) {
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Bot 名称长度必须为 1-64，且不能包含控制字符");
  }
  return name;
}

export function normalizeHomeEnv(env: Environment = process.env): Environment & { HOME: string } {
  const configuredHome = env.HOME || os.homedir();
  const realHome = fs.realpathSync(configuredHome);
  return { ...env, HOME: realHome };
}

export function resolveProjectPath(projectPath?: string, { requireGit = true } = {}) {
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

export function run(command: string, args: string[] = [], options: RunOptions = {}) {
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

export function commandExists(command: string, env: Environment = process.env) {
  return run("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
    env,
    allowFailure: true,
  }).status === 0;
}

export function parseJsonOutput<T>(text: string, label: string): T {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 未返回有效 JSON: ${error.message}`);
  }
}

export function getDataRoot(env: Environment = process.env) {
  return path.resolve(path.join(env.HOME || os.homedir(), ".feishu-runtime"));
}

export function listBots({ env = process.env }: { env?: Environment } = {}): BotMetadata[] {
  const output = run("feishu-runtime", ["bots", "list", "--json"], { env }).stdout;
  const value = parseJsonOutput<{ bots: BotMetadata[] }>(output, "feishu-runtime bots list");
  if (!Array.isArray(value.bots)) throw new Error("feishu-runtime bots list 响应缺少 bots");
  return value.bots;
}

export function findBot(slug: string, options: { env?: Environment } = {}) {
  validateSlug(slug);
  return listBots(options).find((bot) => bot.slug === slug && !bot.archived);
}

export function runtimePaths(bot: BotMetadata, env: Environment = process.env): RuntimePaths {
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

export function readRuntimeConfig(bot: BotMetadata, env: Environment = process.env): RuntimeConfig {
  const file = runtimePaths(bot, env).config;
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Runtime 配置缺失或不安全: ${file}`);
  }
  return parseJsonOutput(fs.readFileSync(file, "utf8"), "Runtime 配置");
}

export function secureConfig<T extends RuntimeConfig>(current: T, { projectPath, displayName = DEFAULT_DISPLAY_NAME }: { projectPath?: string; displayName?: string } = {}): Omit<T, keyof RuntimeConfig> & RuntimeConfig {
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

export function assertCredentials(config: RuntimeConfig): asserts config is RuntimeConfig & { feishu: { appId: string; appSecret: string; domain?: string; allowedUsers?: string[] } } {
  if (!config.feishu?.appId || !config.feishu?.appSecret) {
    throw new Error("飞书凭证尚未配置，请先运行 setup");
  }
}

export function replaceRuntimeConfig(slug: string, current: RuntimeConfig, next: RuntimeConfig, { env = process.env }: { env?: Environment } = {}) {
  const request = JSON.stringify({ config: next, expectedConfig: current });
  run("feishu-runtime", ["bots", "config", "replace", slug, "--stdin"], {
    env,
    input: request,
  });
}

export function inspectSecurity(config: RuntimeConfig, metadata: Partial<BotMetadata>, status: Partial<RuntimeStatus>) {
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

export function preflight(projectPath: string | undefined, {
  env = process.env, commandRunner = run, exists = commandExists,
  resolveProject = resolveProjectPath,
}: { env?: Environment; commandRunner?: CommandRunner; exists?: typeof commandExists; resolveProject?: typeof resolveProjectPath } = {}) {
  const checks: PreflightCheck[] = [];
  const add = (name: string, ok: boolean, message: string) => checks.push({ name, ok, message });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 20, `Node.js ${process.versions.node} (${process.execPath})，要求 >= 20`);
  const codex = localCodexPath(env);
  let codexReady = false;
  for (const name of ["npm", "git", "codex"]) {
    const command = name === "codex" ? codex : name;
    if (!exists(command, env)) {
      const hint = name === "codex" ? `部署或启动时将自动安装本机 Codex: ${codex}`
        : name === "npm" ? "请安装包含 npm 的 Node.js 20+，并检查 PATH" : "请先安装 Git，并检查 PATH";
      add(name, false, `${name} 未安装或不在 PATH 中；${hint}`);
      continue;
    }
    const version = commandRunner(command, ["--version"], { env, allowFailure: true });
    const output = (version.stdout || version.stderr || "").trim();
    const ready = version.status === 0 && output.length > 0;
    add(name, ready, ready ? output : `${name} --version 无法正常执行；请检查安装和 PATH`);
    if (name === "codex") codexReady = ready;
  }
  const resolved = path.resolve(projectPath || process.cwd());
  try { add("project", true, `Git 仓库根目录: ${resolveProject(resolved)}`); }
  catch (error) { add("project", false, error.message); }
  if (codexReady) {
    const auth = commandRunner(codex, ["login", "status"], { env, allowFailure: true });
    add("codex-auth", auth.status === 0, auth.status === 0 ? "Codex 已登录"
      : `Codex 未登录或登录状态检查失败；一键部署将引导设备登录，亦可运行 ${codex} login --device-auth`);
  }
  add("platform", true, process.platform === "linux" ? "Linux / WSL Linux" : `当前是 ${process.platform}；一键部署请在 Linux 或 Windows WSL Linux 中运行`);
  return checks;
}

export function installPinnedPackages({ env = process.env, inherit = true }: { env?: Environment; inherit?: boolean } = {}) {
  return run("bash", [path.join(PROJECT_ROOT, 'scripts/ensure-dependencies.sh')], {
    env, inherit, cwd: PROJECT_ROOT,
  });
}

export function ensureBot(slug: string, displayName: string, { env = process.env }: { env?: Environment } = {}) {
  let bot = findBot(slug, { env });
  if (bot) return { bot, created: false };
  run("feishu-runtime", ["bots", "add", slug, "--name", displayName], { env });
  bot = findBot(slug, { env });
  if (!bot) throw new Error(`创建 Runtime 后仍无法找到: ${slug}`);
  return { bot, created: true };
}

export function botStatus(slug: string, { env = process.env, allowFailure = false }: { env?: Environment; allowFailure?: boolean } = {}): RuntimeStatus {
  const result = run("feishu-runtime", ["bots", "status", slug, "--json"], {
    env,
    allowFailure,
  });
  if (!result.stdout.trim()) return { status: "unknown", error: result.stderr.trim() };
  return parseJsonOutput(result.stdout, "feishu-runtime bots status");
}

export function fileMode(file: string) {
  return fs.statSync(file).mode & 0o777;
}
