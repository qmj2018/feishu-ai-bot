import assert from "node:assert/strict";
import test from "node:test";
import { deploy } from "../src/deploy.js";
import { run } from "../src/core.js";
import { legacyServiceUnit } from '../src/legacy.js';

function fixture({ systemd = true, authenticated = true, existing = false, running = true, fail }: { systemd?: boolean; authenticated?: boolean; existing?: boolean; running?: boolean; fail?: (args: string[]) => boolean } = {}) {
  const calls = [];
  const dependencies: NonNullable<Parameters<typeof deploy>[1]> = {
    platform: "linux",
    resolveProject: (value) => value,
    check: () => [
      { name: "node", ok: true, message: "ready" },
      { name: "codex-auth", ok: authenticated, message: "auth" },
    ],
    exists: () => systemd,
    lookup: () => existing ? { slug: "test", runtimeId: "123e4567-e89b-42d3-a456-426614174000" } : undefined,
    status: () => ({ status: running ? "running" : "stopped" }),
    sleep: async () => {},
    log: () => {},
    ensureLinger: () => { calls.push({ command: "ensure-linger", args: [] }); },
    prepareFeishu: async ({ env }) => env,
    ensureCodex: async () => { calls.push({ command: 'ensure-codex', args: [] }); return { path: '/specified/codex', version: '1.2.3', latest: '1.2.3', updated: false }; },
    prepareEnvironment: async () => ({ env: process.env, values: {}, probe: { ok: true, model: "test-model", elapsedMs: 1 } }),
    persistEnvironment: () => "/tmp/env",
    installService: () => { calls.push({ command: "install-service", args: ["--enable-now"] }); return "/tmp/test.service"; },
    commandRunner: (command, args, options) => {
      calls.push({ command, args, options });
      if (fail?.(args)) throw new Error("simulated failure");
      if (args.includes('--device-auth')) authenticated = true;
      if (command === '/specified/codex' && args[0] === 'login' && args[1] === 'status' && !authenticated) return { status: 1, stdout: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { calls, dependencies };
}

const options = { projectPath: "/work/repo with spaces", slug: "test", name: "Test Bot" };

test("deployment configures systemd, waits for running, then verifies", async () => {
  const { calls, dependencies } = fixture({ existing: true });
  const result = await deploy(options, dependencies);
  assert.equal(result.autostart, true);
  const args = calls.map((call) => call.args);
  const stopManager = args.findIndex((value) => value.includes("stop") && value.includes("feishu-ai-bot-test.service"));
  const setup = args.findIndex((value) => value[1] === "setup");
  assert.ok(stopManager >= 0 && stopManager < setup);
  assert.deepEqual(args[setup].slice(1), ["setup", "--slug", "test", "--name", "Test Bot", "--project", options.projectPath]);
  assert.ok(args.some((value) => value.includes("--enable-now")));
  assert.deepEqual(args.at(-1).slice(1), ["verify", "--slug", "test", "--json"]);
  assert.ok(args.every((value) => !value.includes("--nobind")));
});

test("deployment logs in when needed and falls back to daemon without systemd", async () => {
  const { calls, dependencies } = fixture({ systemd: false, authenticated: false });
  const result = await deploy(options, dependencies);
  assert.equal(result.autostart, false);
  assert.ok(calls.some(({ command, args }) => command === "/specified/codex" && args.includes("--device-auth")));
  assert.ok(calls.some(({ args }) => args[1] === "start"));
  assert.ok(!calls.some(({ args }) => args.includes("--enable-now")));
});

test('deployment retires a legacy unit before configuring and starting its replacement', async () => {
  const { calls, dependencies } = fixture({ existing: true });
  await deploy(options, dependencies);
  const previous = legacyServiceUnit('test');
  const stop = calls.findIndex(call => call.args[1] === 'stop' && call.args.includes(previous));
  const disable = calls.findIndex(call => call.args[1] === 'disable' && call.args.includes(previous));
  const setup = calls.findIndex(call => call.args[1] === 'setup');
  assert.ok(stop >= 0 && disable > stop && setup > disable);
});

test('a legacy unit stop failure prevents replacement setup and startup', async () => {
  const { calls, dependencies } = fixture({ existing: true });
  const original = dependencies.commandRunner!;
  await assert.rejects(deploy(options, { ...dependencies,
    commandRunner: (command, args, settings) => {
      const result = original(command, args, settings);
      return args[1] === 'stop' && args.includes(legacyServiceUnit('test')) ? { ...result, status: 1 } : result;
    },
  }), /旧服务停止失败/);
  assert.ok(!calls.some(call => call.args[1] === 'setup' || call.args.includes('--enable-now')));
});

test("--no-service skips enabling systemd", async () => {
  const { calls, dependencies } = fixture();
  await deploy({ ...options, service: false }, dependencies);
  assert.ok(!calls.some(({ args }) => args.includes("--enable-now")));
  assert.ok(!calls.some(({ command }) => command === "ensure-linger"));
});

test('WSL auto mode falls back to a daemon when systemd linger is unavailable', async () => {
  const { calls, dependencies } = fixture();
  const result = await deploy({ ...options, service: 'auto' }, { ...dependencies,
    ensureLinger() { throw new Error('not available in this WSL session'); } });
  assert.equal(result.autostart, false);
  assert.ok(calls.some(({ args }) => args[1] === 'start'));
  assert.ok(!calls.some(({ command }) => command === 'install-service'));
});

test('failed Feishu creation or login leaves the existing service running', async () => {
  const { calls, dependencies } = fixture({ existing: true });
  await assert.rejects(deploy(options, { ...dependencies,
    prepareFeishu: async () => { throw new Error('user canceled application setup'); } }), /飞书机器人配置和登录/);
  assert.ok(!calls.some(({ args }) => args.includes('stop') || args[1] === 'setup'));
});

test("explicit systemd mode aborts if linger cannot be enabled", async () => {
  const { calls, dependencies } = fixture({ existing: true });
  await assert.rejects(deploy({ ...options, service: 'systemd' }, {
    ...dependencies,
    ensureLinger: () => { throw new Error("linger denied"); },
  }), /后台服务环境检查.*linger denied/);
  assert.ok(!calls.some(({ args }) => args[1] === "install" || args.includes("stop")));
});

test("a signal-terminated deployment step aborts all subsequent stages", async () => {
  const { calls, dependencies } = fixture();
  await assert.rejects(deploy(options, {
    ...dependencies,
    commandRunner: () => run(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")']),
  }), /项目自检.*SIGTERM/);
  assert.equal(calls.length, 0);
});

test("invalid platform, missing project and failed prerequisites make no changes", async () => {
  const { calls, dependencies } = fixture();
  await assert.rejects(deploy(options, { ...dependencies, platform: "darwin" }), /Linux/);
  await assert.rejects(deploy({}, dependencies), /--project/);
  await assert.rejects(deploy(options, {
    ...dependencies, check: () => [{ name: "npm", ok: false, message: "missing" }],
  }), /npm/);
  assert.equal(calls.length, 0);
});

test("failed setup stops the pipeline and reports its stage", async () => {
  const { calls, dependencies } = fixture({ fail: (args) => args[1] === "setup" });
  await assert.rejects(deploy(options, dependencies), /飞书配置和安全基线.*simulated failure/);
  assert.ok(!calls.some(({ args }) => args.includes("--enable-now") || args[1] === "start"));
});

test('failed Codex update leaves the running service untouched even with skip-install', async () => {
  const { calls, dependencies } = fixture({ existing: true });
  await assert.rejects(deploy({ ...options, skipInstall: true }, {
    ...dependencies,
    ensureCodex: async () => { throw new Error('registry unavailable'); },
  }), /本机 Codex 检查.*registry unavailable/);
  assert.ok(!calls.some(({ args }) => args.includes('stop') || args[1] === 'setup'));
});

test("a runtime that never starts cannot report deployment success", async () => {
  const { calls, dependencies } = fixture({ running: false });
  await assert.rejects(deploy(options, dependencies), /30 秒内未进入 running/);
  assert.ok(!calls.some(({ command, args }) => command === process.execPath && args[1] === "verify"));
});

test("failed final verification is reported as deployment failure", async () => {
  const { dependencies } = fixture({ fail: (args) => args[1] === "verify" && args[0] !== "run" });
  await assert.rejects(deploy(options, dependencies), /运行状态和安全校验.*simulated failure/);
});


test("deployment installs runtime dependencies before running integration tests", async () => {
  const { calls, dependencies } = fixture();
  await deploy(options, dependencies);
  const install = calls.findIndex(({ args }) => args[1] === "install");
  const verify = calls.findIndex(({ command, args }) => command === "npm" && args[0] === "run" && args[1] === "verify");
  const setup = calls.findIndex(({ args }) => args[1] === "setup");
  assert.ok(install >= 0 && verify > install && setup > verify);
});

test('deployment can clone a repository and use the resulting workspace as project', async () => {
  const { calls, dependencies } = fixture();
  let requested;
  await deploy({ repo: 'https://git.example/team/project.git', workspaceName: 'new-project', slug: 'test' }, {
    ...dependencies,
    createWorkspace: options => { requested = options; return { name: 'new-project', repo: options.repo, branch: 'main', root: '/spaces/new-project', project: '/spaces/new-project/repo', created: true }; },
  });
  assert.equal(requested.repo, 'https://git.example/team/project.git');
  assert.equal(requested.name, 'new-project');
  const setup = calls.find(({ args }) => args[1] === 'setup');
  assert.equal(setup.args.at(-1), '/spaces/new-project/repo');
});

test('deployment rejects mixing an existing project with a remote workspace source', async () => {
  const { calls, dependencies } = fixture();
  await assert.rejects(deploy({ ...options, repo: 'https://git.example/team/project.git' }, dependencies), /不能与/);
  assert.equal(calls.length, 0);
});
