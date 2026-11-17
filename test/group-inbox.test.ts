import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { GroupInbox } from '../src/group-inbox.js';
import { Bridge } from '../src/bridge.js';
import { saveJson } from '../src/storage.js';

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-groups-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function event(id, text, owner = 'ou_owner', extra = {}) { return { sender: { sender_type: 'user', sender_id: { open_id: owner } },
  message: { message_id: id, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), ...extra } }; }
const mention = [{ key: '@bot', id: { open_id: 'ou_bot' } }];
const drain = async bridge => { await Promise.all([...bridge.queues.values()].map(q => q.chain)); };
function deferred() { let resolve; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve: () => resolve() }; }
function project(t) {
  const root = temporary(t), repo = path.join(root, 'repo');
  for (const args of [['init', '-q', repo], ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init']]) assert.equal(spawnSync('git', args).status, 0);
  return { root, repo };
}
test('only explicitly selected groups are recorded; non-whitelisted senders are passive data', t => {
  const root = temporary(t), inbox = new GroupInbox(root);
  inbox.observe(event('m1', 'not selected'), []); assert.equal(fs.existsSync(inbox.file), false);
  inbox.observe(event('m2', 'group discussion', 'ou_guest'), ['oc_group']);
  inbox.observe(event('m2', 'duplicate'), ['oc_group']);
  inbox.observe(event('private', 'private', 'ou_guest', { chat_type: 'p2p' }), ['oc_group']);
  inbox.observe(event('other', 'other', 'ou_guest', { chat_id: 'oc_other' }), ['oc_group']);
  assert.deepEqual(inbox.recent('oc_group').map(x => x.text), ['group discussion']);
  assert.equal(fs.statSync(inbox.file).mode & 0o777, 0o600);
  assert.equal(new GroupInbox(root).recent('oc_group').length, 1);
});
test('post text and attachment placeholders are recorded without downloading attachments', t => {
  const inbox = new GroupInbox(temporary(t));
  inbox.observe(event('post', '', 'ou_owner', { message_type: 'post', content: JSON.stringify({ zh_cn: { title: 'topic', content: [[{ tag: 'text', text: 'discussion' }]] } }) }), ['oc_group']);
  inbox.observe(event('image', '', 'ou_owner', { message_type: 'image', content: '{}' }), ['oc_group']);
  assert.deepEqual(inbox.recent('oc_group').map(x => x.text), ['topic\ndiscussion', '[image]']);
});
test('group history is bounded, expires after seven days and truncates oversized messages', t => {
  const root = temporary(t);
  saveJson(path.join(root, 'group-inbox.json'), Array.from({ length: 600 }, (_, i) => ({ id: String(i), chat: `oc_${Math.floor(i / 120)}`, timestamp: Date.now() - 1000 + i, text: 'data' }))
    .concat([{ id: 'expired', chat: 'oc_expired', timestamp: Date.now() - 8 * 24 * 3600_000, text: 'old' }]));
  const inbox = new GroupInbox(root);
  assert.equal(inbox.entries.length, 500); assert.equal(inbox.recent('oc_0', 100).length, 100);
  assert.deepEqual(inbox.recent('oc_expired'), []);
  assert.ok(!JSON.parse(fs.readFileSync(inbox.file, 'utf8')).some(item => item.id === 'expired'));
  inbox.observe(event('large', '😀'.repeat(5000)), ['oc_group']);
  const latest = inbox.recent('oc_group')[0]; assert.equal(Array.from(latest.text).length, 4000); assert.equal(latest.truncated, true);
  assert.throws(() => inbox.recent('oc_group', 101), /1-100/);
});
test('authorized users can task the agent in any joined group, with no per-group task permission', async t => {
  const { root, repo } = project(t), calls = [];
  const bridge = new Bridge({ root: path.join(root, 'runtime'), config: { feishu: { allowedUsers: ['ou_owner', 'ou_second'] }, project: { path: repo } },
    botId: 'ou_bot', send: async () => {}, agentFactory: async options => { calls.push(options); return {
      sessionId: 's' + calls.length, close() {}, async cancel() {}, async setModel() {}, async prompt() { return { stopReason: 'end_turn' }; },
    }; } });
  bridge.handle(event('ordinary', 'no mention'));
  bridge.handle(event('guest', '@bot do work', 'ou_guest', { mentions: mention }));
  assert.equal(bridge.queues.size, 0);
  bridge.handle(event('first', '@bot first task', 'ou_owner', { mentions: mention }));
  bridge.handle(event('second', '@bot second task', 'ou_second', { mentions: mention }));
  await drain(bridge);
  assert.equal(calls.length, 2); assert.notEqual(calls[0].cwd, calls[1].cwd);
  assert.equal(Object.keys(bridge.state.sessions).length, 2);
  assert.equal(bridge.inbox.entries.length, 0);
});
test('monitoring captures ordinary group messages without prompting, replying or reacting', async t => {
  const root = temporary(t), calls = [];
  const bridge = new Bridge({ root, config: { feishu: { allowedUsers: ['ou_owner'] }, group: { listenChats: ['oc_group'] } }, botId: 'ou_bot',
    send: async () => { calls.push('reply'); }, agentFactory: async () => { throw new Error('must not start'); },
    workingReaction: { async add() { calls.push('reaction'); return 'r'; }, async remove() {} } });
  bridge.handle(event('ordinary', 'please run something'));
  bridge.handle(event('guest', '@bot run something', 'ou_guest', { mentions: mention }));
  assert.equal(bridge.inbox.recent('oc_group').length, 2); assert.equal(bridge.queues.size, 0); assert.deepEqual(calls, []);
});
test('access and group changes reload on messages without restarting, and removed users cannot run queued tasks', async t => {
  const { root, repo } = project(t), started = deferred(), finish = deferred(), prompts = [];
  let config = { feishu: { allowedUsers: ['ou_owner'] }, project: { path: repo }, group: { listenChats: [] } };
  const bridge = new Bridge({ root: path.join(root, 'runtime'), config, loadConfig: () => config, botId: 'ou_bot', send: async () => {},
    agentFactory: async options => ({ sessionId: 's', close() {}, async cancel() {}, async setModel() {},
      async prompt(text) { prompts.push(text); if (text === 'first') { started.resolve(); await finish.promise; } return { stopReason: 'end_turn' }; } }),
  });
  bridge.handle(event('rejected', '@bot task', 'ou_second', { mentions: mention })); assert.equal(bridge.queues.size, 0);
  config = { ...config, feishu: { allowedUsers: ['ou_owner', 'ou_second'] }, group: { listenChats: ['oc_group'] } };
  bridge.handle(event('added', '@bot added', 'ou_second', { mentions: mention })); await drain(bridge);
  assert.deepEqual(prompts, ['added']); assert.equal(bridge.inbox.recent('oc_group').length, 1);
  bridge.handle(event('first', '@bot first', 'ou_second', { mentions: mention })); await started.promise;
  bridge.handle(event('queued', '@bot queued', 'ou_second', { mentions: mention }));
  config = { ...config, feishu: { allowedUsers: ['ou_owner'] }, group: { listenChats: [] } };
  finish.resolve(); await drain(bridge);
  bridge.handle(event('removed', '@bot new', 'ou_second', { mentions: mention }));
  assert.deepEqual(prompts, ['added', 'first']); assert.equal(bridge.queues.size, 0);
  assert.ok(!bridge.inbox.entries.some(item => item.id === 'removed'));
});
test('unreadable refreshed configuration cannot fall back to a stale user permission', t => {
  const root = temporary(t);
  const bridge = new Bridge({ root, config: { feishu: { allowedUsers: ['ou_owner'] } }, loadConfig: () => { throw new Error('offline'); },
    send: async () => {}, botId: 'ou_bot' });
  bridge.handle(event('task', '@bot task', 'ou_owner', { mentions: mention }));
  assert.equal(bridge.queues.size, 0); assert.equal(bridge.state.seen.task, undefined);
});
