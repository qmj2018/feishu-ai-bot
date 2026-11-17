import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROXY_KEYS, configuredModel, readServiceEnvironment, renderServiceEnvironment, resolveServiceEnvironment, serviceEnvironmentPath, writeServiceEnvironment } from "../src/runtime-env.js";

test("proxy is optional and direct mode clears inherited and saved proxies", () => {
  const previous = resolveServiceEnvironment({ env: { HTTPS_PROXY: "http://proxy.example:8118" }, model: "available-model" });
  const direct = resolveServiceEnvironment({ env: { HTTPS_PROXY: "http://other.example" }, previous, proxyMode: "direct" });
  for (const key of PROXY_KEYS) assert.equal(direct[key], "");
  assert.equal(configuredModel(direct), "available-model");
  const fresh = resolveServiceEnvironment({ env: {} });
  assert.equal(fresh.https_proxy, "");
  assert.throws(() => resolveServiceEnvironment({ env: {}, proxyMode: "env" }), /HTTPS_PROXY/);
});

test("repeated deployment preserves saved settings unless explicitly refreshed", () => {
  const previous = resolveServiceEnvironment({ env: { https_proxy: "http://saved.example", no_proxy: ".internal.example" }, model: "account-default" });
  assert.deepEqual(resolveServiceEnvironment({ previous, env: { HTTPS_PROXY: "http://new.example" } }), previous);
  const refreshed = resolveServiceEnvironment({ previous, env: { HTTPS_PROXY: "http://new.example" }, proxyMode: "auto", model: "chosen-model" });
  assert.equal(refreshed.https_proxy, "http://new.example");
  assert.equal(configuredModel(refreshed), "chosen-model");
});

test("private environment file round trips proxy credentials and model JSON", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-runtime-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, CODEX_PATH: path.join(home, 'my codex/bin/codex'), HTTPS_PROXY: "http://test:pa%25ss@proxy.example:8118", OPENAI_API_KEY: "must-not-be-copied" };
  const values = resolveServiceEnvironment({ env, model: "some-model" });
  const file = writeServiceEnvironment("test-bot", values, env);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readServiceEnvironment("test-bot", env), values);
  assert.equal(values.CODEX_PATH, env.CODEX_PATH);
  assert.equal(resolveServiceEnvironment({ env: { HOME: home }, previous: values }).CODEX_PATH, env.CODEX_PATH);
  assert.equal(resolveServiceEnvironment({ env: { HOME: home, CODEX_PATH: '/another/codex' }, previous: values }).CODEX_PATH, '/another/codex');
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /must-not-be-copied/);
  assert.equal(serviceEnvironmentPath("test-bot", env), file);
});

test("environment files reject injection, unexpected variables and symlinks", t => {
  assert.throws(() => renderServiceEnvironment({ HTTPS_PROXY: "http://proxy\nPATH=/bad" }), /无效/);
  assert.throws(() => renderServiceEnvironment({ PATH: "/bad" }), /无效/);
  assert.throws(() => renderServiceEnvironment({ CODEX_PATH: 'codex' }), /绝对路径/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-runtime-symlink-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home };
  const file = serviceEnvironmentPath("test-bot", env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const victim = path.join(home, "keep");
  fs.writeFileSync(victim, "unchanged");
  fs.symlinkSync(victim, file);
  assert.throws(() => readServiceEnvironment("test-bot", env), /普通文件/);
  assert.throws(() => writeServiceEnvironment("test-bot", {}, env), /普通文件/);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
});
