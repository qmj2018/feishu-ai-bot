import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { BUILD_ROOT, PROJECT_ROOT } from '../src/paths.js';
import { reviewSkillInstalled } from '../src/review.js';

function outsideRepository(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bot-compiled-entry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8' as const, timeout: 15000 };
}

test('compiled CLI finds repository-managed skill resources from another working directory', t => {
  const options = outsideRepository(t);
  const result = spawnSync(process.execPath, [path.join(BUILD_ROOT, 'bin/feishu-ai-bot.js'), 'skill', 'install'], options);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(reviewSkillInstalled(options.env), true);
});

test('compiled dependency audit reads the package lock independently of caller directory', t => {
  const result = spawnSync(process.execPath, [path.join(BUILD_ROOT, 'scripts/audit-dependencies.js')], outsideRepository(t));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Dependency audit passed/);
});

test('compatibility runtime launcher executes the compiled runtime from another directory', { skip: process.platform === 'win32' }, t => {
  const result = spawnSync(path.join(PROJECT_ROOT, 'bin/feishu-runtime'), ['bots', 'list'], outsideRepository(t));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { bots: [] });
});


test('project CLI launcher is available without a global package link', { skip: process.platform === 'win32' }, t => {
  const result = spawnSync(path.join(PROJECT_ROOT, 'bin/feishu-ai-bot'), ['versions'], outsideRepository(t));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).bridge, '0.3.0');
});

test('the project exposes one generic CLI entry point and its help names both providers', { skip: process.platform === 'win32' }, t => {
  const result = spawnSync(path.join(PROJECT_ROOT, 'bin/feishu-ai-bot'), ['--help'], outsideRepository(t));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /feishu-ai-bot deploy/);
  assert.match(result.stdout, /Codex \/ Claude Code/);
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['feishu-ai-bot', 'feishu-runtime']);
  for (const file of Object.values(pkg.bin) as string[]) assert.ok(fs.statSync(path.join(PROJECT_ROOT, file)).isFile());
});
