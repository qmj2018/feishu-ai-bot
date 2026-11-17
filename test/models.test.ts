import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Bridge } from '../src/bridge.js';
import { ModelCards, modelChoices } from '../src/model-cards.js';
import { connectClaude, listClaudeModels } from '../src/claude-client.js';
import { connectAgent } from '../src/acp-client.js';

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-models-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function callback(token, option = '0', extra = {}) {
  return { operator: { open_id: 'owner' }, context: { open_chat_id: 'chat', open_message_id: 'card1' }, action: { value: { action: 'model.select', token }, option }, ...extra };
}
test('card selection binds nonce, owner, chat, message and server-side model list', () => {
  const cards = new ModelCards();
  const { token, entry, card } = cards.create({ owner: 'owner', chat: 'chat', key: 'key', provider: 'codex', models: [{ id: 'm1', name: 'Model One' }] });
  entry.messageId = 'card1';
  assert.equal(card.elements[1].actions[0].options[0].text.content, 'Model One');
  assert.equal(cards.consume(callback(token, '0', { operator: { open_id: 'intruder' } }), ['owner']), null);
  assert.equal(cards.consume(callback(token, '0', { context: { open_chat_id: 'other', open_message_id: 'card1' } }), ['owner']), null);
  assert.equal(cards.consume(callback(token, '0', { context: { open_chat_id: 'chat', open_message_id: 'copied' } }), ['owner']), null);
  assert.equal(cards.consume(callback(token, '999'), ['owner']), null);
  assert.equal(cards.consume(callback(token), []), null);
  assert.equal(cards.consume(callback(token), ['owner']).model.id, 'm1');
  assert.equal(cards.consume(callback(token), ['owner']), null);
});
test('expired cards cannot change a model', () => {
  const cards = new ModelCards({ ttlMs: -1 });
  const { token, entry } = cards.create({ owner: 'owner', chat: 'chat', key: 'key', provider: 'codex', models: [{ id: 'm1' }] });
  entry.messageId = 'card1';
  assert.equal(cards.consume(callback(token), ['owner']), null);
});
function event(id, text) { return { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } }; }
async function drain(bridge) { for (const queue of bridge.queues.values()) await queue.chain; }
test('model card selection routes the next prompt, persists after restart and isolates provider sessions', async t => {
  const root = temp(t), project = path.join(root, 'project');
  for (const args of [['init', '-q', project], ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init']]) assert.equal(spawnSync('git', args).status, 0);
  const calls = [], sent = [], cards = [];
  let fail = false;
  let failEffort = false;
  const opts = { root: path.join(root, 'runtime'), config: { feishu: { allowedUsers: ['owner'] }, project: { path: project } },
    send: async (id, text) => { sent.push(text); },
    sendCard: async (id, card) => { cards.push(card); return 'card1'; },
    modelDiscovery: async provider => [{ id: `${provider}-one`, name: `${provider} One`, ...(provider === 'codex' ? { defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }] } : {}) }],
    agentFactory: async options => { calls.push(options); return { sessionId: `${options.provider}-session`, close() {}, async cancel() {}, async setModel(id) { if (fail) throw new Error('no access'); calls.push({ selected: id }); }, async setReasoningEffort(value) { if (failEffort) throw new Error('unsupported effort'); calls.push({ effort: value }); }, async prompt(text) { options.onText(text); return { stopReason: 'end_turn' }; } }; },
  };
  let bridge = new Bridge(opts);
  bridge.handle(event('m0', 'hello')); await drain(bridge);
  bridge.handle(event('m1', '/models')); await drain(bridge);
  assert.equal(cards.length, 2);
  const token = cards[1].elements[1].actions[0].value.token;
  assert.equal(bridge.handleCard(callback(token)).toast.type, 'info');
  await drain(bridge);
  assert.equal(Object.values(bridge.state.sessions)[0].models.claude, 'claude-one');
  bridge = new Bridge(opts);
  bridge.handle(event('m2', 'next')); await drain(bridge);
  assert.equal(calls.at(-1).provider, 'claude');
  assert.equal(calls.at(-1).model, 'claude-one');
  assert.equal(calls.at(-1).sessionId, undefined);
  bridge = new Bridge(opts);
  bridge.handle(event('m2b', 'continue')); await drain(bridge);
  assert.equal(calls.at(-1).sessionId, 'claude-session');
  bridge.handle(event('m3', '/models codex')); await drain(bridge);
  const token2 = cards.at(-1).elements[1].actions[0].value.token;
  bridge.handleCard(callback(token2, '1')); await drain(bridge);
  assert.equal(calls.filter(v => v.provider).at(-1).sessionId, 'codex-session');
  assert.equal(Object.values(bridge.state.sessions)[0].provider, 'codex');
  assert.equal(Object.values(bridge.state.sessions)[0].reasoningEfforts.codex, 'xhigh');
  bridge = new Bridge(opts);
  bridge.handle(event('m3b', 'continue codex')); await drain(bridge);
  assert.equal(calls.at(-1).reasoningEffort, 'xhigh');
  failEffort = true;
  bridge.handle(event('m3c', '/models codex')); await drain(bridge);
  bridge.handleCard(callback(cards.at(-1).elements[1].actions[0].value.token, '0')); await drain(bridge);
  assert.equal(Object.values(bridge.state.sessions)[0].reasoningEfforts.codex, 'xhigh');
  assert.match(sent.at(-1), /切换失败/);
  failEffort = false;
  fail = true;
  bridge.handle(event('m4', '/models claude')); await drain(bridge);
  bridge.handleCard(callback(cards.at(-1).elements[1].actions[0].value.token)); await drain(bridge);
  assert.equal(Object.values(bridge.state.sessions)[0].provider, 'codex');
  assert.match(sent.at(-1), /切换失败/);
});
test('one unavailable provider does not hide the other provider card', async t => {
  const cards = [], messages = [];
  const bridge = new Bridge({ root: temp(t), config: { feishu: { allowedUsers: ['owner'] } }, send: async (_, text) => { messages.push(text); },
    sendCard: async (_, card) => { cards.push(card); return 'card1'; },
    modelDiscovery: async provider => { if (provider === 'claude') throw new Error('not installed'); return [{ id: 'available' }]; },
  });
  bridge.handle(event('one', '/models')); await drain(bridge);
  assert.equal(cards.length, 1); assert.match(messages[0], /claude 模型读取失败/);
});
test('Claude streaming control protocol lists models, switches model and forwards permission decisions', async t => {
  const root = temp(t), fake = path.join(root, 'claude.mjs');
  fs.writeFileSync(fake, `
import readline from 'node:readline';
const send = v=>console.log(JSON.stringify(v));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.type==='control_request') {
  const response=r.request.subtype==='initialize'?{models:[{value:'claude-test',displayName:'Claude Test'}]}:{};
  send({type:'control_response',response:{subtype:'success',request_id:r.request_id,response}});
 }
 if(r.type==='user')send({type:'control_request',request_id:'tool1',request:{subtype:'can_use_tool',tool_name:'Edit',input:{file_path:'test.txt'}}});
 if(r.type==='control_response') {
   if(r.response.response.behavior!=='allow')process.exit(5);
   send({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
   send({type:'result',is_error:false});
 }
});`);
  const options = { cwd: root, command: process.execPath, args: [fake], timeoutMs: 2000 };
  assert.deepEqual(await listClaudeModels(options), [{ id: 'claude-test', name: 'Claude Test' }]);
  let text = '';
  const agent = await connectClaude({ ...options, onText: chunk => { text += chunk; }, requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }) });
  t.after(() => agent.close());
  await agent.setModel('claude-test');
  await agent.prompt('edit');
  assert.equal(text, 'done');
});
test('Codex applies selected model through ACP when resuming an existing session', async t => {
  const root = temp(t), fake = path.join(root, 'codex.mjs');
  fs.writeFileSync(fake, `
import readline from 'node:readline';
const send=v=>console.log(JSON.stringify({jsonrpc:'2.0',...v}));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); let result={};
 if(r.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true}};
 if(r.method==='session/load')result={configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'old',options:[{value:'new',name:'New'}]}]};
 if(r.method==='session/set_config_option') {
  if(r.params.value!=='new')process.exit(5);
  result={configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'new',options:[{value:'new',name:'New'}]}]};
 }
 send({id:r.id,result});
});`);
  const agent = await connectAgent({ cwd: root, command: process.execPath, args: [fake], sessionId: 'existing', model: 'new', onText() {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
  agent.close(); assert.equal(agent.sessionId, 'existing');
});


test('Codex combinations use only advertised efforts, mark defaults and map xhigh for display', () => {
  const models = [{ id: 'fast', name: 'Fast', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'xhigh' }, null] }, { id: 'old', name: 'Older CLI' }];
  const choices = modelChoices('codex', models);
  assert.equal(choices.length, 4);
  assert.deepEqual(choices.map(v => v.effort), ['low', 'medium', 'xhigh', undefined]);
  assert.equal(choices[1].name, 'Fast / Medium（默认）');
  assert.equal(choices[2].name, 'Fast / Extra high');
  assert.equal(choices[3].name, 'Older CLI');
  assert.deepEqual(modelChoices('claude', models), models);
  const cards = new ModelCards();
  const { token, entry } = cards.create({ owner: 'owner', chat: 'chat', key: 'key', provider: 'codex', models });
  entry.messageId = 'card1';
  assert.equal(cards.consume(callback(token, '2'), ['owner']).model.effort, 'xhigh');
});

test('ACP restores model first then reasoning effort using updated configuration options', async t => {
  const root = temp(t), fake = path.join(root, 'effort.mjs'), trace = path.join(root, 'trace.jsonl');
  fs.writeFileSync(fake, `
import fs from 'node:fs';
import readline from 'node:readline';
const send=v=>console.log(JSON.stringify({jsonrpc:'2.0',...v}));
const options=[{id:'model',name:'Model',category:'model',type:'select',currentValue:'new',options:[{value:'new',name:'New'}]},{id:'reasoning_effort',name:'Effort',category:'thought_level',type:'select',currentValue:'medium',options:[{value:'medium',name:'Medium'},{value:'xhigh',name:'Extra high'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); let result={};
 if(r.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true}};
 if(r.method==='session/load')result={configOptions:options.slice(0,1)};
 if(r.method==='session/set_config_option'){
   fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(r.params)+'\\n');
   result={configOptions:options};
 }
 send({id:r.id,result});
});`);
  const agent = await connectAgent({ cwd: root, command: process.execPath, args: [fake], sessionId: 'existing', model: 'new', reasoningEffort: 'xhigh', onText() {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
  agent.close();
  const requests = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.map(v => [v.configId, v.value]), [['model', 'new'], ['reasoning_effort', 'xhigh']]);
});
