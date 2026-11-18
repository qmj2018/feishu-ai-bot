import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], replies = [];
  let id = 0;
  const config = { feishu: { allowedUsers: ['ou_owner', 'ou_other'] }, project: { path: root, workspaceMode: 'project-directory' as const } };
  const options = { root, config, send: async (_id, text) => replies.push(text), agentFactory: async options => {
    calls.push(options);
    return { sessionId: 'codex-session', close() {}, async cancel() {}, async setModel() {}, async prompt() { return { stopReason: 'end_turn' }; } };
  } };
  const event = (text, owner = 'ou_owner', chat = 'chat', thread = '') => ({
    sender: { sender_type: 'user', sender_id: { open_id: owner } },
    message: { message_id: String(++id), chat_id: chat, thread_id: thread, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) },
  });
  const send = async (bridge, text, owner?, chat?, thread?) => {
    bridge.handle(event(text, owner, chat, thread));
    await Promise.all([...bridge.queues.values()].map(q => q.chain));
  };
  return { root, options, calls, replies, event, send };
}

test('permission commands persist per user/chat/thread and apply to resumed Codex sessions', async t => {
  const f = fixture(t);
  let bridge = new Bridge(f.options);
  await f.send(bridge, '/permissions');
  assert.match(f.replies.at(-1), /Read Only/);
  assert.equal(Object.keys(bridge.state.sessions).length, 0);
  await f.send(bridge, 'first task');
  await f.send(bridge, '/permissions full-access');
  assert.equal(f.calls.length, 1); // No model prompt for a permission command.
  bridge = new Bridge(f.options);
  await f.send(bridge, 'resumed task');
  assert.equal(f.calls.at(-1).sessionId, 'codex-session');
  assert.equal(f.calls.at(-1).codexMode, 'agent-full-access');
  for (const [owner, chat, thread] of [['ou_other', 'chat', ''], ['ou_owner', 'other-chat', ''], ['ou_owner', 'chat', 'thread']]) {
    await f.send(bridge, 'isolated task', owner, chat, thread);
    assert.equal(f.calls.at(-1).codexMode, undefined);
  }
  await f.send(bridge, '/permissions agent');
  await f.send(bridge, 'write task');
  assert.equal(f.calls.at(-1).codexMode, 'agent');
  await f.send(bridge, '/permissions read-only');
  await f.send(bridge, 'read task');
  assert.equal(f.calls.at(-1).codexMode, 'read-only');
  await f.send(bridge, '/new');
  await f.send(bridge, 'new task');
  assert.equal(f.calls.at(-1).codexMode, undefined);
  assert.equal(f.calls.at(-1).sessionId, undefined);
});

test('invalid and unauthorized permission commands never change permissions or prompt the agent', async t => {
  const f = fixture(t), bridge = new Bridge(f.options);
  await f.send(bridge, '/permissions full-access', 'ou_stranger');
  await f.send(bridge, '/permissions typo');
  await f.send(bridge, '/permissions constructor');
  assert.equal(Object.keys(bridge.state.sessions).length, 0);
  assert.equal(f.calls.length, 0);
  assert.match(f.replies.at(-1), /参数无效/);
});

test('permission changes wait for the active task and survive a provider switch', async t => {
  const f = fixture(t);
  let release;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const bridge = new Bridge({ ...f.options, agentFactory: async options => {
    f.calls.push(options); started();
    return { sessionId: 'existing', close() {}, async cancel() {}, async setModel() {}, async prompt() { await pending; return { stopReason: 'end_turn' }; } };
  } });
  bridge.handle(f.event('running task'));
  await ready;
  bridge.handle(f.event('/permissions full-access'));
  assert.equal(Object.values(bridge.state.sessions)[0].codexMode, undefined);
  release();
  await Promise.all([...bridge.queues.values()].map(q => q.chain));
  const session = Object.values(bridge.state.sessions)[0];
  assert.equal(session.codexMode, 'agent-full-access');
  session.provider = 'claude';
  await f.send(bridge, '/permissions read-only');
  assert.equal(session.provider, 'claude');
  assert.equal(session.codexMode, 'read-only');
});
