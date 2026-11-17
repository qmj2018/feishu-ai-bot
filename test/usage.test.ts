import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { readCodexUsageSnapshot } from '../src/codex.js';
import { readContextUsage, formatUsage } from '../src/usage.js';
import { Bridge } from '../src/bridge.js';

const sessionId = '01a1a0b9-1260-7262-a04c-1c8fb1a996f4';
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function deferred<T = void>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
}
function fakeCodex(t, scenario = 'ok') {
  const root = temporary(t), file = path.join(root, 'fake.mjs'), requests = path.join(root, 'requests');
  fs.writeFileSync(file, `import readline from 'node:readline';import fs from 'node:fs';
const send=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);fs.appendFileSync(process.env.REQUEST_LOG,r.method+'\\n');
if(process.env.USAGE_SCENARIO==='hang')return;
if(r.method==='initialize')send({id:r.id,result:{}});
if(r.method==='account/rateLimits/read')send(process.env.USAGE_SCENARIO==='no-account'?{id:r.id,error:{message:'not available'}}:{id:r.id,result:{rateLimits:{primary:{usedPercent:44,windowDurationMins:10080}}}});
if(r.method==='thread/read')send({id:r.id,result:{thread:{id:process.env.USAGE_SCENARIO==='wrong-thread'?'other':r.params.threadId,path:'/fake/thread.jsonl'}}});
});`);
  return { options: { command: process.execPath, prefixArgs: [file], timeoutMs: 2000,
    env: { ...process.env, REQUEST_LOG: requests, USAGE_SCENARIO: scenario } }, requests };
}

test('usage RPC reads account and exact thread metadata without prompting or resuming', async t => {
  const { options, requests } = fakeCodex(t);
  const result = await readCodexUsageSnapshot({ ...options, sessionId });
  assert.equal(result.account.rateLimits.primary.usedPercent, 44);
  assert.equal(result.threadPath, '/fake/thread.jsonl');
  assert.deepEqual(fs.readFileSync(requests, 'utf8').trim().split('\n'),
    ['initialize', 'initialized', 'account/rateLimits/read', 'thread/read']);
});
test('usage queries do not create threads and keep context metadata when account quotas are unavailable', async t => {
  const first = fakeCodex(t);
  await readCodexUsageSnapshot(first.options);
  assert.doesNotMatch(fs.readFileSync(first.requests, 'utf8'), /thread\//);
  const unavailable = await readCodexUsageSnapshot({ ...fakeCodex(t, 'no-account').options, sessionId });
  assert.equal(unavailable.account, undefined); assert.equal(unavailable.threadPath, '/fake/thread.jsonl');
  const wrong = await readCodexUsageSnapshot({ ...fakeCodex(t, 'wrong-thread').options, sessionId });
  assert.equal(wrong.threadPath, undefined);
});
test('stuck usage queries terminate within their deadline', async t => {
  await assert.rejects(readCodexUsageSnapshot({ ...fakeCodex(t, 'hang').options, timeoutMs: 100 }), /超时/);
});

const tokenEvent = (used = 4000) => ({ timestamp: '2026-11-17T06:00:00Z', type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: { total_tokens: used },
    total_token_usage: { total_tokens: 9000000 }, model_context_window: 20000 } } });
test('context is the latest call snapshot, including large files and partially written tail lines', async t => {
  const root = temporary(t), file = path.join(root, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'response_item', text: 'x'.repeat(2 * 1024 * 1024) }) + '\n'
    + [tokenEvent(2000), tokenEvent()].map(x => JSON.stringify(x)).join('\n') + '\n{"partial":');
  assert.deepEqual(await readContextUsage(file, sessionId, { CODEX_HOME: root }),
    { used: 4000, size: 20000, measuredAt: '2026-11-17T06:00:00Z' });
  fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'compacted' }) + '\n');
  assert.equal(await readContextUsage(file, sessionId, { CODEX_HOME: root }), undefined);
});
test('context lookup rejects other sessions, paths outside Codex home, and invalid counters', async t => {
  const root = temporary(t), file = path.join(root, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify(tokenEvent()));
  assert.equal(await readContextUsage(file, '00000000-0000-0000-0000-000000000000', { CODEX_HOME: root }), undefined);
  assert.equal(await readContextUsage(file, sessionId, { CODEX_HOME: temporary(t) }), undefined);
  const invalid = tokenEvent(); invalid.payload.info.model_context_window = 0;
  fs.writeFileSync(file, JSON.stringify(invalid));
  assert.equal(await readContextUsage(file, sessionId, { CODEX_HOME: root }), undefined);
});
test('quota formatting recognizes weekly windows in either slot and never duplicates bucket views', () => {
  for (const slot of ['primary', 'secondary']) {
    const bucket = { [slot]: { usedPercent: 44, windowDurationMins: 10080, resetsAt: 1794997866 } };
    const text = formatUsage({ account: { rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } },
      context: { used: 4000, size: 20000 } }, { hasSession: true });
    assert.equal(text.match(/周额度/g).length, 1);
    assert.match(text, /已用 44\.0%，剩余 56\.0%/); assert.match(text, /重置 .*北京时间/);
    assert.match(text, /已用 20\.0%，剩余 80\.0%/); assert.match(text, /4,000 \/ 20,000 tokens/);
  }
  const empty = formatUsage({}); assert.match(empty, /暂不可用/); assert.match(empty, /尚未建立会话/);
  assert.doesNotMatch(empty, /0\.0%/);
  const unknown = formatUsage({ account: { rateLimits: { primary: { usedPercent: 0 } }, ordinaryUsageAllowed: false } });
  assert.match(unknown, /额度窗口：已用 0\.0%/); assert.doesNotMatch(unknown, /周额度/);
  assert.match(unknown, /不可使用普通包含额度/);
});

function event(id, text, owner = 'owner', extra = {}) {
  return { sender: { sender_type: 'user', sender_id: { open_id: owner } }, message: {
    message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), ...extra } };
}
const keyFor = (owner = 'owner', thread = '') => crypto.createHash('sha256').update(JSON.stringify([owner, 'chat', thread])).digest('hex');
test('/usage responds during a running task, queries only its session, and never prompts the agent', async t => {
  const root = temporary(t), started = deferred(), finish = deferred(), reported = deferred();
  const replies = [], queried = [], prompts = [], reactions = [];
  const bridge = new Bridge({ root, config: { feishu: { allowedUsers: ['owner'] } },
    usageReader: async options => { queried.push(options.sessionId); return { context: { used: 4000, size: 20000 } }; },
    workingReaction: { async add(id) { reactions.push(id); return 'reaction'; }, async remove() {} },
    send: async (id, text) => { replies.push({ id, text }); if (id === 'usage') reported.resolve(); },
    agentFactory: async () => ({ sessionId, close() {}, async cancel() {}, async setModel() {}, async prompt(text) {
      prompts.push(text); started.resolve(); await finish.promise; return { stopReason: 'end_turn' };
    } }),
  });
  bridge.state.sessions[keyFor()] = { cwd: root, provider: 'codex', engineSessions: { codex: sessionId } };
  bridge.state.sessions[keyFor('other')] = { cwd: root, engineSessions: { codex: 'other-session' } };
  bridge.handle(event('task', 'long task')); await started.promise;
  bridge.handle(event('usage', '/usage')); await reported.promise;
  assert.deepEqual(queried, [sessionId]); assert.deepEqual(prompts, ['long task']); assert.deepEqual(reactions, ['task']);
  assert.match(replies[0].text, /任务正在执行/); assert.equal(bridge.active.size, 1);
  finish.resolve(); await Promise.all([...bridge.queues.values()].map(q => q.chain));
});
test('/usage preserves whitelist and thread isolation and supports brand new conversations', async t => {
  const queried = [], replies = [];
  const bridge = new Bridge({ root: temporary(t), config: { feishu: { allowedUsers: ['owner'] } },
    usageReader: async options => { queried.push(options.sessionId); return {}; },
    send: async (_, text) => { replies.push(text); }, agentFactory: async () => { throw new Error('must not start'); } });
  bridge.state.sessions[keyFor()] = { cwd: '/unused', engineSessions: { codex: sessionId } };
  bridge.handle(event('rejected', '/usage', 'attacker'));
  bridge.handle(event('thread', '/usage', 'owner', { thread_id: 'new-thread' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queried, [undefined]); assert.match(replies[0], /尚未建立会话/);
  assert.equal(Object.keys(bridge.state.sessions).length, 1); assert.equal(bridge.queues.size, 0);
});
test('/usage isolates Claude and handles concurrent queries and failures without task errors', async t => {
  const replies = [], pending = deferred(); let reads = 0;
  const bridge = new Bridge({ root: temporary(t), config: { feishu: { allowedUsers: ['owner'] } },
    usageReader: async () => { reads++; await pending.promise; throw new Error('offline'); }, send: async (_, text) => { replies.push(text); } });
  bridge.state.sessions[keyFor()] = { cwd: '/unused', provider: 'claude' };
  await bridge.showUsage(keyFor(), text => bridge.send('m', text));
  assert.equal(reads, 0); assert.match(replies[0], /Claude/);
  delete bridge.state.sessions[keyFor()];
  const first = bridge.showUsage(keyFor(), text => bridge.send('m', text));
  await bridge.showUsage(keyFor(), text => bridge.send('m', text));
  assert.equal(reads, 1); assert.match(replies.at(-1), /正在查询/);
  pending.resolve(); await first;
  assert.match(replies.at(-1), /用量查询失败/); assert.equal(bridge.usagePending.size, 0);
});
