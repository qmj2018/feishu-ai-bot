import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { ensureUserLinger, installSystemdUnit } from "./service.mjs";
import { chooseModel, listAvailableModels, probeModel } from "./codex.mjs";
import { configuredModel, readServiceEnvironment, resolveServiceEnvironment, writeServiceEnvironment } from "./runtime-env.mjs";
import {
  DEFAULT_DISPLAY_NAME, DEFAULT_SLUG, botStatus, commandExists, findBot,
  normalizeHomeEnv, preflight, resolveProjectPath, run, validateDisplayName, validateSlug,
} from "./core.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bin/devbox-codex-bot.mjs");

export async function prepareRuntime({ slug, model, proxyMode, timeoutMs = 60_000,
  env = process.env, log = console.error } = {}) {
  const previous = readServiceEnvironment(slug, env);
  let values = resolveServiceEnvironment({ env, previous, proxyMode });
  let effectiveEnv = { ...env, ...values };
  const previousModel = configuredModel(values);
  const models = (!model || model === "auto") && (!previousModel || model === "auto")
    ? await listAvailableModels({ env: effectiveEnv, timeoutMs }) : [];
  const selected = chooseModel(models, model, previousModel);
  values = resolveServiceEnvironment({ previous: values, model: selected });
  effectiveEnv = { ...env, ...values };
  log(`检查模型调用: ${selected}（最长 ${timeoutMs / 1000}s，不发送飞书消息）`);
  const probe = await probeModel({ model: selected, env: effectiveEnv, timeoutMs });
  return { values, env: effectiveEnv, probe };
}

export async function deploy({ projectPath, slug = DEFAULT_SLUG, name = DEFAULT_DISPLAY_NAME,
  service = true, model, proxyMode, timeoutMs = 30_000, skipInstall = false,
  env: inputEnv = process.env } = {}, dependencies = {}) {
  const {
    platform = process.platform, commandRunner = run, check = preflight,
    resolveProject = resolveProjectPath, exists = commandExists,
    lookup = findBot, status = botStatus, sleep = setTimeout, log = console.log,
    ensureLinger = ensureUserLinger, prepareEnvironment = prepareRuntime,
    persistEnvironment = writeServiceEnvironment, installService = installSystemdUnit,
  } = dependencies;
  if (platform !== "linux") throw new Error("一键部署只能在目标 Linux Devbox 上执行");
  if (!projectPath) throw new Error("一键部署必须指定 --project <业务 Git 仓库根目录>");
  validateSlug(slug);
  validateDisplayName(name);
  if (![true, false, "auto", "systemd", "manual"].includes(service)) throw new Error("服务模式无效");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error("超时必须为 1-600 秒");
  let env = normalizeHomeEnv(inputEnv);
  env.PATH = [path.join(env.HOME, ".local", "bin"), env.PATH].filter(Boolean).join(path.delimiter);
  env.NPM_CONFIG_PREFIX ||= path.join(env.HOME, ".local");
  resolveServiceEnvironment({ env, proxyMode, model: model === "auto" ? undefined : model });
  const checks = check(projectPath, { env });
  for (const item of checks) log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.message}`);
  const failures = checks.filter(item => !item.ok && item.name !== "codex-auth" && !(item.name === "codex" && !skipInstall));
  if (failures.length) throw new Error(`请先补齐部署环境: ${failures.map(item => item.name).join(", ")}`);
  const project = resolveProject(projectPath);
  let stage = "项目自检";
  const execute = (command, args, options = {}) => commandRunner(command, args, { inherit: true, env, ...options });
  const invoke = (...args) => execute(process.execPath, [cli, ...args]);
  try {
    log(`\n[部署] ${stage}`);
    execute("npm", ["run", "verify"], { cwd: root });
    stage = "后台服务环境检查";
    const hasSystemd = exists("systemctl", env) && commandRunner("systemctl", ["--user", "show-environment"], { env, allowFailure: true }).status === 0;
    const autostart = service !== false && service !== "manual" && hasSystemd;
    if (service === "systemd" && !hasSystemd) throw new Error("user systemd 不可用，请使用 --service manual 或 --no-service");
    if (autostart) {
      ensureLinger({ commandRunner: (command, args, options) => commandRunner(command, args, { env, ...options }), exists: command => exists(command, env) });
    }
    stage = "安装固定版本依赖和 Review skill";
    if (!skipInstall) invoke("install");
    stage = "Codex 登录";
    const auth = checks.find(item => item.name === "codex-auth");
    if (!auth || !auth.ok) {
      const command = exists("codex-acp", env) ? "codex-acp" : "codex";
      const prefix = command === "codex-acp" ? ["cli"] : [];
      if (auth || commandRunner(command, [...prefix, "login", "status"], { env, allowFailure: true }).status !== 0) {
        log("请按提示完成 Codex 设备登录");
        execute(command, [...prefix, "login", "--device-auth"]);
        commandRunner(command, [...prefix, "login", "status"], { env });
      }
    }
    stage = "模型连通性检查";
    const prepared = await prepareEnvironment({ slug, model, proxyMode, timeoutMs, env, log });
    env = prepared.env;
    stage = "停止已有 Runtime";
    const unit = `devbox-codex-bot-${slug}.service`;
    // The manager must stop first; model checks above must finish before either stop.
    if (hasSystemd && commandRunner("systemctl", ["--user", "is-active", "--quiet", unit], { env, allowFailure: true }).status === 0) {
      execute("systemctl", ["--user", "stop", unit]);
    }
    if (lookup(slug, { env })) {
      const current = status(slug, { env, allowFailure: true });
      if (!["stopped", "stale", "unverified"].includes(current.status)) invoke("stop", "--slug", slug);
    }
    stage = "飞书配置和安全基线";
    invoke("setup", "--slug", slug, "--name", name, "--project", project);
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
