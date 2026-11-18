import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';
import { CHAT_HELP } from '../src/chat-help.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-help-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const replies = [];
  const bridge = new Bridge({ root, config: { feishu: { allowedUsers: ['owner'] } }, botId: 'bot',
    send: async (id, text) => { replies.push({ id, text }); },
    agentFactory: async () => { throw new Error('Help must not open an agent'); },
  });
  const event = (id, text, owner = 'owner', extra = {}) => ({ sender: { sender_type: 'user', sender_id: { open_id: owner } },
    message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), ...extra } });
  return { bridge, replies, event };
}

test('help responds immediately even when all task queues are occupied, without creating sessions or busy choices', async t => {
  const { bridge, replies, event } = fixture(t);
  for (let i = 0; i < 4; i++) bridge.queues.set(String(i), { chain: new Promise(() => {}), size: 3 });
  bridge.handle(event('first', '/help'));
  bridge.handle(event('alias', 'help'));
  await Promise.resolve();
  assert.deepEqual(replies.map(r => r.text), [CHAT_HELP, CHAT_HELP]);
  assert.equal(bridge.queues.size, 4);
  assert.equal(bridge.busyTasks.entries.size, 0);
  assert.deepEqual(bridge.state.sessions, {});
  assert.ok(CHAT_HELP.length < 3000);
});

test('help respects whitelist, group mentions and message deduplication', async t => {
  const { bridge, replies, event } = fixture(t);
  bridge.handle(event('unauthorized', '/help', 'intruder'));
  bridge.handle(event('unmentioned', '/help', 'owner', { chat_type: 'group' }));
  const mentioned = event('mentioned', '@bot /help', 'owner', { chat_type: 'group', mentions: [{ key: '@bot', id: { open_id: 'bot' } }] });
  bridge.handle(mentioned); bridge.handle(mentioned);
  await Promise.resolve();
  assert.deepEqual(replies, [{ id: 'mentioned', text: CHAT_HELP }]);
});
