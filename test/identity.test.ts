import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { APP_ID } from '../src/identity.js';
import { LEGACY_APP_ID, LEGACY_DEFAULT_SLUG, defaultBotSlug, legacyServiceUnit } from '../src/legacy.js';
import { readServiceEnvironment, renderServiceEnvironment, writeServiceEnvironment } from '../src/runtime-env.js';
import { stopLegacySystemdUnit, systemdUnitName } from '../src/service.js';
import { prepareWorkspace } from '../src/workspaces.js';
import { configureFeishuApplication } from '../src/feishu-setup.js';

function home(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('new installs use the generic default while existing default bots stay addressable', t => {
  const directory = home(t), env = { HOME: directory };
  const add = (id: string, slug: string, archived = false) => {
    const file = path.join(directory, '.feishu-runtime', 'bots', id, 'runtime.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ slug, archived }));
  };
  assert.equal(defaultBotSlug(env), APP_ID);
  add('legacy', LEGACY_DEFAULT_SLUG);
  assert.equal(defaultBotSlug(env), LEGACY_DEFAULT_SLUG);
  add('legacy', LEGACY_DEFAULT_SLUG, true);
  assert.equal(defaultBotSlug(env), APP_ID);
  add('legacy', LEGACY_DEFAULT_SLUG);
  add('current', APP_ID);
  assert.equal(defaultBotSlug(env), APP_ID);
});

test('legacy service settings remain readable and new settings take precedence without overwriting the old file', t => {
  const directory = home(t), env = { HOME: directory };
  const legacy = path.join(directory, '.config', LEGACY_APP_ID, 'test.proxy.env');
  const original = renderServiceEnvironment({ HTTPS_PROXY: 'http://saved.example', CODEX_CONFIG: '{"model":"saved"}' });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, original, { mode: 0o600 });
  assert.equal(readServiceEnvironment('test', env).HTTPS_PROXY, 'http://saved.example');
  const current = writeServiceEnvironment('test', { HTTPS_PROXY: '' }, env);
  assert.equal(current, path.join(fs.realpathSync(directory), '.config', APP_ID, 'test.proxy.env'));
  assert.deepEqual(readServiceEnvironment('test', env), { HTTPS_PROXY: '' });
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
  assert.equal(fs.statSync(current).mode & 0o777, 0o600);
});

test('legacy configuration symlinks remain rejected', t => {
  const directory = home(t), legacy = path.join(directory, '.config', LEGACY_APP_ID, 'test.proxy.env');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const victim = path.join(directory, 'keep');
  fs.writeFileSync(victim, 'unchanged');
  fs.symlinkSync(victim, legacy);
  assert.throws(() => readServiceEnvironment('test', { HOME: directory }), /普通文件/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged');
});

test('service migration stops and disables only the old unit and propagates stop failures', () => {
  const calls: string[][] = [];
  stopLegacySystemdUnit('test', { commandRunner: (_command, args) => {
    calls.push(args); return { status: 0, stdout: '', stderr: '' };
  } });
  assert.deepEqual(calls.map(args => args[1]), ['is-active', 'stop', 'is-enabled', 'disable']);
  assert.ok(calls.every(args => args.at(-1) === legacyServiceUnit('test')));
  assert.equal(systemdUnitName('test'), `${APP_ID}-test.service`);
  const failed: string[][] = [];
  assert.throws(() => stopLegacySystemdUnit('test', { commandRunner: (_command, args) => {
    failed.push(args); return { status: args[1] === 'stop' ? 1 : 0, stdout: '', stderr: '' };
  } }), /停止失败/);
  assert.deepEqual(failed.map(args => args[1]), ['is-active', 'stop']);
});

test('legacy workspaces preserve local edits and metadata while new workspaces use the new owner marker', t => {
  const directory = home(t), options = { name: 'test', empty: true, workspaceRoot: directory };
  const created = prepareWorkspace(options);
  const metadata = path.join(created.root, 'workspace.json');
  const saved = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  assert.equal(saved.managedBy, APP_ID);
  saved.managedBy = LEGACY_APP_ID;
  fs.writeFileSync(metadata, JSON.stringify(saved));
  const original = fs.readFileSync(metadata, 'utf8');
  fs.writeFileSync(path.join(created.project, 'local.txt'), 'keep local changes');
  assert.equal(prepareWorkspace(options).created, false);
  assert.equal(fs.readFileSync(path.join(created.project, 'local.txt'), 'utf8'), 'keep local changes');
  assert.equal(fs.readFileSync(metadata, 'utf8'), original);
  saved.managedBy = 'another-tool';
  fs.writeFileSync(metadata, JSON.stringify(saved));
  assert.throws(() => prepareWorkspace(options), /元数据无效/);
});

test('legacy publication checkpoints prevent duplicate application publishing after a rename', async t => {
  const directory = home(t), appId = 'cli_pending';
  const checkpoint = path.join(directory, '.local', 'share', LEGACY_APP_ID, 'feishu', `feishu-${appId}.json`);
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
  const original = JSON.stringify({ revision: 'bot-websocket-message-card-scopes-v1', versionId: 'existing' });
  fs.writeFileSync(checkpoint, original, { mode: 0o600 });
  const unexpected = async () => { throw new Error('must not republish'); };
  const api: any = { applicationAbility: { patch: unexpected }, applicationConfig: { patch: unexpected }, applicationPublish: { create: unexpected } };
  const credentials = { appId, appSecret: 'test-secret', domain: 'feishu' as const };
  const options = { api, env: { HOME: directory }, readOnlineVersion: async () => 'older' };
  await assert.rejects(configureFeishuApplication(credentials, options), /等待管理员审核/);
  await configureFeishuApplication(credentials, { ...options, readOnlineVersion: async () => 'existing' });
  assert.equal(fs.readFileSync(checkpoint, 'utf8'), original);
});
