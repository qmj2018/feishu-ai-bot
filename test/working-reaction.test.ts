import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Bridge } from '../src/bridge.js';
import { createWorkingReaction } from '../src/working-reaction.js';

function deferred<T = void>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
}
function event(id, text = 'hello') {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } };
}
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'working-reaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  for (const args of [['init', '-q', project], ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init']]) {
    assert.equal(spawnSync('git', args).status, 0);
  }
  const log = [];
  const bridge = new Bridge({ root: path.join(root, 'runtime'),
    config: { feishu: { allowedUsers: ['owner'] }, project: { path: project } },
    workingReaction: {
      async add(id) { log.push(`add:${id}`); return `reaction:${id}`; },
      async remove(id, reaction) { log.push(`remove:${id}:${reaction}`); },
    },
    send: async (id, text) => { log.push(`reply:${id}:${text}`); },
    agentFactory: async options => ({ sessionId: 'session', close() {}, async cancel() {}, async setModel() {},
      async prompt(text) { options.onText(`answer ${text}`); return { stopReason: 'end_turn' }; } }),
    ...overrides,
  });
  return { bridge, log };
}
async function drain(bridge) { await Promise.all([...bridge.queues.values()].map(queue => queue.chain)); }

test('working reaction covers initialization and replies, and appears only when a queued task starts', async t => {
  const firstStarted = deferred(), finishFirst = deferred();
  let log;
  const setup = fixture(t, { agentFactory: async options => {
    log.push('initialize');
    return { sessionId: 'session', close() {}, async cancel() {}, async setModel() {},
      async prompt(text) {
        if (text === 'first') { firstStarted.resolve(); await finishFirst.promise; }
        options.onText(text); return { stopReason: 'end_turn' };
      } };
  } });
  ({ log } = setup);
  setup.bridge.handle(event('m1', 'first'));
  await firstStarted.promise;
  setup.bridge.handle(event('m2', 'second'));
  setup.bridge.handle(event('m1', 'first')); // Duplicate delivery must not add another reaction.
  assert.deepEqual(log, ['add:m1', 'initialize']);
  finishFirst.resolve();
  await drain(setup.bridge);
  assert.deepEqual(log, ['add:m1', 'initialize', 'reply:m1:first', 'remove:m1:reaction:m1',
    'add:m2', 'initialize', 'reply:m2:second', 'remove:m2:reaction:m2']);
});

for (const stage of ['worktree', 'initialize', 'prompt', 'reply']) {
  test(`working reaction is removed after ${stage} failure`, async t => {
    const overrides: any = {};
    if (stage === 'worktree') overrides.config = { feishu: { allowedUsers: ['owner'] } };
    if (stage === 'initialize') overrides.agentFactory = async () => { throw new Error('initialization failed'); };
    if (stage === 'prompt') overrides.agentFactory = async () => ({ sessionId: 'session', close() {}, async prompt() { throw new Error('prompt failed'); } });
    if (stage === 'reply') overrides.send = async () => { throw new Error('reply failed'); };
    const { bridge, log } = fixture(t, overrides);
    bridge.handle(event('m1'));
    await drain(bridge);
    assert.deepEqual(log.filter(item => item.startsWith('add:') || item.startsWith('remove:')),
      ['add:m1', 'remove:m1:reaction:m1']);
    assert.equal(bridge.queues.size, 0);
  });
}

test('cancel removes the running task reaction without reacting to the cancel command', async t => {
  const started = deferred(), finish = deferred();
  const { bridge, log } = fixture(t, { agentFactory: async () => ({ sessionId: 'session', close() {},
    async cancel() { finish.resolve(); },
    async prompt() { started.resolve(); await finish.promise; return { stopReason: 'cancelled' }; },
  }) });
  bridge.handle(event('m1')); await started.promise;
  bridge.handle(event('cancel', '/cancel')); await drain(bridge);
  assert.deepEqual(log.filter(item => item.startsWith('add:') || item.startsWith('remove:')),
    ['add:m1', 'remove:m1:reaction:m1']);
});

test('timed out tasks remove their reaction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const { bridge, log } = fixture(t, { agentFactory: async () => ({ sessionId: 'session', close() {},
    async prompt() { started.resolve(); return new Promise(() => {}); },
  }) });
  bridge.handle(event('m1')); await started.promise;
  t.mock.timers.tick(30 * 60_000); await drain(bridge);
  assert.ok(log.includes('remove:m1:reaction:m1'));
  assert.ok(log.some(item => item.includes('任务失败')));
});

test('reaction API errors do not prevent replies or block the next queued task', async t => {
  for (const failing of ['add', 'remove']) {
    const { bridge, log } = fixture(t, { workingReaction: {
      async add() { if (failing === 'add') throw new Error('no scope'); return 'reaction'; },
      async remove() { if (failing === 'remove') throw new Error('network'); },
    } });
    bridge.handle(event('m1')); bridge.handle(event('m2')); await drain(bridge);
    assert.deepEqual(log, ['reply:m1:answer hello', 'reply:m2:answer hello']);
  }
});

test('management commands, rejected senders and full queues do not get a working reaction', async t => {
  const started = deferred(), finish = deferred();
  const { bridge, log } = fixture(t, { agentFactory: async () => ({ sessionId: 'session', close() {},
    async prompt() { started.resolve(); await finish.promise; return { stopReason: 'end_turn' }; },
  }), modelDiscovery: async () => [], sendCard: async () => 'card' });
  const rejected = event('rejected'); rejected.sender.sender_id.open_id = 'intruder';
  bridge.handle(rejected); bridge.handle(event('new', '/new')); bridge.handle(event('models', '/models'));
  await drain(bridge);
  assert.equal(log.some(item => item.startsWith('add:')), false);
  bridge.handle(event('m1')); await started.promise;
  bridge.handle(event('m2')); bridge.handle(event('m3')); bridge.handle(event('full'));
  assert.deepEqual(log.filter(item => item.startsWith('add:')), ['add:m1']);
  finish.resolve(); await drain(bridge);
  assert.equal(log.some(item => item.startsWith('add:full')), false);
  assert.ok(log.some(item => item.includes('队列已满')));
});

test('SDK transport uses Typing and deletes only the reaction record it created', async () => {
  const calls = [];
  const reaction = createWorkingReaction({
    create: async payload => { calls.push(payload); return { code: 0, data: { reaction_id: 'own-reaction' } }; },
    delete: async payload => { calls.push(payload); return { code: 0 }; },
  });
  const id = await reaction.add('message'); await reaction.remove('message', id);
  assert.deepEqual(calls, [
    { path: { message_id: 'message' }, data: { reaction_type: { emoji_type: 'Typing' } } },
    { path: { message_id: 'message', reaction_id: 'own-reaction' } },
  ]);
});

test('SDK transport detects API business errors and missing reaction IDs', async () => {
  for (const result of [{ code: 99991672 }, { code: 0, data: {} }]) {
    const reaction = createWorkingReaction({ create: async () => result, delete: async () => ({ code: 99991672 }) });
    await assert.rejects(reaction.add('message'), /添加执行状态表情失败/);
    await assert.rejects(reaction.remove('message', 'reaction'), /移除执行状态表情失败/);
  }
});
