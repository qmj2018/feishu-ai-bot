import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ensureLocalCodex, installedCodexVersion, localCodexPath } from '../src/local-codex.js';
import { writeServiceEnvironment } from '../src/runtime-env.js';

function executable(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\nconsole.log('codex-cli ${version}');\n`, { mode: 0o700 });
}

function machine(t, { current, failure, latest = '1.2.3' }: { current?: string; failure?: string; latest?: string } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-local-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'specified client', 'codex');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_PATH: file };
  delete env.NODE_TEST_CONTEXT;
  if (current) executable(file, current);
  const calls = [];
  const commandRunner = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number }) => {
    calls.push({ command, args });
    if (command !== 'npm') return spawnSync(command, args, { ...options, encoding: 'utf8' });
    if (args[0] === 'view') return { status: failure === 'query' ? 1 : 0, stdout: JSON.stringify(latest), stderr: 'private proxy secret' };
    const directory = args[args.indexOf('--prefix') + 1];
    executable(path.join(directory, 'node_modules/.bin/codex'), failure === 'invalid-version' ? '0.0.1' : latest);
    return { status: failure === 'install' ? 1 : 0, stdout: '' };
  };
  return { home, file, env, calls, options: { env, log() {} }, dependencies: { commandRunner } };
}

test('latest local Codex is reused and a newer local release is never downgraded', async t => {
  for (const current of ['1.2.3', '1.3.0']) {
    const m = machine(t, { current });
    const result = await ensureLocalCodex(m.options, m.dependencies);
    assert.equal(result.version, current);
    assert.equal(result.updated, false);
    assert.ok(!m.calls.some(call => call.args[0] === 'install'));
    assert.equal(fs.lstatSync(m.file).isFile(), true);
  }
});

test('missing Codex is installed at the requested path from the exact official stable package', async t => {
  const m = machine(t);
  const result = await ensureLocalCodex(m.options, m.dependencies);
  assert.equal(result.path, m.file);
  assert.equal(result.updated, true);
  assert.equal(installedCodexVersion(m.file, m.env), '1.2.3');
  const install = m.calls.find(call => call.args[0] === 'install');
  assert.ok(install.args.includes('@openai/codex@1.2.3'));
  assert.ok(install.args.includes('--registry=https://registry.npmjs.org/'));
});

test('explicit upgrades replace the entry atomically and retain the old executable behind a symlink', async t => {
  const m = machine(t);
  const old = path.join(m.home, 'previous/codex');
  executable(old, '1.0.0');
  fs.mkdirSync(path.dirname(m.file), { recursive: true });
  fs.symlinkSync(old, m.file);
  await ensureLocalCodex({ ...m.options, update: true }, m.dependencies);
  assert.equal(installedCodexVersion(m.file, m.env), '1.2.3');
  assert.equal(installedCodexVersion(old, m.env), '1.0.0');
  const backup = fs.readdirSync(path.dirname(m.file)).find(name => name.includes('.before-ai-bot-'));
  assert.equal(fs.readlinkSync(path.join(path.dirname(m.file), backup)), old);
});

test('registry, download and candidate validation failures preserve the installed client', async t => {
  for (const failure of ['query', 'install', 'invalid-version']) {
    const m = machine(t, { current: '1.0.0', failure });
    const original = fs.readFileSync(m.file);
    await assert.rejects(ensureLocalCodex({ ...m.options, update: true }, m.dependencies), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private proxy secret/);
      return true;
    });
    assert.deepEqual(fs.readFileSync(m.file), original);
    assert.equal(fs.existsSync(`${m.file}.ai-bot-update.lock`), false);
    const releases = path.join(m.home, '.local/share/feishu-ai-bot/codex');
    if (fs.existsSync(releases)) assert.deepEqual(fs.readdirSync(releases), []);
  }
});

test('simultaneous startups share one installation and recover a dead updater lock', async t => {
  const m = machine(t);
  fs.mkdirSync(path.dirname(m.file), { recursive: true });
  fs.writeFileSync(`${m.file}.ai-bot-update.lock`, '2147483647');
  const results = await Promise.all([ensureLocalCodex(m.options, m.dependencies), ensureLocalCodex(m.options, m.dependencies)]);
  assert.deepEqual(results.map(r => r.updated).sort(), [false, true]);
  assert.equal(m.calls.filter(call => call.args[0] === 'install').length, 1);
});

test('relative paths and non-stable registry metadata are rejected before installing', async t => {
  assert.throws(() => localCodexPath({ CODEX_PATH: 'codex' }), /绝对路径/);
  const m = machine(t, { latest: '1.2.4-alpha' });
  await assert.rejects(ensureLocalCodex(m.options, m.dependencies), /最新稳定版/);
  assert.ok(!m.calls.some(call => call.args[0] === 'install'));
});

test('foreground runtime loads its saved Codex path without querying npm for an installed client', t => {
  const m = machine(t, { current: '1.2.3' });
  const bin = path.join(m.home, 'test-bin');
  fs.mkdirSync(bin);
  const trace = path.join(m.home, 'update-trace');
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(trace)},'checked');\nconsole.log(JSON.stringify('1.2.3'));\n`, { mode: 0o700 });
  const root = path.join(m.home, '.feishu-runtime/bots/123e4567-e89b-42d3-a456-426614174000');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({ slug: 'boot-bot', runtimeId: path.basename(root) }));
  // An invalid project stops the boot after the update check, without real SDK/network access.
  fs.writeFileSync(path.join(root, 'feishu-runtime.json'), JSON.stringify({ feishu: { appId: 'test', appSecret: 'test', allowedUsers: ['ou_test'] }, project: { path: path.join(m.home, 'missing-project') } }));
  writeServiceEnvironment('boot-bot', { CODEX_PATH: m.file }, m.env);
  const env: NodeJS.ProcessEnv = { ...m.env, PATH: [bin, process.env.PATH].join(path.delimiter) };
  delete env.CODEX_PATH;
  const result = spawnSync(process.execPath, [new URL('../bin/feishu-runtime.js', import.meta.url).pathname, 'bots', 'start', 'boot-bot', '--foreground'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /复用本机 Codex 1\.2\.3/);
  assert.equal(fs.existsSync(trace), false);
  assert.equal(fs.existsSync(path.join(root, 'process.lock')), false);
});

test('an installed Codex is reused even offline, without registry queries or installation', async t => {
  const m = machine(t, { current: '1.0.0', failure: 'query' });
  const original = fs.readFileSync(m.file);
  const result = await ensureLocalCodex(m.options, m.dependencies);
  assert.equal(result.updated, false);
  assert.ok(!m.calls.some(call => call.command === 'npm'));
  assert.deepEqual(fs.readFileSync(m.file), original);
});
