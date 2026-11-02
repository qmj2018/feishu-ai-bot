import assert from "node:assert/strict";
import test from "node:test";
import { deploy } from "../src/deploy.mjs";
import { run } from "../src/core.mjs";

function fixture({ systemd = true, authenticated = true, existing = false, running = true, fail } = {}) {
  const calls = [];
  const dependencies = {
    platform: "linux",
    resolveProject: (value) => value,
    check: () => [
      { name: "node", ok: true, message: "ready" },
      { name: "codex-auth", ok: authenticated, message: "auth" },
    ],
    exists: () => systemd,
    lookup: () => existing ? { slug: "test" } : undefined,
    status: () => ({ status: running ? "running" : "stopped" }),
    sleep: async () => {},
    log: () => {},
    ensureLinger: () => { calls.push({ command: "ensure-linger", args: [] }); },
    prepareEnvironment: async () => ({ env: process.env, values: {}, probe: { model: "test-model", elapsedMs: 1 } }),
    persistEnvironment: () => {},
    installService: () => { calls.push({ command: "install-service", args: ["--enable-now"] }); },
    commandRunner: (command, args, options) => {
      calls.push({ command, args, options });
      if (fail?.(args)) throw new Error("simulated failure");
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
  const stopManager = args.findIndex((value) => value.includes("stop") && value.includes("devbox-codex-bot-test.service"));
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
  assert.ok(calls.some(({ command, args }) => command === "codex" && args.includes("--device-auth")));
  assert.ok(calls.some(({ args }) => args[1] === "start"));
  assert.ok(!calls.some(({ args }) => args.includes("--enable-now")));
});

test("--no-service skips enabling systemd", async () => {
  const { calls, dependencies } = fixture();
  await deploy({ ...options, service: false }, dependencies);
  assert.ok(!calls.some(({ args }) => args.includes("--enable-now")));
  assert.ok(!calls.some(({ command }) => command === "ensure-linger"));
});

test("linger failure aborts before installing packages or stopping a runtime", async () => {
  const { calls, dependencies } = fixture({ existing: true });
  await assert.rejects(deploy(options, {
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
    ...dependencies, check: () => [{ name: "npm", ok: false }],
  }), /npm/);
  assert.equal(calls.length, 0);
});

test("failed setup stops the pipeline and reports its stage", async () => {
  const { calls, dependencies } = fixture({ fail: (args) => args[1] === "setup" });
  await assert.rejects(deploy(options, dependencies), /飞书配置和安全基线.*simulated failure/);
  assert.ok(!calls.some(({ args }) => args.includes("--enable-now") || args[1] === "start"));
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
