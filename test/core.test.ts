import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  inspectSecurity,
  preflight,
  run,
  normalizeHomeEnv,
  runtimePaths,
  secureConfig,
  validateDisplayName,
  validateSlug,
} from "../src/core.js";

test("run treats signal termination as failure and preserves signal diagnostics", () => {
  const args = ["-e", 'process.kill(process.pid, "SIGTERM")'];
  const result = run(process.execPath, args, { allowFailure: true });
  assert.equal(result.status, 128 + os.constants.signals.SIGTERM);
  assert.equal(result.signal, "SIGTERM");
  assert.throws(() => run(process.execPath, args), /SIGTERM/);
});

test("run preserves normal exit codes and reports missing executables as failures", () => {
  assert.equal(run(process.execPath, ["-e", "process.exit(0)"]).status, 0);
  assert.equal(run(process.execPath, ["-e", "process.exit(7)"], { allowFailure: true }).status, 7);
  assert.notEqual(run("/nonexistent/bot-test-command", [], { allowFailure: true }).status, 0);
});

test("preflight validates tool execution and distinguishes missing Codex from missing auth", () => {
  for (const scenario of ["ready", "missing", "broken", "logged-out"]) {
    const calls = [];
    const checks = preflight("/work/repo", {
      env: { CODEX_PATH: '/specified/codex' },
      resolveProject: (value) => value,
      exists: (command) => !(scenario === "missing" && command === "/specified/codex"),
      commandRunner: (command, args) => {
        calls.push([command, ...args]);
        const failed = command === "/specified/codex" && (
          (scenario === "broken" && args[0] === "--version") ||
          (scenario === "logged-out" && args[0] === "login")
        );
        return { status: failed ? 1 : 0, stdout: failed ? "" : `${command} version`, stderr: "" };
      },
    });
    assert.equal(checks.find((item) => item.name === "node").ok, true);
    assert.equal(checks.find((item) => item.name === "codex").ok, ["ready", "logged-out"].includes(scenario));
    const auth = checks.find((item) => item.name === "codex-auth");
    if (["missing", "broken"].includes(scenario)) {
      assert.equal(auth, undefined);
      assert.ok(!calls.some((args) => args.includes("login")));
    } else {
      assert.equal(auth.ok, scenario === "ready");
      if (!auth.ok) assert.match(auth.message, /设备登录/);
    }
    assert.ok(calls.some(([command, arg]) => command === "npm" && arg === "--version"));
  }
});

test("preflight rejects a broken npm executable", () => {
  const checks = preflight("/work/repo", {
    resolveProject: (value) => value,
    exists: () => true,
    commandRunner: (command) => ({ status: command === "npm" ? 1 : 0, stdout: "version", stderr: "" }),
  });
  assert.equal(checks.find((item) => item.name === "npm").ok, false);
});

test("normalizeHomeEnv resolves a symlinked HOME", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bot-home-"));
  const realHome = path.join(root, "real");
  const linkedHome = path.join(root, "linked");
  fs.mkdirSync(realHome);
  fs.symlinkSync(realHome, linkedHome);
  const normalized = normalizeHomeEnv({ HOME: linkedHome, PATH: "/usr/bin" });
  assert.equal(normalized.HOME, fs.realpathSync(realHome));
  assert.equal(normalized.PATH, "/usr/bin");
});

test("validateSlug accepts a safe named runtime slug", () => {
  assert.equal(validateSlug("feishu-ai-bot_1"), "feishu-ai-bot_1");
});

test("validateSlug rejects traversal, default, and uppercase", () => {
  for (const value of ["../bot", "default", "Codex", "", "a".repeat(33)]) {
    assert.throws(() => validateSlug(value));
  }
});

test("validateDisplayName rejects control characters", () => {
  assert.equal(validateDisplayName("Feishu AI Bot"), "Feishu AI Bot");
  assert.throws(() => validateDisplayName("bad\nname"));
});

test("secureConfig preserves credentials and enforces safe defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-config-"));
  const initialized = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const current = {
    feishu: { appId: "cli_test", appSecret: "secret", allowedUsers: ["ou_test"], enabled: true },
    permissions: { strategy: "allow", allowedTools: ["shell"] },
    group: { replyPolicy: "all" },
    shell: { enabled: true },
    custom: { keep: true },
  };
  const next = secureConfig(current, { projectPath: dir, displayName: "Bot" });
  assert.equal(next.feishu.appSecret, "secret");
  assert.equal(next.agents.defaultAgent, "codex");
  assert.equal(next.permissions.strategy, "ask");
  assert.deepEqual(next.permissions.allowedTools, []);
  assert.equal(next.group.replyPolicy, "mention");
  assert.equal(next.shell.enabled, false);
  assert.equal(next.project.path, fs.realpathSync(dir));
  assert.deepEqual(next.custom, { keep: true });
});

test("secureConfig rejects a subdirectory instead of the repository root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-root-"));
  const initialized = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const child = path.join(dir, "child");
  fs.mkdirSync(child);
  assert.throws(
    () => secureConfig({ feishu: {} }, { projectPath: child }),
    /Git 仓库根目录/,
  );
});

test("runtimePaths remains inside the configured data root", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bot-data-"));
  const paths = runtimePaths(
    { runtimeId: "123e4567-e89b-42d3-a456-426614174000", slug: "feishu-ai-bot" },
    { HOME: dataRoot },
  );
  assert.equal(
    paths.root,
    path.join(dataRoot, ".feishu-runtime", "bots", "123e4567-e89b-42d3-a456-426614174000"),
  );
  assert.throws(() =>
    runtimePaths(
      { runtimeId: "../../escape", slug: "feishu-ai-bot" },
      { HOME: dataRoot },
    ),
  );
});

test("inspectSecurity reports every unsafe runtime setting", () => {
  const issues = inspectSecurity(
    {
      feishu: {},
      agents: { defaultAgent: "traecli2" },
      permissions: { strategy: "allow", allowedTools: ["shell"] },
      shell: { enabled: true },
      group: { replyPolicy: "all" },
      weixin: { enabled: true },
    },
    { workspaceMode: "shared" },
    { nobind: true },
  );
  assert.equal(issues.length, 10);
});

test("inspectSecurity accepts the hardened baseline", () => {
  const issues = inspectSecurity(
    {
      feishu: { appId: "cli_test", appSecret: "secret", allowedUsers: ["ou_test"] },
      agents: { defaultAgent: "codex" },
      permissions: { strategy: "ask", allowedTools: [] },
      shell: { enabled: false },
      group: { replyPolicy: "mention" },
      weixin: { enabled: false },
    },
    { workspaceMode: "per-session-worktree" },
    { nobind: false },
  );
  assert.deepEqual(issues, []);
});
