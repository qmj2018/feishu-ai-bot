import type { Environment, ServiceEnvironment, CommandRunner, RunOptions } from "./types.js";
import path from "node:path";
import { PROJECT_ROOT, BUILD_ROOT } from "./paths.js";
import { setTimeout } from "node:timers/promises";
import { prepareWorkspace } from "./workspaces.js";
import { ensureUserLinger, installSystemdUnit, systemdUnitName, stopLegacySystemdUnit } from "./service.js";
import { chooseModel, listAvailableModels, probeModel } from "./codex.js";
import { configuredModel, readServiceEnvironment, resolveServiceEnvironment, writeServiceEnvironment } from "./runtime-env.js";
import { ensureLocalCodex } from "./local-codex.js";
import { prepareFeishu, type FeishuMode } from './feishu-setup.js';
import {
  DEFAULT_DISPLAY_NAME, DEFAULT_SLUG, botStatus, commandExists, findBot,
  normalizeHomeEnv, preflight, resolveProjectPath, run, validateDisplayName, validateSlug,
} from "./core.js";

export interface DeployOptions {
  projectPath?: string; repo?: string; workspaceName?: string; workspaceRoot?: string; branch?: string;
  slug?: string; name?: string; service?: boolean | 'auto' | 'systemd' | 'manual';
  model?: string; proxyMode?: string; timeoutMs?: number; skipInstall?: boolean; env?: Environment;
  feishuMode?: FeishuMode; feishuProfile?: string; updateCodex?: boolean;
  workspaceMode?: string; codexMode?: string;
}
interface DeployDependencies {
  platform?: string; commandRunner?: CommandRunner; check?: typeof preflight;
  createWorkspace?: typeof prepareWorkspace; resolveProject?: typeof resolveProjectPath;
  exists?: typeof commandExists; lookup?: typeof findBot; status?: typeof botStatus;
  sleep?: (milliseconds: number) => Promise<unknown>; log?: (message: string) => void;
  ensureLinger?: typeof ensureUserLinger; prepareEnvironment?: typeof prepareRuntime;
  ensureCodex?: typeof ensureLocalCodex; persistEnvironment?: typeof writeServiceEnvironment;
  installService?: typeof installSystemdUnit;
  prepareFeishu?: typeof prepareFeishu;
}

const root = PROJECT_ROOT;
const cli = path.join(BUILD_ROOT, "bin/feishu-ai-bot.js");

export async function prepareRuntime({ slug = DEFAULT_SLUG, model, proxyMode, timeoutMs = 60_000,
  env = process.env, log = console.error }: { slug?: string; model?: string; proxyMode?: string; timeoutMs?: number; env?: Environment; log?: (message: string) => void } = {}) {
  const previous = readServiceEnvironment(slug, env);
  let values = resolveServiceEnvironment({ env, previous, proxyMode });
  let effectiveEnv = { ...env, ...values };
  // Deployment/startup installs this executable; discovery and probes always use it.
  const previousModel = configuredModel(values);
  const models = (!model || model === "auto") && (!previousModel || model === "auto")
    ? await listAvailableModels({ env: effectiveEnv, timeoutMs }) : [];
  const selected = chooseModel(models, model, previousModel);
  values = resolveServiceEnvironment({ env: effectiveEnv, previous: values, model: selected });
  effectiveEnv = { ...env, ...values };
  log(`检查模型调用: ${selected}（最长 ${timeoutMs / 1000}s，不发送飞书消息）`);
  const probe = await probeModel({ model: selected, env: effectiveEnv, timeoutMs });
  return { values, env: effectiveEnv, probe };
}

export async function deploy({ projectPath, repo, workspaceName, workspaceRoot, branch, slug = DEFAULT_SLUG, name = DEFAULT_DISPLAY_NAME,
  service = true, model, proxyMode, timeoutMs = 30_000, skipInstall = false,
  feishuMode, feishuProfile, updateCodex = false,
  workspaceMode, codexMode,
  env: inputEnv = process.env }: DeployOptions = {}, dependencies: DeployDependencies = {}) {
  const {
    platform = process.platform, commandRunner = run, check = preflight, createWorkspace = prepareWorkspace,
    resolveProject = resolveProjectPath, exists = commandExists,
    lookup = findBot, status = botStatus, sleep = setTimeout, log = console.log,
    ensureLinger = ensureUserLinger, prepareEnvironment = prepareRuntime,
    ensureCodex = ensureLocalCodex,
    persistEnvironment = writeServiceEnvironment, installService = installSystemdUnit,
    prepareFeishu: prepareFeishuEnvironment = prepareFeishu,
  } = dependencies;
  if (platform !== "linux") throw new Error("一键部署只能在目标 Linux 主机（含 WSL）上执行");
  if (projectPath && (repo || workspaceName)) throw new Error("--project 不能与 --repo/--workspace 同时使用");
  if (!projectPath && !repo && !workspaceName) throw new Error("必须指定 --project，或 --repo/--workspace");
  if ((branch || workspaceRoot) && !repo && !workspaceName) throw new Error("--branch/--workspace-root 需要 --repo 或 --workspace");
  validateSlug(slug);
  validateDisplayName(name);
  if (workspaceMode && !['per-session-worktree', 'project-directory'].includes(workspaceMode)) throw new Error('工作空间模式无效');
  if (codexMode && !['read-only', 'agent', 'agent-full-access'].includes(codexMode)) throw new Error('Codex 权限模式无效');
  if (![true, false, "auto", "systemd", "manual"].includes(service)) throw new Error("服务模式无效");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error("超时必须为 1-600 秒");
  let env: Environment = normalizeHomeEnv(inputEnv);
  env.PATH = [env.PATH, path.join(env.HOME!, ".local", "bin")].filter(Boolean).join(path.delimiter);
  env.NPM_CONFIG_PREFIX ||= path.join(env.HOME!, ".local");
  env = { ...env, ...resolveServiceEnvironment({ env, previous: readServiceEnvironment(slug, env), proxyMode, model: model === "auto" ? undefined : model }) };
  if (repo || workspaceName) {
    log("准备工作空间：拉取仓库或核对已有目录");
    const workspace = createWorkspace({ name: workspaceName || slug, repo, branch, workspaceRoot,
      env: { ...env, ...resolveServiceEnvironment({ env, proxyMode }) } });
    projectPath = workspace.project;
    log(`工作空间${workspace.created ? '已创建' : '已复用'}: ${workspace.root}`);
  }
  const resolveWorkspace = (value?: string) => resolveProject(value, { requireGit: workspaceMode !== 'project-directory' });
  const checks = check(projectPath, { env, resolveProject: resolveWorkspace });
  for (const item of checks) log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.message}`);
  const failures = checks.filter(item => !item.ok && !["codex-auth", "codex"].includes(item.name));
  if (failures.length) throw new Error(`请先补齐部署环境: ${failures.map(item => item.name).join(", ")}`);
  const project = resolveWorkspace(projectPath);
  let stage = "项目自检";
  const execute = (command: string, args: string[], options: RunOptions = {}) => commandRunner(command, args, { inherit: true, env, ...options });
  const invoke = (...args: string[]) => execute(process.execPath, [cli, ...args]);
  try {
    log(`\n[部署] ${stage}`);
    execute("npm", ["run", "check"], { cwd: root });
    stage = "后台服务环境检查";
    const hasSystemd = exists("systemctl", env) && commandRunner("systemctl", ["--user", "show-environment"], { env, allowFailure: true }).status === 0;
    let autostart = service !== false && service !== "manual" && hasSystemd;
    if (service === "systemd" && !hasSystemd) throw new Error("user systemd 不可用，请使用 --service manual 或 --no-service");
    if (autostart) {
      try { ensureLinger({ commandRunner: (command, args, options) => commandRunner(command, args, { env, ...options }), exists: command => exists(command, env) }); }
      catch (error) {
        if (service === 'systemd') throw error;
        autostart = false; log('systemd linger 不可用，改用后台进程模式。');
      }
    }
    stage = "安装固定版本依赖和 Review skill";
    if (!skipInstall) invoke("install");
    stage = "项目测试";
    execute("npm", ["run", "verify"], { cwd: root });
    stage = "本机 Codex 检查";
    const codex = await ensureCodex({ env, log, update: updateCodex });
    env.CODEX_PATH = codex.path;
    stage = "Codex 登录";
    if (commandRunner(codex.path, ["login", "status"], { env, allowFailure: true }).status !== 0) {
      log("请按提示完成 Codex 设备登录");
      execute(codex.path, ["login", "--device-auth"]);
      commandRunner(codex.path, ["login", "status"], { env });
    }
    stage = "模型连通性检查";
    const prepared = await prepareEnvironment({ slug, model, proxyMode, timeoutMs, env, log });
    env = prepared.env;
    stage = '飞书机器人配置和登录';
    env = await prepareFeishuEnvironment({ slug, mode: feishuMode, profile: feishuProfile, env, log });
    stage = "停止已有 Runtime";
    const unit = systemdUnitName(slug);
    // The manager must stop first; model checks above must finish before either stop.
    if (hasSystemd) stopLegacySystemdUnit(slug, { env, commandRunner });
    if (hasSystemd && commandRunner("systemctl", ["--user", "is-active", "--quiet", unit], { env, allowFailure: true }).status === 0) {
      execute("systemctl", ["--user", "stop", unit]);
    }
    if (lookup(slug, { env })) {
      const current = status(slug, { env, allowFailure: true });
      if (!["stopped", "stale", "unverified"].includes(current.status)) invoke("stop", "--slug", slug);
    }
    stage = "飞书配置和安全基线";
    invoke("setup", "--slug", slug, "--name", name, "--project", project,
      ...(workspaceMode ? ['--workspace-mode', workspaceMode] : []), ...(codexMode ? ['--codex-mode', codexMode] : []));
    stage = "启动机器人";
    if (autostart) installService({ slug, enableNow: true, env, runtimeEnvironment: prepared.values });
    else {
      persistEnvironment(slug, prepared.values, env);
      invoke("start", "--slug", slug);
    }
    stage = "运行状态和安全校验";
    let running = false;
    for (let attempt = 0; attempt < Math.ceil(timeoutMs / 1000); attempt++) {
      if (status(slug, { env, allowFailure: true }).status === "running") { running = true; break; }
      await sleep(1000);
    }
    if (!running) throw new Error(`${timeoutMs / 1000} 秒内未进入 running 状态，请运行 doctor 检查`);
    invoke("verify", "--slug", slug, "--json");
    log(`部署完成：${slug}，模型 ${prepared.probe.model}，模型测试 ${prepared.probe.elapsedMs}ms。请在飞书发送新消息验证收发；历史待协调事件不会自动重放。`);
    return { slug, project, autostart, model: prepared.probe.model };
  } catch (error) {
    throw new Error(`一键部署在“${stage}”阶段失败: ${error.message}。修复后可重新执行相同部署命令；已完成的安装和配置会保留。`, { cause: error });
  }
}
