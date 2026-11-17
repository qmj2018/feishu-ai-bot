import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { ApprovalBroker, Bridge, acceptedMessage } from '../src/bridge.js';
import { connectAgent } from '../src/acp-client.js';

const config = { feishu: { allowedUsers: ['ou_owner'] } };
function event(text = 'hello', extra = {}) {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'm1', chat_id: 'c1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), ...extra } };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('event filter requires an allowed human and an exact bot mention in groups', () => {
  assert.equal(acceptedMessage(event(), config, 'bot').text, 'hello');
  assert.equal(acceptedMessage({ ...event(), sender: { sender_type: 'app' } }, config, 'bot'), null);
  assert.equal(acceptedMessage(event(), { feishu: { allowedUsers: [] } }, 'bot'), null);
  assert.equal(acceptedMessage(event('hi', { chat_type: 'group' }), config, 'bot'), null);
  assert.equal(acceptedMessage(event('@a hi', { chat_type: 'group', mentions: [{ key: '@a', id: { open_id: 'other' } }] }), config, 'bot'), null);
  assert.equal(acceptedMessage(event('@a hi', { chat_type: 'group', mentions: [{ key: '@a', id: { open_id: 'bot' } }] }), config, 'bot').text, 'hi');
  assert.equal(acceptedMessage(event('hi', { content: 'bad json' }), config, 'bot'), null);
});
test('permissions bind one-time approval to owner, chat and nonce; replay is rejected', async () => {
  const broker = new ApprovalBroker({ timeoutMs: 1000 });
  let message;
  const result = broker.request({ owner: 'owner', chat: 'chat', options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'allow_always', optionId: 'always' }], send: async text => { message = text; } });
  const token = /\/approve ([a-f0-9]+)/.exec(message)[1];
  broker.answer(`/approve ${token}`, 'attacker', 'chat');
  broker.answer(`/approve ${token}`, 'owner', 'wrong');
  assert.equal(broker.pending.size, 1);
  broker.answer(`/approve ${token}`, 'owner', 'chat');
  assert.deepEqual(await result, { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.equal(broker.pending.size, 0);
  broker.answer(`/approve ${token}`, 'owner', 'chat');
});
test('permissions expire and failed delivery denies rather than granting', async () => {
  for (const send of [async () => {}, async () => { throw new Error('network'); }]) {
    const broker = new ApprovalBroker({ timeoutMs: 5 });
    const result = await broker.request({ owner: 'owner', chat: 'chat', options: [{ kind: 'allow_once', optionId: 'once' }], send });
    assert.equal(result.outcome.outcome, 'cancelled');
    assert.equal(broker.pending.size, 0);
  }
});
test('bridge creates a detached worktree, restores sessions and persists deduplication', async t => {
  const root = temporary(t);
  const project = path.join(root, 'project');
  for (const args of [['init', '-q', project], ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial']]) {
    const r = spawnSync('git', args); assert.equal(r.status, 0, r.stderr?.toString());
  }
  const runtime = path.join(root, 'runtime');
  const calls = [], replies = [];
  const agentFactory = async options => {
    calls.push(options);
    return { sessionId: 'session1', close() {}, async cancel() {}, async setModel() {}, async prompt(text) { options.onText(`reply ${text}`); return { stopReason: 'end_turn' }; } };
  };
  const options = { root: runtime, config: { ...config, project: { path: project } }, send: async (id, text) => replies.push(text), agentFactory };
  let bridge = new Bridge(options);
  bridge.handle(event());
  await [...bridge.queues.values()][0].chain;
  assert.deepEqual(replies, ['reply hello']);
  assert.notEqual(calls[0].cwd, project);
  assert.equal(fs.existsSync(path.join(calls[0].cwd, '.git')), true);
  assert.equal(fs.statSync(path.join(runtime, 'sessions.json')).mode & 0o777, 0o600);
  bridge = new Bridge(options);
  bridge.handle(event());
  assert.equal(bridge.queues.size, 0);
  bridge.handle(event('second', { message_id: 'm2' }));
  await [...bridge.queues.values()][0].chain;
  assert.equal(calls[1].sessionId, 'session1');
  assert.equal(calls[1].cwd, calls[0].cwd);
});
test('ACP transport enforces read-only mode and forwards permission results', async t => {
  const root = temporary(t);
  const fake = path.join(root, 'agent.mjs');
  fs.writeFileSync(fake, `
import readline from 'node:readline';
if (!process.env.CODEX_PATH?.startsWith('/')) process.exit(7);
const send = v => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
let mode;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line);
 if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(r.method==='session/new')send({id:r.id,result:{sessionId:'test'}});
 if(r.method==='session/set_mode'){mode=r.params.modeId;send({id:r.id,result:{}});}
 if(r.method==='session/prompt') {
   if(mode!=='read-only')process.exit(5);
   send({method:'session/update',params:{sessionId:'test',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:mode}}}});
   globalThis.promptId=r.id;
   send({id:999,method:'session/request_permission',params:{sessionId:'test',toolCall:{toolCallId:'t1',title:'Edit file'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'}]}});
 }
 if(r.id===999 && r.result)send({id:globalThis.promptId,result:{stopReason:r.result.outcome.outcome==='selected'?'end_turn':'cancelled'}});
});`);
  let text = '';
  let permission;
  const agent = await connectAgent({ cwd: root, command: process.execPath, args: [fake], onText: chunk => { text += chunk; },
    requestPermission: p => { permission = p; return { outcome: { outcome: 'selected', optionId: 'yes' } }; } });
  t.after(() => agent.close());
  assert.equal((await agent.prompt('hello')).stopReason, 'end_turn');
  assert.equal(text, 'read-only');
  assert.equal(permission.toolCall.title, 'Edit file');
});
test('native runtime creates private configuration and rejects stale config replacement', t => {
  const home = temporary(t);
  const cli = new URL('../bin/feishu-runtime.js', import.meta.url);
  const env = { ...process.env, HOME: home, FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'test-secret', FEISHU_ALLOWED_USERS: 'ou_owner' };
  const invoke = (args: string[], input?: string) => spawnSync(process.execPath, [cli.pathname, 'bots', ...args], { env, input, encoding: 'utf8' });
  assert.equal(invoke(['add', 'test-bot', '--name', 'Test']).status, 0);
  assert.equal(invoke(['setup', 'test-bot']).status, 0);
  const list = JSON.parse(invoke(['list']).stdout).bots;
  assert.equal(list.length, 1);
  const file = path.join(home, '.feishu-runtime/bots', list[0].runtimeId, 'feishu-runtime.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(current.feishu.allowedUsers, ['ou_owner']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const next = { ...current, shell: { enabled: false } };
  const result = invoke(['config', 'replace', 'test-bot', '--stdin'], JSON.stringify({ config: next, expectedConfig: current }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(invoke(['config', 'replace', 'test-bot', '--stdin'], JSON.stringify({ config: current, expectedConfig: current })).status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), next);
  assert.equal(JSON.parse(invoke(['status', 'test-bot']).stdout).status, 'stopped');
});


test('runtime management works in a fresh checkout before SDK dependencies are installed', t => {
  const root = temporary(t);
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'src'));
  fs.writeFileSync(path.join(checkout, 'package.json'), '{"type":"module"}');
  for (const file of ['bin/feishu-runtime.js', 'src/core.js', 'src/storage.js', 'src/local-codex.js', 'src/runtime-env.js', 'src/paths.js', 'src/identity.js', 'src/legacy.js']) {
    fs.copyFileSync(new URL('../' + file, import.meta.url), path.join(checkout, file));
  }
  const env = { ...process.env, HOME: root };
  const result = spawnSync(process.execPath, [path.join(checkout, 'bin/feishu-runtime.js'), 'bots', 'list'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bots: [] });
});
