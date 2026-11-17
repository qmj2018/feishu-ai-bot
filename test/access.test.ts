import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { updateAccess } from '../src/access.js';
import { saveJson } from '../src/storage.js';
import { PROJECT_ROOT } from '../src/paths.js';

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-access-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const initial = { feishu: { appId: 'cli_test', appSecret: 'private-secret', allowedUsers: ['ou_owner'] }, project: { path: '/some/project' }, group: { replyPolicy: 'mention' } };
test('access edits are additive, idempotent, private, and preserve credentials and project settings', t => {
  const file = path.join(temporary(t), 'config.json'); saveJson(file, initial);
  updateAccess(file, 'users', 'add', ['ou_second', 'ou_third']);
  updateAccess(file, 'users', 'add', ['ou_second']);
  const result = updateAccess(file, 'groups', 'add', ['oc_first', 'oc_second']);
  assert.deepEqual(result.feishu.allowedUsers, ['ou_owner', 'ou_second', 'ou_third']);
  assert.deepEqual(result.group.listenChats, ['oc_first', 'oc_second']);
  assert.equal(result.group.replyPolicy, 'mention'); assert.deepEqual(result.project, initial.project);
  assert.equal(result.feishu.appSecret, initial.feishu.appSecret);
  updateAccess(file, 'users', 'remove', ['ou_second']);
  assert.deepEqual(updateAccess(file, 'groups', 'remove', ['oc_first']).group.listenChats, ['oc_second']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('invalid IDs, deleting the final user, and concurrent edits cannot change configuration', t => {
  const file = path.join(temporary(t), 'config.json'); saveJson(file, initial);
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => updateAccess(file, 'users', 'add', ['*']), /open_id/);
  assert.throws(() => updateAccess(file, 'groups', 'add', ['../outside']), /chat_id/);
  assert.throws(() => updateAccess(file, 'users', 'remove', ['ou_owner']), /最后一个/);
  fs.writeFileSync(file + '.edit.lock', String(process.pid));
  assert.throws(() => updateAccess(file, 'users', 'add', ['ou_second']), /其他进程/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file + '.edit.lock', '2147483647');
  assert.deepEqual(updateAccess(file, 'users', 'add', ['ou_second']).feishu.allowedUsers, ['ou_owner', 'ou_second']);
  assert.equal(fs.existsSync(file + '.edit.lock'), false);
});
test('CLI can manage a running bot without stopping it or printing its credentials', t => {
  const home = temporary(t), id = '123e4567-e89b-42d3-a456-426614174000';
  const root = path.join(home, '.feishu-runtime/bots', id), file = path.join(root, 'feishu-runtime.json');
  saveJson(file, initial); saveJson(path.join(root, 'runtime.json'), { slug: 'test', runtimeId: id });
  saveJson(path.join(root, 'process.json'), { pid: process.pid, ready: true });
  const invoke = (...args) => spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'dist/bin/feishu-ai-bot.js'), ...args, '--slug', 'test'], {
    env: { ...process.env, HOME: home, PATH: path.join(PROJECT_ROOT, 'bin') + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 10000,
  });
  const add = invoke('users', 'add', 'ou_second', 'ou_third');
  assert.equal(add.status, 0, add.stderr); assert.deepEqual(JSON.parse(add.stdout).users, ['ou_owner', 'ou_second', 'ou_third']);
  assert.doesNotMatch(add.stdout, /private-secret|appSecret/);
  assert.equal(invoke('groups', 'add', 'oc_group').status, 0);
  assert.deepEqual(JSON.parse(invoke('groups', 'list').stdout).groups, ['oc_group']);
  assert.equal(invoke('groups', 'messages', 'oc_group', '--limit', '20').status, 0);
  assert.equal(invoke('users', 'remove', 'ou_second').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'process.json'), 'utf8')).pid, process.pid);
  assert.equal(invoke('groups', 'add', 'oc_x', '--bad-flag').status, 1);
});
