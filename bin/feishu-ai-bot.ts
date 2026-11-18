#!/usr/bin/env node
import type { DeployOptions } from "../src/deploy.js";
import fs from "node:fs";
import { format } from "node:util";
import path from "node:path";
import { PROJECT_ROOT } from "../src/paths.js";
import { defaultBotSlug } from '../src/legacy.js';
import { prepareWorkspace } from "../src/workspaces.js";
import { ensureLocalCodex, localCodexPath } from "../src/local-codex.js";
import { deploy, prepareRuntime } from "../src/deploy.js";
import { configureFeishuApplication, type FeishuMode } from '../src/feishu-setup.js';
import { accessConfig, updateAccess, accessSummary, recentGroupMessages } from '../src/access.js';
import {
  CODEX_ACP_VERSION,
  DEFAULT_DISPLAY_NAME,
  BRIDGE_VERSION,
  assertCredentials,
  botStatus,
  commandExists,
  ensureBot,
  fileMode,
  findBot,
  inspectSecurity,
  installPinnedPackages,
  normalizeHomeEnv,
  preflight,
  readRuntimeConfig,
  replaceRuntimeConfig,
  resolveProjectPath,
  run,
  runtimePaths,
  secureConfig,
  validateDisplayName,
  validateSlug,
} from "../src/core.js";
import {
  installSystemdUnit,
  systemdUnitName,
  renderSupervisorConfig,
  renderSystemdUnit,
  resolveExecutable,
} from "../src/service.js";
import { listAvailableModels } from "../src/codex.js";
import { readServiceEnvironment, resolveServiceEnvironment } from "../src/runtime-env.js";
import {
  installReviewSkill,
  prepareMergeRequestReview,
  reviewSkillInstalled,
} from "../src/review.js";

const HELP = `feishu-ai-bot - 飞书 AI 机器人部署工具（Codex / Claude Code）

用法:
  feishu-ai-bot preflight [--project <git-dir>] [--json]
  feishu-ai-bot install
  feishu-ai-bot workspace create --name <name> [--repo <https-or-ssh-url>|--empty]
    [--branch <branch>] [--workspace-root <dir>] [--json]
  feishu-ai-bot deploy [--slug <slug>] [--cwd <dir>|--project <git-dir>|--repo <url>|--workspace <name>] [--name <name>]
    [--workspace-mode <per-session-worktree|project-directory>] [--codex-mode <read-only|agent|agent-full-access>]
    [--workspace <name>] [--workspace-root <dir>] [--branch <branch>]
    [--model <id|auto>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>]
    [--skip-install] [--service <auto|systemd|manual>] [--no-service]
    [--feishu-mode <auto|create|existing>] [--feishu-profile <name>] [--update-codex]
  feishu-ai-bot models [--slug <slug>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>]
  feishu-ai-bot probe [--slug <slug>] [--model <id|auto>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>] [--json]
  feishu-ai-bot run|start|restart [--slug <slug>] [--cwd <dir>|--project <dir>]
    [--workspace-mode <per-session-worktree|project-directory>] [--codex-mode <read-only|agent|agent-full-access>]
  feishu-ai-bot setup [--slug <slug>] [--name <name>] [--cwd <dir>|--project <git-dir>]
  feishu-ai-bot configure [--slug <slug>] [--project <dir>]
    [--workspace-mode <per-session-worktree|project-directory>] [--codex-mode <read-only|agent|agent-full-access>]
  feishu-ai-bot start|stop|restart|status [--slug <slug>]
  feishu-ai-bot doctor [--slug <slug>]
  feishu-ai-bot verify [--slug <slug>] [--json]
  feishu-ai-bot mr prepare <Codebase-MR-URL> [--json]
  feishu-ai-bot skill install
  feishu-ai-bot users list|add|remove [ou_open_id ...] [--slug <slug>] [--json]
  feishu-ai-bot groups list|add|remove [oc_chat_id ...] [--slug <slug>] [--json]
  feishu-ai-bot groups messages <oc_chat_id> [--limit <1-100>] [--slug <slug>] [--json]
  feishu-ai-bot groups authorize [--slug <slug>]
  feishu-ai-bot service render [--slug <slug>]
  feishu-ai-bot service render-supervisor [--slug <slug>]
  feishu-ai-bot service install [--slug <slug>] [--enable-now] [--model <id|auto>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>]
  feishu-ai-bot versions

Codex: --codex-path <absolute-path> 或 CODEX_PATH 指定本机客户端，默认 ~/.local/bin/codex。
优先复用本机已安装 Codex；缺失才安装。升级须显式指定 --update-codex。

安全默认值:
  bind 模式、Codex Agent、权限逐次询问、群聊仅 @ 回复、关闭裸 Shell、每会话 Git worktree。
`;

function valueAfter(args: string[], flag: string, fallback: string): string;
function valueAfter(args: string[], flag: string, fallback?: string): string | undefined;
function valueAfter(args: string[], flag: string, fallback?: string) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少值`);
  return value;
}

function common(args: string[]) {
  if (args.includes('--cwd') && args.includes('--project')) throw new Error('--cwd 不能与 --project 同时使用');
  return {
    slug: validateSlug(valueAfter(args, "--slug") ?? defaultBotSlug()),
    projectPath: valueAfter(args, '--cwd') || valueAfter(args, "--project", process.cwd()),
  };
}

function workspaceOptions(args: string[]) {
  const workspaceMode = valueAfter(args, '--workspace-mode', args.includes('--cwd') ? 'project-directory' : undefined);
  if (args.includes('--cwd') && workspaceMode !== 'project-directory') throw new Error('--cwd 直接使用目录，不能与 worktree 模式同时使用');
  if (workspaceMode && !['per-session-worktree', 'project-directory'].includes(workspaceMode)) throw new Error('工作空间模式无效');
  const codexMode = valueAfter(args, '--codex-mode');
  if (codexMode && !['read-only', 'agent', 'agent-full-access'].includes(codexMode)) throw new Error('Codex 权限模式无效');
  return { workspaceMode, codexMode };
}

function writeStdout(value: unknown): void {
  process.stdout.write(`${format(value)}\n`);
}

function writeResult(value: unknown, json = false) {
  if (json) writeStdout(JSON.stringify(value, null, 2));
  else writeStdout(value);
}

function configure(slug: string, projectPath: string, displayName = DEFAULT_DISPLAY_NAME, modes: { workspaceMode?: string; codexMode?: string } = {}) {
  const bot = findBot(slug);
  if (!bot) throw new Error(`Runtime 不存在: ${slug}；请先运行 setup`);
  const status = botStatus(slug, { allowFailure: true });
  if (!["stopped", "stale", "unverified"].includes(status.status)) {
    throw new Error(`Runtime 当前状态为 ${status.status}，请先 stop 再 configure`);
  }
  const current = readRuntimeConfig(bot);
  assertCredentials(current);
  const next = secureConfig(current, {
    projectPath,
    displayName,
    ...modes,
  });
  replaceRuntimeConfig(slug, current, next);
  writeStdout(`安全配置已应用到 ${slug}，凭证未输出到终端。`);
}

function setupRuntime(slug: string, projectPath: string, displayName: string, modes: { workspaceMode?: string; codexMode?: string } = {}) {
  const existing = findBot(slug);
  const workspaceMode = modes.workspaceMode || (existing && readRuntimeConfig(existing).project?.workspaceMode);
  resolveProjectPath(projectPath, { requireGit: workspaceMode !== 'project-directory' });
  const { bot, created } = ensureBot(slug, displayName);
  const current = readRuntimeConfig(bot);
  if (!current.feishu?.appId || !current.feishu?.appSecret || process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET || process.env.FEISHU_ALLOWED_USERS) {
    writeStdout("即将配置飞书官方 SDK 消息桥接。");
    run("feishu-runtime", ["bots", "setup", slug], { inherit: true });
  } else if (created) {
    throw new Error("新建 Runtime 出现非空凭证，拒绝继续，请运行 doctor 检查");
  }
  configure(slug, projectPath, displayName, modes);
  writeStdout(`Code Review skills 已就绪（通用审查 + Codebase 入口）: ${installReviewSkill()}`);
}

function launchRuntime(command: string, args: string[], slug: string) {
  const modes = workspaceOptions(args);
  const override = ['--cwd', '--project', '--workspace-mode', '--codex-mode'].some(flag => args.includes(flag));
  let current, next;
  if (override) {
    const bot = findBot(slug);
    if (!bot) throw new Error(`Runtime 不存在: ${slug}；请先运行 setup`);
    current = readRuntimeConfig(bot);
    next = secureConfig(current, { ...modes, projectPath: valueAfter(args, '--cwd') || valueAfter(args, '--project') || current.project?.path,
      displayName: current.project?.name || DEFAULT_DISPLAY_NAME });
  }
  const unit = systemdUnitName(slug);
  const managed = process.platform === 'linux' && commandExists('systemctl')
    && run('systemctl', ['--user', 'show', unit, '--property=LoadState', '--value'], { allowFailure: true }).stdout.trim() === 'loaded';
  const invoke = (action: string) => run('feishu-runtime', ['bots', action, slug], { inherit: true });
  if (command === 'restart' || command === 'stop') {
    if (managed) run('systemctl', ['--user', 'stop', unit], { inherit: true });
    // Also stop a manually launched process if the installed unit was inactive.
    invoke('stop');
    if (command === 'stop') return;
  }
  if (next && current) replaceRuntimeConfig(slug, current, next);
  if (command === 'run') run('feishu-runtime', ['bots', 'start', slug, '--foreground'], { inherit: true });
  else if (managed) run('systemctl', ['--user', 'start', unit], { inherit: true });
  else invoke('start');
}

function runtimeOptions(args: string[], slug: string) {
  const timeoutMs = Number(valueAfter(args, "--timeout", "60")) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error("--timeout 必须在 1-600 秒之间");
  const previous = readServiceEnvironment(slug);
  const values = resolveServiceEnvironment({ previous, proxyMode: valueAfter(args, "--proxy-mode") });
  return { values, env: { ...process.env, ...values }, timeoutMs };
}

async function checkedEnvironment(args: string[], slug: string) {
  const { timeoutMs, env } = runtimeOptions(args, slug);
  await ensureLocalCodex({ env, update: args.includes('--update-codex') });
  return prepareRuntime({ slug, timeoutMs, env, model: valueAfter(args, "--model"), proxyMode: valueAfter(args, "--proxy-mode") });
}

function verifyRuntime(slug: string) {
  const bot = findBot(slug);
  if (!bot) throw new Error(`Runtime 不存在: ${slug}`);
  const paths = runtimePaths(bot);
  const config = readRuntimeConfig(bot);
  const metadata = JSON.parse(fs.readFileSync(paths.metadata, "utf8"));
  const status = botStatus(slug, { allowFailure: true });
  const issues = inspectSecurity(config, metadata, { ...status, nobind: status.state?.nobind ?? status.nobind });
  if (!reviewSkillInstalled()) issues.push("Code Review skills 未安装或与项目版本不一致，请运行 skill install");
  if (fileMode(paths.config) !== 0o600) issues.push("feishu-runtime.json 权限必须为 0600");
  if (fileMode(paths.metadata) !== 0o600) issues.push("runtime.json 权限必须为 0600");
  return { ok: issues.length === 0, slug, status: status.status, issues };
}

async function main() {
  const home = normalizeHomeEnv().HOME;
  Object.assign(process.env, normalizeHomeEnv());
  process.env.NPM_CONFIG_PREFIX ||= path.join(home, ".local");
  process.env.PATH = [process.env.PATH, path.join(home, ".local", "bin"), path.join(PROJECT_ROOT, "bin"), path.join(PROJECT_ROOT, "node_modules", ".bin")].filter(Boolean).join(path.delimiter);
  const [command, ...args] = process.argv.slice(2);
  const codexPath = valueAfter(args, "--codex-path");
  if (codexPath !== undefined) process.env.CODEX_PATH = localCodexPath({ CODEX_PATH: codexPath });
  if (!command || ["help", "--help", "-h"].includes(command)) {
    writeStdout(HELP);
    return;
  }
  const { slug, projectPath } = common(args);
  if (command === 'users' || command === 'groups') {
    const action = args[0] || 'list';
    const ids: string[] = [];
    for (let index = 1; index < args.length; index++) {
      if (args[index] === '--json') continue;
      if (['--slug', '--limit'].includes(args[index])) { valueAfter(args.slice(index), args[index]); index++; continue; }
      if (args[index].startsWith('--')) throw new Error(`未知参数: ${args[index]}`);
      ids.push(args[index]);
    }
    const { paths, config } = accessConfig(slug);
    if (action === 'list') {
      if (ids.length) throw new Error('list 不接受用户或群 ID');
      writeResult(accessSummary(slug, config, command), true); return;
    }
    if (action === 'add' || action === 'remove') {
      writeResult(accessSummary(slug, updateAccess(paths.config, command, action, ids), command), true); return;
    }
    if (command === 'groups' && action === 'messages') {
      if (ids.length !== 1) throw new Error('请提供一个群 chat_id');
      writeResult({ slug, chatId: ids[0], messages: recentGroupMessages(paths.root, ids[0], Number(valueAfter(args, '--limit', '20'))) }, true); return;
    }
    if (command === 'groups' && action === 'authorize') {
      if (ids.length || !config.group?.listenChats?.length) throw new Error('请先通过 groups add 配置需要监听的群');
      assertCredentials(config);
      await configureFeishuApplication({ appId: config.feishu.appId, appSecret: config.feishu.appSecret,
        domain: config.feishu.domain === 'lark' ? 'lark' : 'feishu' }, { listenGroups: true });
      writeResult({ slug, status: 'published', permission: 'im:message.group_msg' }, true); return;
    }
    throw new Error('不支持的用户或群管理命令');
  }
  if (command === "versions") {
    writeResult({ bridge: BRIDGE_VERSION, codexAcp: CODEX_ACP_VERSION }, true);
    return;
  }
  if (command === "preflight") {
    const modes = workspaceOptions(args);
    const checks = preflight(projectPath, { env: runtimeOptions(args, slug).env,
      resolveProject: value => resolveProjectPath(value, { requireGit: modes.workspaceMode !== 'project-directory' }) });
    if (args.includes("--json")) writeResult({ ok: checks.every((item) => item.ok), checks }, true);
    else for (const item of checks) writeStdout(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.message}`);
    if (checks.some((item) => !item.ok)) process.exitCode = 1;
    return;
  }
  if (command === "install") {
    installPinnedPackages();
    const values = resolveServiceEnvironment({ previous: readServiceEnvironment(slug) });
    await ensureLocalCodex({ env: { ...process.env, ...values }, update: args.includes('--update-codex') });
    const skillPath = installReviewSkill();
    writeStdout(`已安装 Feishu Bridge ${BRIDGE_VERSION} 和 codex-acp ${CODEX_ACP_VERSION}`);
    writeStdout(`已安装 Code Review skills（通用审查 + Codebase 入口）: ${skillPath}`);
    return;
  }
  if (command === "models") {
    writeResult(await listAvailableModels(runtimeOptions(args, slug)), true);
    return;
  }
  if (command === "probe") {
    const checked = await checkedEnvironment(args, slug);
    writeResult(checked.probe, args.includes("--json"));
    return;
  }
  if (command === "workspace") {
    if (args[0] !== 'create') throw new Error('用法: workspace create --name <name> [--repo <url>|--empty]');
    const booleans = new Set(['--empty', '--json']);
    const flags = new Set(['--name', '--repo', '--branch', '--workspace-root', ...booleans]);
    for (let index = 1; index < args.length; index++) {
      if (!flags.has(args[index])) throw new Error('未知工作空间参数');
      if (!booleans.has(args[index])) { valueAfter(args.slice(index), args[index]); index++; }
    }
    const result = prepareWorkspace({ name: valueAfter(args, '--name')!, repo: valueAfter(args, '--repo'),
      empty: args.includes('--empty'), branch: valueAfter(args, '--branch'), workspaceRoot: valueAfter(args, '--workspace-root') });
    writeResult(result, true); return;
  }
  if (command === "deploy") {
    if (args.includes("--help") || args.includes("-h")) { writeStdout(HELP); return; }
    const booleans = new Set(["--skip-install", "--no-service", '--update-codex']);
    const flags = new Set(["--slug", "--project", '--cwd', '--workspace-mode', '--codex-mode', "--name", "--model", "--proxy-mode", "--timeout", "--service", "--repo", "--workspace", "--workspace-root", "--branch", "--codex-path", '--feishu-mode', '--feishu-profile', ...booleans]);
    for (let index = 0; index < args.length; index++) {
      if (!flags.has(args[index])) throw new Error(`未知部署参数: ${args[index]}`);
      if (!booleans.has(args[index])) { valueAfter(args.slice(index), args[index]); index++; }
    }
    const service = valueAfter(args, "--service", args.includes("--no-service") ? "manual" : "auto");
    if (!["auto", "systemd", "manual"].includes(service)) throw new Error("--service 必须是 auto、systemd 或 manual");
    if (args.includes("--no-service") && service !== "manual") throw new Error("--no-service 与 --service 参数冲突");
    const options = runtimeOptions(args, slug);
    const bot = commandExists("feishu-runtime") ? findBot(slug) : undefined;
    const current = bot ? readRuntimeConfig(bot) : undefined;
    const modes = workspaceOptions(args);
    await deploy({
      workspaceMode: modes.workspaceMode || current?.project?.workspaceMode, codexMode: modes.codexMode || current?.agents?.codexMode,
      slug, service: service as DeployOptions["service"], repo: valueAfter(args, "--repo"), workspaceName: valueAfter(args, "--workspace"),
      workspaceRoot: valueAfter(args, "--workspace-root"), branch: valueAfter(args, "--branch"),
      projectPath: valueAfter(args, '--cwd') || valueAfter(args, "--project", args.includes("--repo") || args.includes("--workspace") ? undefined : current?.project?.path || projectPath),
      name: valueAfter(args, "--name", current?.project?.name || DEFAULT_DISPLAY_NAME),
      model: valueAfter(args, "--model"), proxyMode: valueAfter(args, "--proxy-mode"),
      timeoutMs: options.timeoutMs, skipInstall: args.includes("--skip-install"),
      feishuMode: valueAfter(args, '--feishu-mode') as FeishuMode | undefined,
      feishuProfile: valueAfter(args, '--feishu-profile'), updateCodex: args.includes('--update-codex'),
    });
    return;
  }
  if (command === "setup") {
    const displayName = validateDisplayName(valueAfter(args, "--name", DEFAULT_DISPLAY_NAME));
    setupRuntime(slug, projectPath, displayName, workspaceOptions(args));
    writeStdout(`配置完成。下一步运行: feishu-ai-bot start --slug ${slug}`);
    return;
  }
  if (command === "configure") {
    configure(slug, projectPath, DEFAULT_DISPLAY_NAME, workspaceOptions(args));
    return;
  }
  if (["run", "start", "stop", "restart"].includes(command)) {
    Object.assign(process.env, resolveServiceEnvironment({ previous: readServiceEnvironment(slug) }));
    launchRuntime(command, args, slug);
    return;
  }
  if (command === "status") {
    writeResult(botStatus(slug, { allowFailure: true }), true);
    return;
  }
  if (command === "doctor") {
    run("feishu-runtime", ["bots", "doctor", slug, "--deep", "--json"], { inherit: true });
    return;
  }
  if (command === "verify") {
    const result = verifyRuntime(slug);
    writeResult(result, args.includes("--json"));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "mr") {
    if (args[0] !== "prepare" || !args[1]) {
      throw new Error("用法: feishu-ai-bot mr prepare <Codebase-MR-URL> [--json]");
    }
    writeResult(prepareMergeRequestReview(args[1]), true);
    return;
  }
  if (command === "skill") {
    if (args[0] !== "install") throw new Error("用法: feishu-ai-bot skill install");
    writeStdout(`Code Review skills 已安装（通用审查 + Codebase 入口）: ${installReviewSkill()}`);
    return;
  }
  if (command === "service") {
    const action = args[0];
    if (args[0] === "render") {
      writeStdout(
        renderSystemdUnit({
          slug,
          runtimePath: resolveExecutable("feishu-runtime"),
          pathEnv: process.env.PATH || "",
        }),
      );
      return;
    }
    if (args[0] === "render-supervisor") {
      writeStdout(
        renderSupervisorConfig({
          slug,
          runtimePath: resolveExecutable("feishu-runtime"),
          pathEnv: process.env.PATH || "",
          launcherPath: path.resolve(process.argv[1]),
        }),
      );
      return;
    }
    if (args[0] === "install") {
      const checked = await checkedEnvironment(args, slug);
      const unitPath = installSystemdUnit({ slug, enableNow: args.includes("--enable-now"), runtimeEnvironment: checked.values });
      writeStdout(`systemd user unit 已写入: ${unitPath}`);
      if (!args.includes("--enable-now")) {
        writeStdout(`应用并启动: feishu-ai-bot service install --slug ${slug} --enable-now`);
      }
      return;
    }
    throw new Error(`未知 service 子命令: ${args[0] || ""}`);
  }
  throw new Error(`未知命令: ${command}\n\n${HELP}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
