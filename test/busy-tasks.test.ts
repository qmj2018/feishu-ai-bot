import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { BusyTasks } from '../src/busy-tasks.js';
import { Bridge, ApprovalBroker } from '../src/bridge.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve: () => resolve() }; }
const message = { owner: 'owner', chat: 'chat', thread: '', id: 'm2', text: 'new task' };
function callback(token, choice = 'parallel', id = 'card1', extra = {}) {
  return { operator: { open_id: 'owner' }, context: { open_chat_id: 'chat', open_message_id: id },
    action: { value: { action: 'task.choose', token }, option: choice }, ...extra };
}
test('busy choices bind the owner, chat, card, expiry, and original thread for text fallback', () => {
  const choices = new BusyTasks();
  const { token, entry } = choices.create(message, 'session', 'scope', true);
  entry.messageId = 'card1';
  assert.equal(choices.fromCard(callback(token), []), null);
  assert.equal(choices.fromCard(callback(token, 'parallel', 'card1', { operator: { open_id: 'other' } }), ['owner', 'other']), null);
  assert.equal(choices.fromCard(callback(token, 'parallel', 'copied'), ['owner']), null);
  assert.equal(choices.fromCard(callback(token, 'invalid'), ['owner']), null);
  assert.equal(choices.fromCard(callback(token), ['owner']).entry.message.text, 'new task');
  assert.equal(choices.fromText({ ...message, text: `/task ${token} queue` }, 'different-thread'), null);
  assert.equal(choices.fromText({ ...message, owner: 'other', text: `/task ${token} queue` }, 'scope'), null);
  assert.equal(choices.fromText({ ...message, text: `/task ${token} queue` }, 'scope').choice, 'queue');
  entry.expires = Date.now() - 1;
  assert.equal(choices.fromCard(callback(token), ['owner']), null);
  assert.equal(choices.fromText({ ...message, text: `/task ${token} queue` }, 'scope'), null);
});

function fixture(t, directory = true, cardFailure = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-busy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  if (!directory) for (const args of [['init', '-q', project], ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init']]) assert.equal(spawnSync('git', args).status, 0);
  const calls = [], cards = [], replies = [], gates = new Map();
  let session = 0, messageId = 0;
  const options = { root: path.join(root, 'runtime'), config: { feishu: { allowedUsers: ['owner', 'other'] },
    project: { path: project, workspaceMode: directory ? 'project-directory' as const : 'per-session-worktree' as const } },
    send: async (id, text) => { replies.push({ id, text }); },
    sendCard: async (id, card) => { if (cardFailure) throw new Error('card unavailable'); cards.push({ id, card }); return `card${cards.length}`; },
    agentFactory: async options => {
      const sessionId = options.sessionId || `session-${++session}`;
      let gate;
      calls.push({ ...options, assignedId: sessionId });
      return { sessionId, close() { gate?.resolve(); }, async cancel() { gate?.resolve(); }, async setModel() {},
        async prompt(text) { gate = deferred(); gates.set(text, gate); await gate.promise; options.onText(`done ${text}`); return { stopReason: 'end_turn' }; } };
    },
  };
  let bridge = new Bridge(options);
  t.after(async () => { bridge.close(); await flush(); });
  const send = async (text, owner = 'owner', thread = '') => {
    bridge.handle({ sender: { sender_type: 'user', sender_id: { open_id: owner } },
      message: { message_id: `m${++messageId}`, chat_id: 'chat', chat_type: 'p2p', thread_id: thread, message_type: 'text', content: JSON.stringify({ text }) } });
    await flush();
  };
  const selection = () => { const index = cards.length; return { token: cards.at(-1).card.elements[1].actions[0].value.token, id: `card${index}` }; };
  const choose = async choice => { const { token, id } = selection(); const result = bridge.handleCard(callback(token, choice, id)); await flush(); return result; };
  const finish = async text => { gates.get(text)?.resolve(); await flush(); };
  return { get bridge() { return bridge; }, send, choose, selection, finish, calls, cards, replies, options,
    restart() { bridge = new Bridge(options); return bridge; } };
}

test('a busy message waits for a choice; queue runs only after the original task and repeated clicks cannot replay it', async t => {
  const f = fixture(t);
  await f.send('original');
  await f.send('new task');
  assert.equal(f.calls.length, 1);
  assert.equal(f.cards.length, 1);
  assert.match(f.cards[0].card.header.title.content, /正在执行/);
  assert.equal(f.bridge.queues.values().next().value.size, 1);
  const { token, id } = f.selection();
  assert.equal((await f.choose('queue')).toast.type, 'info');
  assert.equal(f.calls.length, 1);
  assert.equal(f.bridge.handleCard(callback(token, 'parallel', id)).toast.type, 'error');
  await f.finish('original');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].sessionId, f.calls[0].assignedId);
  await f.finish('new task');
  assert.equal(f.bridge.queues.size, 0);
});

for (const directory of [true, false]) test(`parallel choice creates independent context, retains the original and restores the selected ${directory ? 'directory' : 'worktree'} session`, async t => {
  const f = fixture(t, directory);
  await f.send('original');
  const originalKey = Object.keys(f.bridge.state.sessions)[0];
  f.bridge.state.sessions[originalKey].codexMode = 'agent-full-access';
  f.bridge.state.sessions[originalKey].models = { codex: 'chosen-model' };
  await f.send('parallel');
  assert.equal((await f.choose('parallel')).toast.type, 'info');
  assert.equal(f.bridge.active.size, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].sessionId, undefined);
  assert.notEqual(f.calls[1].assignedId, f.calls[0].assignedId);
  assert.equal(f.calls[1].codexMode, 'agent-full-access');
  assert.equal(f.calls[1].model, 'chosen-model');
  assert.equal(f.calls[1].cwd === f.calls[0].cwd, directory);
  const newKey = Object.values(f.bridge.state.routes)[0];
  assert.notEqual(newKey, originalKey);
  await f.send('/sessions');
  assert.match(f.replies.at(-1).text, new RegExp(originalKey.slice(0, 8)));
  assert.match(f.replies.at(-1).text, new RegExp(newKey.slice(0, 8)));
  await f.finish('original'); await f.finish('parallel');
  f.restart();
  await f.send('continue new');
  assert.equal(f.calls.at(-1).sessionId, f.calls[1].assignedId);
  await f.finish('continue new');
  await f.send(`/session ${originalKey.slice(0, 8)}`, 'other');
  assert.match(f.replies.at(-1).text, /找不到/);
  await f.send(`/session ${originalKey.slice(0, 8)}`);
  await f.send('continue original');
  assert.equal(f.calls.at(-1).sessionId, f.calls[0].assignedId);
  await f.finish('continue original');
});

test('discard, foreign callbacks, and expired choices cannot execute a held task', async t => {
  const f = fixture(t);
  await f.send('original'); await f.send('discard me');
  const { token, id } = f.selection();
  assert.equal(f.bridge.handleCard(callback(token, 'parallel', id, { operator: { open_id: 'other' } })).toast.type, 'error');
  assert.equal((await f.choose('discard')).toast.type, 'info');
  assert.equal(f.calls.length, 1);
  await f.send('expire me');
  f.bridge.busyTasks.entries.get(f.selection().token).expires = Date.now() - 1;
  assert.equal((await f.choose('parallel')).toast.type, 'error');
  assert.equal(f.calls.length, 1);
  await f.finish('original');
});

test('card failure offers text choices, only the original owner and thread can select', async t => {
  const f = fixture(t, true, true);
  await f.send('original'); await f.send('parallel');
  assert.match(f.replies.at(-1).text, /当前会话有任务正在执行/);
  const token = [...f.bridge.busyTasks.entries.keys()][0];
  await f.send(`/task ${token} parallel`, 'other');
  await f.send(`/task ${token} parallel`, 'owner', 'other-thread');
  assert.equal(f.calls.length, 1);
  await f.send(`/task ${token} parallel`);
  assert.equal(f.calls.length, 2);
  await f.finish('original'); await f.finish('parallel');
});

test('parallel capacity is checked before consuming a choice, and cancel affects only the selected session', async t => {
  const f = fixture(t);
  await f.send('original');
  for (let i = 1; i <= 3; i++) { await f.send(`parallel ${i}`); await f.choose('parallel'); }
  assert.equal(f.bridge.active.size, 4);
  await f.send('fifth');
  const pending = f.selection();
  assert.equal((await f.choose('parallel')).toast.type, 'error');
  assert.ok(f.bridge.busyTasks.entries.has(pending.token));
  await f.send('/cancel');
  assert.equal(f.bridge.active.size, 3);
  assert.ok(f.bridge.queues.has(Object.keys(f.bridge.state.sessions)[0]));
  assert.equal((await f.choose('parallel')).toast.type, 'info');
  assert.equal(f.bridge.active.size, 4);
  for (const text of ['original', 'parallel 1', 'parallel 2', 'fifth']) await f.finish(text);
});

test('approval cancellation is scoped to one parallel session', async () => {
  const broker = new ApprovalBroker();
  const options = [{ kind: 'allow_once', optionId: 'allow' }];
  const first = broker.request({ owner: 'owner', chat: 'chat', sessionKey: 'first', options, send: async () => {} });
  const second = broker.request({ owner: 'owner', chat: 'chat', sessionKey: 'second', options, send: async () => {} });
  broker.cancel('owner', 'chat', 'first');
  assert.equal((await first).outcome.outcome, 'cancelled');
  assert.equal(broker.pending.size, 1);
  const token = [...broker.pending.keys()][0];
  broker.answer(`/approve ${token}`, 'owner', 'chat');
  assert.equal((await second).outcome.outcome, 'selected');
});
