import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { splitMarkdown, createMarkdownReply } from '../src/markdown-reply.js';
import { Bridge } from '../src/bridge.js';

const markdown = '# 标题\n\n**加粗**与[链接](https://example.com)\n\n- 列表\n\n```ts\nconst x = 1;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 渲染 | 完成 |';
test('Markdown replies use post/md, preserving headings, code and tables', async () => {
  const calls = [];
  const send = createMarkdownReply({ reply: async payload => { calls.push(payload); return { code: 0 }; } });
  await send('original-message', markdown);
  assert.deepEqual(calls, [{ path: { message_id: 'original-message' }, data: { msg_type: 'post',
    content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: markdown }]] } }) } }]);
});
test('long multiline replies preserve their content and keep JSON payloads under budget', async () => {
  const input = '中文与 emoji 😀，含引号 " 和反斜线 \\。\n'.repeat(3000);
  const calls = [];
  await createMarkdownReply({ reply: async payload => { calls.push(payload); return { code: 0 }; } })('message', input);
  assert.ok(calls.length > 1);
  assert.equal(calls.map(call => JSON.parse(call.data.content).zh_cn.content[0][0].text).join(''), input);
  for (const call of calls) assert.ok(Buffer.byteLength(call.data.content) < 20_000);
});
test('oversized Unicode lines and JSON control characters do not break code points or byte limits', () => {
  const input = '😀中"\\\t\u0001'.repeat(300);
  const chunks = splitMarkdown(input, 256);
  assert.equal(chunks.join(''), input);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) - 2 <= 256);
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
  }
});
for (const marker of ['```', '~~~~']) {
  test(`long ${marker} code blocks close and reopen with the same language`, () => {
    const lines = Array.from({ length: 100 }, (_, i) => `console.log("第 ${i} 行");\n`);
    const input = `${marker}typescript\n${lines.join('')}${marker}\n`;
    const chunks = splitMarkdown(input, 256);
    assert.ok(chunks.length > 1);
    const restored = [];
    for (const chunk of chunks) {
      assert.ok(chunk.startsWith(marker + 'typescript\n'));
      assert.ok(chunk.trimEnd().endsWith(marker));
      assert.ok(Buffer.byteLength(JSON.stringify(chunk)) - 2 <= 256);
      restored.push(chunk.slice((marker + 'typescript\n').length).replace(new RegExp(marker + '\\n?$'), ''));
    }
    assert.equal(restored.join(''), lines.join(''));
  });
}
test('shorter inner fences do not close a longer outer fence, and unfinished blocks render closed', () => {
  const input = '````markdown\n```ts\ncode\n```\nmore\n````';
  assert.deepEqual(splitMarkdown(input), [input]);
  assert.deepEqual(splitMarkdown('```ts\ncode'), ['```ts\ncode\n```']);
  assert.deepEqual(splitMarkdown(''), []);
  assert.throws(() => splitMarkdown('hello', 0), /分段大小/);
});
test('Markdown send failures stop subsequent chunks and propagate to the task handler', async () => {
  let calls = 0;
  const send = createMarkdownReply({ reply: async () => { calls++; return { code: 123 }; } });
  await assert.rejects(send('message', 'line\n'.repeat(10000)), /Markdown 回复失败/);
  assert.equal(calls, 1);
});
test('the bridge sends model output whole to the Markdown transport while commands remain text', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plain = [], rich = [];
  const output = markdown + '\n\n' + '正文\n'.repeat(2000);
  const bridge = new Bridge({ root, config: { feishu: { allowedUsers: ['owner'] } },
    send: async (_, text) => { plain.push(text); }, sendMarkdown: async (id, text) => { rich.push({ id, text }); },
    agentFactory: async options => ({ sessionId: 'session', close() {}, async cancel() {}, async setModel() {},
      async prompt() { options.onText(output); return { stopReason: 'end_turn' }; } }),
  });
  const key = crypto.createHash('sha256').update(JSON.stringify(['owner', 'chat', ''])).digest('hex');
  bridge.state.sessions[key] = { cwd: root };
  const event = (id, text) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } });
  bridge.handle(event('task', 'write a response'));
  await Promise.all([...bridge.queues.values()].map(queue => queue.chain));
  assert.deepEqual(rich, [{ id: 'task', text: output }]); assert.deepEqual(plain, []);
  bridge.handle(event('new', '/new'));
  await Promise.all([...bridge.queues.values()].map(queue => queue.chain));
  assert.match(plain[0], /新会话/); assert.equal(rich.length, 1);
});
