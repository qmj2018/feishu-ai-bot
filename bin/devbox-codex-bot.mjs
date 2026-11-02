#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploy, prepareRuntime } from "../src/deploy.mjs";
import {
  CODEX_ACP_VERSION,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_SLUG,
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
} from "../src/core.mjs";
import {
  installSystemdUnit,
  renderSupervisorConfig,
  renderSystemdUnit,
  resolveExecutable,
} from "../src/service.mjs";
import { listAvailableModels } from "../src/codex.mjs";
import { readServiceEnvironment, resolveServiceEnvironment } from "../src/runtime-env.mjs";
import {
  installReviewSkill,
  prepareMergeRequestReview,
  reviewSkillInstalled,
} from "../src/review.mjs";

const HELP = `devbox-codex-bot - Devbox 飞书 Codex 机器人安全部署工具

用法:
  devbox-codex-bot preflight [--project <git-dir>] [--json]
  devbox-codex-bot install
  devbox-codex-bot deploy [--slug <slug>] [--project <git-dir>] [--name <name>]
    [--model <id|auto>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>]
    [--skip-install] [--service <auto|systemd|manual>] [--no-service]
  devbox-codex-bot models [--slug <slug>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>]
  devbox-codex-bot probe [--slug <slug>] [--model <id|auto>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>] [--json]
  devbox-codex-bot run [--slug <slug>]
  devbox-codex-bot setup [--slug <slug>] [--name <name>] [--project <git-dir>]
  devbox-codex-bot configure [--slug <slug>] [--project <git-dir>]
  devbox-codex-bot start|stop|restart|status [--slug <slug>]
  devbox-codex-bot doctor [--slug <slug>]
  devbox-codex-bot verify [--slug <slug>] [--json]
  devbox-codex-bot mr prepare <Codebase-MR-URL> [--json]
  devbox-codex-bot skill install
  devbox-codex-bot service render [--slug <slug>]
  devbox-codex-bot service render-supervisor [--slug <slug>]
  devbox-codex-bot service install [--slug <slug>] [--enable-now] [--model <id|auto>] [--proxy-mode <auto|env|direct>] [--timeout <seconds>]
  devbox-codex-bot versions

安全默认值:
  bind 模式、Codex Agent、权限逐次询问、群聊仅 @ 回复、关闭裸 Shell、每会话 Git worktree。
`;

function valueAfter(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少值`);
  return value;
}

function common(args) {
  return {
    slug: validateSlug(valueAfter(args, "--slug", DEFAULT_SLUG)),
    projectPath: valueAfter(args, "--project", process.cwd()),
  };
}

function print(value, json = false) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function configure(slug, projectPath, displayName = DEFAULT_DISPLAY_NAME) {
  const bot = findBot(slug);
  if (!bot) throw new Error(`Runtime 不存在: ${slug}；请先运行 setup`);
  const status = botStatus(slug, { allowFailure: true });
  if (!["stopped", "stale", "unverified"].includes(status.status)) {
    throw new Error(`Runtime 当前状态为 ${status.status}，请先 stop 再 configure`);
  }
  const current = readRuntimeConfig(bot);
  assertCredentials(current);
  const next = secureConfig(current, {
    projectPath: resolveProjectPath(projectPath),
    displayName,
  });
  replaceRuntimeConfig(slug, current, next);
  console.log(`安全配置已应用到 ${slug}，凭证未输出到终端。`);
}

function setupRuntime(slug, projectPath, displayName) {
  resolveProjectPath(projectPath);
  const { bot, created } = ensureBot(slug, displayName);
  const current = readRuntimeConfig(bot);
  if (!current.feishu?.appId || !current.feishu?.appSecret) {
    console.log("即将配置飞书官方 SDK 消息桥接。");
    run("feishu-runtime", ["bots", "setup", slug], { inherit: true });
  } else if (created) {
    throw new Error("新建 Runtime 出现非空凭证，拒绝继续，请运行 doctor 检查");
  }
  configure(slug, projectPath, displayName);
  console.log(`Codebase MR Review skill 已就绪: ${installReviewSkill()}`);
}

function runtimeOptions(args, slug) {
  const timeoutMs = Number(valueAfter(args, "--timeout", "60")) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error("--timeout 必须在 1-600 秒之间");
  const previous = readServiceEnvironment(slug);
  const values = resolveServiceEnvironment({ previous, proxyMode: valueAfter(args, "--proxy-mode") });
  return { values, env: { ...process.env, ...values }, timeoutMs };
}

async function checkedEnvironment(args, slug) {
  const { timeoutMs } = runtimeOptions(args, slug);
  return prepareRuntime({ slug, timeoutMs, model: valueAfter(args, "--model"), proxyMode: valueAfter(args, "--proxy-mode") });
}

function verifyRuntime(slug) {
  const bot = findBot(slug);
  if (!bot) throw new Error(`Runtime 不存在: ${slug}`);
  const paths = runtimePaths(bot);
  const config = readRuntimeConfig(bot);
  const metadata = JSON.parse(fs.readFileSync(paths.metadata, "utf8"));
  const status = botStatus(slug, { allowFailure: true });
  const issues = inspectSecurity(config, metadata, { ...status, nobind: status.state?.nobind ?? status.nobind });
  if (!reviewSkillInstalled()) issues.push("Codebase MR Review skill 未安装，请运行 skill install");
  if (fileMode(paths.config) !== 0o600) issues.push("feishu-runtime.json 权限必须为 0600");
  if (fileMode(paths.metadata) !== 0o600) issues.push("runtime.json 权限必须为 0600");
  return { ok: issues.length === 0, slug, status: status.status, issues };
}

async function main() {
  Object.assign(process.env, normalizeHomeEnv());
  process.env.NPM_CONFIG_PREFIX ||= path.join(process.env.HOME, ".local");
  process.env.PATH = [path.join(process.env.HOME, ".local", "bin"), process.env.PATH, fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../node_modules/.bin", import.meta.url))].filter(Boolean).join(path.delimiter);
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }
  const { slug, projectPath } = common(args);
  if (command === "versions") {
    print({ bridge: BRIDGE_VERSION, codexAcp: CODEX_ACP_VERSION }, true);
    return;
  }
  if (command === "preflight") {
    const checks = preflight(projectPath);
    if (args.includes("--json")) print({ ok: checks.every((item) => item.ok), checks }, true);
    else for (const item of checks) console.log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.message}`);
    if (checks.some((item) => !item.ok)) process.exitCode = 1;
    return;
  }
  if (command === "install") {
    installPinnedPackages();
    const skillPath = installReviewSkill();
    console.log(`已安装 Feishu Bridge ${BRIDGE_VERSION} 和 codex-acp ${CODEX_ACP_VERSION}`);
    console.log(`已安装 Codebase MR Review skill: ${skillPath}`);
    return;
  }
  if (command === "models") {
    print(await listAvailableModels(runtimeOptions(args, slug)), true);
    return;
  }
  if (command === "probe") {
    const checked = await checkedEnvironment(args, slug);
    print(checked.probe, args.includes("--json"));
    return;
  }
  if (command === "deploy") {
    if (args.includes("--help") || args.includes("-h")) { console.log(HELP); return; }
    const booleans = new Set(["--skip-install", "--no-service"]);
    const flags = new Set(["--slug", "--project", "--name", "--model", "--proxy-mode", "--timeout", "--service", ...booleans]);
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
    await deploy({
      slug, service, projectPath: valueAfter(args, "--project", current?.project?.path || projectPath),
      name: valueAfter(args, "--name", current?.project?.name || DEFAULT_DISPLAY_NAME),
      model: valueAfter(args, "--model"), proxyMode: valueAfter(args, "--proxy-mode"),
      timeoutMs: options.timeoutMs, skipInstall: args.includes("--skip-install"),
    });
    return;
  }
  if (command === "setup") {
    const displayName = validateDisplayName(valueAfter(args, "--name", DEFAULT_DISPLAY_NAME));
    setupRuntime(slug, projectPath, displayName);
    console.log(`配置完成。下一步运行: devbox-codex-bot start --slug ${slug}`);
    return;
  }
  if (command === "run") {
    Object.assign(process.env, readServiceEnvironment(slug));
    run("feishu-runtime", ["bots", "start", slug, "--foreground"], { inherit: true });
    return;
  }
  if (command === "configure") {
    configure(slug, projectPath);
    return;
  }
  if (["start", "stop", "restart"].includes(command)) {
    Object.assign(process.env, readServiceEnvironment(slug));
    const actionArgs = ["bots", command, slug];
    run("feishu-runtime", actionArgs, { inherit: true });
    return;
  }
  if (command === "status") {
    print(botStatus(slug, { allowFailure: true }), true);
    return;
  }
  if (command === "doctor") {
    run("feishu-runtime", ["bots", "doctor", slug, "--deep", "--json"], { inherit: true });
    return;
  }
  if (command === "verify") {
    const result = verifyRuntime(slug);
    print(result, args.includes("--json"));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "mr") {
    if (args[0] !== "prepare" || !args[1]) {
      throw new Error("用法: devbox-codex-bot mr prepare <Codebase-MR-URL> [--json]");
    }
    print(prepareMergeRequestReview(args[1]), true);
    return;
  }
  if (command === "skill") {
    if (args[0] !== "install") throw new Error("用法: devbox-codex-bot skill install");
    console.log(`Codebase MR Review skill 已安装: ${installReviewSkill()}`);
    return;
  }
  if (command === "service") {
    const action = args[0];
    if (args[0] === "render") {
      console.log(
        renderSystemdUnit({
          slug,
          runtimePath: resolveExecutable("feishu-runtime"),
          pathEnv: process.env.PATH || "",
        }),
      );
      return;
    }
    if (args[0] === "render-supervisor") {
      console.log(
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
      console.log(`systemd user unit 已写入: ${unitPath}`);
      if (!args.includes("--enable-now")) {
        console.log(`应用并启动: devbox-codex-bot service install --slug ${slug} --enable-now`);
      }
      return;
    }
    throw new Error(`未知 service 子命令: ${action || ""}`);
  }
  throw new Error(`未知命令: ${command}\n\n${HELP}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
