import assert from "node:assert/strict";
import test from "node:test";
import { ensureUserLinger, renderSupervisorConfig, renderSystemdUnit } from "../src/service.mjs";

test("ensureUserLinger leaves an already enabled user unchanged", () => {
  const calls = [];
  ensureUserLinger({
    userId: "1000", exists: () => true,
    commandRunner: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "yes\n" };
    },
  });
  assert.deepEqual(calls, [["loginctl", "show-user", "1000", "--property=Linger", "--value"]]);
});

test("ensureUserLinger enables without a password prompt and verifies the result", () => {
  const calls = [];
  const results = [{ status: 0, stdout: "no\n" }, { status: 0, stdout: "" }, { status: 0, stdout: "yes\n" }];
  ensureUserLinger({
    userId: "1000", exists: () => true,
    commandRunner: (command, args) => {
      calls.push([command, ...args]);
      return results.shift();
    },
  });
  assert.deepEqual(calls[1], ["loginctl", "--no-ask-password", "enable-linger", "1000"]);
  assert.equal(results.length, 0);
});

test("ensureUserLinger fails closed on missing tools, denied access, or failed verification", () => {
  assert.throws(() => ensureUserLinger({ userId: "1000", exists: () => false }), /loginctl enable-linger 1000/);
  for (const results of [
    [{ status: 1, stdout: "" }],
    [{ status: 0, stdout: "unknown" }],
    [{ status: 0, stdout: "no" }, { status: 1, stdout: "" }],
    [{ status: 0, stdout: "no" }, { status: 0, stdout: "" }, { status: 0, stdout: "no" }],
  ]) {
    assert.throws(() => ensureUserLinger({
      userId: "1000", exists: () => true, commandRunner: () => results.shift(),
    }), /linger/);
  }
});

test("renderSystemdUnit uses foreground bind mode and hardening", () => {
  const unit = renderSystemdUnit({
    slug: "codex-devbox",
    runtimePath: "/opt/node/bin/feishu-runtime",
    pathEnv: "/opt/node/bin:/usr/bin",
    home: "/data/home/dev",
  });
  assert.match(unit, /bots start codex-devbox --foreground/);
  assert.doesNotMatch(unit, /--nobind/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /Environment="HOME=\/data\/home\/dev"/);
  assert.match(unit, /Environment="NPM_CONFIG_PREFIX=\/data\/home\/dev\/\.local"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /ExecStop="\/opt\/node\/bin\/feishu-runtime" bots stop codex-devbox/);
  assert.match(unit, /EnvironmentFile=-\/data\/home\/dev\/\.config\/devbox-codex-bot\/codex-devbox.proxy.env/);
  assert.doesNotMatch(unit, /EnvironmentFile=-?"/);
});

test("systemd escapes percent specifiers without exposing proxy values", () => {
  const unit = renderSystemdUnit({ slug: "other-bot", runtimePath: "/opt/100%/feishu-runtime", pathEnv: "/usr/bin", home: "/home/100%" });
  assert.match(unit, /100%%/);
  assert.match(unit, /EnvironmentFile=-\/home\/100%%/);
});

test("supervisor launcher loads saved environment instead of printing credentials", () => {
  const config = renderSupervisorConfig({ slug: "other-bot", runtimePath: "/opt/bin/feishu-runtime", launcherPath: "/opt/bot/bin/devbox-codex-bot.mjs", pathEnv: "/usr/bin", home: "/home/dev", user: "dev" });
  assert.match(config, /command="\/opt\/bot\/bin\/devbox-codex-bot.mjs" run --slug other-bot/);
  assert.doesNotMatch(config, /CODEX_CONFIG|HTTPS_PROXY/);
});

test("renderSystemdUnit rejects non-absolute executable paths", () => {
  assert.throws(() =>
    renderSystemdUnit({ slug: "codex-devbox", runtimePath: "feishu-runtime", pathEnv: "/usr/bin" }),
  );
});

test("renderSupervisorConfig uses foreground mode and TERM shutdown", () => {
  const config = renderSupervisorConfig({
    slug: "codex-devbox",
    runtimePath: "/opt/node/bin/feishu-runtime",
    pathEnv: "/opt/node/bin:/usr/bin",
    home: "/home/dev",
    user: "dev",
  });
  assert.match(config, /command=\/opt\/node\/bin\/feishu-runtime bots start codex-devbox --foreground/);
  assert.doesNotMatch(config, /--nobind/);
  assert.match(config, /stopsignal=TERM/);
  assert.match(config, /stopasgroup=true/);
});
