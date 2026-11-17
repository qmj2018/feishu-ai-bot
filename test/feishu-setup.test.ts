import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { prepareFeishu, readCliAppSecret, configureFeishuApplication } from '../src/feishu-setup.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-onboarding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function fixture(t) {
  const home = temporary(t), calls = [], logs = [], secrets = [];
  const env = { HOME: home, PATH: process.env.PATH };
  let loggedIn = true, installed = true, created = false;
  const appId = 'cli_test_app';
  const dependencies = {
    loadRuntime: () => undefined,
    exists: () => installed,
    readSecret: () => 'private-app-secret',
    ask: async () => { throw new Error('unexpected prompt'); },
    configure: async credentials => { calls.push({ tool: 'configure', appId: credentials.appId }); },
    validate: async credentials => { calls.push({ tool: 'validate', appId: credentials.appId }); },
    commandRunner: (tool, args, options) => {
      calls.push({ tool, args, input: options?.input });
      if (tool === 'npm') { installed = true; return { status: 0, stdout: '' }; }
      if (args.includes('--version')) return { status: installed ? 0 : 1, stdout: 'lark-cli 1.0.92' };
      if (args.includes('--new')) created = true;
      if (args.includes('show')) return args.includes('ai-bot-test') && !created
        ? { status: 1, stdout: '' } : { status: 0, stdout: JSON.stringify({ appId, appSecret: '********', brand: 'feishu' }) };
      if (args.includes('status')) return { status: 0, stdout: JSON.stringify({ appId,
        identities: { user: { available: loggedIn, openId: loggedIn ? 'ou_owner' : undefined } } }) };
      if (args.includes('login')) loggedIn = true;
      return { status: 0, stdout: '' };
    },
  };
  return { env, calls, logs, secrets, dependencies, options: { slug: 'test', env, log: text => logs.push(text) },
    logout: () => { loggedIn = false; }, uninstall: () => { installed = false; } };
}

test('complete local bot configuration is reused without installs, new apps, or user login', async t => {
  const f = fixture(t);
  f.dependencies.loadRuntime = () => ({ feishu: { appId: 'cli_local', appSecret: 'local-secret', allowedUsers: ['ou_local'] } });
  const result = await prepareFeishu(f.options, f.dependencies);
  assert.equal(result.FEISHU_APP_ID, 'cli_local'); assert.equal(result.FEISHU_ALLOWED_USERS, 'ou_local');
  assert.deepEqual(f.calls, []); assert.ok(!f.logs.join('').includes('local-secret'));
});

test('retrying a previously created app does not submit a second app creation request', async t => {
  const f = fixture(t);
  await prepareFeishu({ ...f.options, mode: 'create' }, f.dependencies);
  await prepareFeishu({ ...f.options, mode: 'create' }, f.dependencies);
  assert.equal(f.calls.filter(call => call.args?.includes('--new')).length, 1);
});

test('application setup adds required capabilities and confirms the published version before continuing', async t => {
  const calls = [];
  const api: any = {
    applicationAbility: { patch: async value => { calls.push({ type: 'ability', value }); return { code: 0 }; } },
    applicationConfig: { patch: async value => { calls.push({ type: 'config', value }); return { code: 0 }; } },
    applicationPublish: { create: async value => { calls.push({ type: 'publish', value }); return { code: 0, data: { version_id: 'v1' } }; } },
  };
  await configureFeishuApplication({ appId: 'cli_test', appSecret: 'secret', domain: 'feishu' }, {
    api, env: { HOME: temporary(t) }, readOnlineVersion: async () => 'v1',
  });
  assert.deepEqual(calls.map(x => x.type), ['ability', 'config', 'publish']);
  assert.deepEqual(calls[0].value.data, { bot: { enable: true } });
  const config = calls[1].value.data;
  assert.deepEqual(config.event, { subscription_type: 'websocket', add_events: ['im.message.receive_v1'] });
  assert.deepEqual(config.callback, { callback_type: 'websocket', add_callbacks: ['card.action.trigger'] });
  assert.equal(config.scope.add_scopes.length, 5);
  assert.equal(config.scope.remove_scopes, undefined); assert.equal(config.visibility, undefined);
});

test('pending publication is retained and retried without creating a new version', async t => {
  const calls = [], env = { HOME: temporary(t) };
  let online = 'older';
  const api: any = {
    applicationAbility: { patch: async () => ({ code: 0 }) },
    applicationConfig: { patch: async () => ({ code: 0 }) },
    applicationPublish: { create: async () => { calls.push('publish'); return { code: 0, data: { version_id: 'new' } }; } },
  };
  const credentials = { appId: 'cli_pending', appSecret: 'secret', domain: 'feishu' as const };
  const options = { api, env, readOnlineVersion: async () => online };
  await assert.rejects(configureFeishuApplication(credentials, options), /等待管理员审核/);
  await assert.rejects(configureFeishuApplication(credentials, options), /等待管理员审核/);
  online = 'new'; await configureFeishuApplication(credentials, options);
  assert.deepEqual(calls, ['publish']);
});

test('group-wide message permission is opt-in and submitted through the normal publication flow', async t => {
  const configs = [];
  const api: any = {
    applicationAbility: { patch: async () => ({ code: 0 }) },
    applicationConfig: { patch: async value => { configs.push(value); return { code: 0 }; } },
    applicationPublish: { create: async () => ({ code: 0, data: { version_id: 'group-version' } }) },
  };
  await configureFeishuApplication({ appId: 'cli_groups', appSecret: 'secret', domain: 'feishu' }, {
    api, listenGroups: true, env: { HOME: temporary(t) }, readOnlineVersion: async () => 'group-version',
  });
  assert.ok(configs[0].data.scope.add_scopes.some(scope => scope.scope_name === 'im:message.group_msg' && scope.token_type === 'tenant'));
  assert.equal(configs[0].data.visibility, undefined);
});
test('environment credentials are validated and can be used non-interactively', async t => {
  const f = fixture(t);
  const result = await prepareFeishu({ ...f.options, env: { ...f.env, FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'env-secret', FEISHU_ALLOWED_USERS: 'ou_env' } }, f.dependencies);
  assert.equal(result.FEISHU_APP_ID, 'cli_env'); assert.deepEqual(f.calls, [{ tool: 'validate', appId: 'cli_env' }]);
});
test('canceling the first-time choice never installs tools or creates a remote app', async t => {
  const f = fixture(t);
  await assert.rejects(prepareFeishu(f.options, { ...f.dependencies, ask: async () => '0' }), /已取消/);
  assert.deepEqual(f.calls, []);
});
test('new app creation only follows an explicit choice and uses a separate named profile', async t => {
  const f = fixture(t); f.logout();
  const result = await prepareFeishu(f.options, { ...f.dependencies, ask: async () => '1' });
  const creation = f.calls.filter(call => call.args?.includes('--new'));
  assert.equal(creation.length, 1); assert.ok(creation[0].args.includes('ai-bot-test'));
  assert.equal(f.calls.filter(call => call.args?.includes('login')).length, 1);
  assert.equal(result.FEISHU_ALLOWED_USERS, 'ou_owner');
  assert.ok(f.calls.some(call => call.tool === 'configure'));
  assert.ok(!f.logs.join('').includes('private-app-secret'));
});
test('existing app login reuses the installed CLI and never starts the app creation flow', async t => {
  const f = fixture(t);
  const result = await prepareFeishu({ ...f.options, mode: 'existing' }, f.dependencies);
  assert.equal(result.FEISHU_APP_SECRET, 'private-app-secret'); assert.equal(result.FEISHU_ALLOWED_USERS, 'ou_owner');
  assert.ok(!f.calls.some(call => call.tool === 'npm' || call.args?.includes('--new') || call.args?.includes('login')));
});
test('missing CLI is installed once and then used for the selected existing app', async t => {
  const f = fixture(t); f.uninstall();
  await prepareFeishu({ ...f.options, mode: 'existing' }, f.dependencies);
  assert.equal(f.calls.filter(call => call.tool === 'npm').length, 1);
  assert.ok(f.calls.find(call => call.tool === 'npm').args.includes('--registry=https://registry.npmjs.org/'));
});
test('a different application user identity cannot become this bot whitelist', async t => {
  const f = fixture(t), original = f.dependencies.commandRunner;
  f.dependencies.commandRunner = (tool, args, options) => args.includes('status')
    ? { status: 0, stdout: JSON.stringify({ appId: 'cli_other', identities: { user: { available: true, openId: 'ou_other' } } }) }
    : original(tool, args, options);
  await assert.rejects(prepareFeishu({ ...f.options, mode: 'existing' }, f.dependencies), /open_id/);
});
test('masked secrets are rejected instead of being persisted or used', async t => {
  const f = fixture(t);
  await assert.rejects(prepareFeishu({ ...f.options, mode: 'existing' }, {
    ...f.dependencies, readSecret: () => undefined, ask: async (_text, hidden) => { assert.equal(hidden, true); return '********'; },
  }), /掩码/);
  assert.ok(!f.calls.some(call => call.tool === 'configure' || call.tool === 'validate'));
});
test('new app registration failures stop without configuring or validating any app', async t => {
  const f = fixture(t), original = f.dependencies.commandRunner;
  f.dependencies.commandRunner = (tool, args, options) => args.includes('--new') ? { status: 1, stdout: '' } : original(tool, args, options);
  await assert.rejects(prepareFeishu({ ...f.options, mode: 'create' }, f.dependencies), /申请未完成/);
  assert.ok(!f.calls.some(call => call.tool === 'configure' || call.tool === 'validate'));
});

test('official Linux keychain credentials are reused without exposing user tokens or changing files', { skip: process.platform !== 'linux' }, t => {
  const home = temporary(t), appId = 'cli_test_app';
  const config = path.join(home, '.lark-cli'), storage = path.join(home, '.local/share/lark-cli');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 }); fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ apps: [{ appId, appSecret: { source: 'keychain', id: `appsecret:${appId}` } }] }), { mode: 0o600 });
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([nonce, cipher.update('test-secret'), cipher.final(), cipher.getAuthTag()]);
  fs.writeFileSync(path.join(storage, 'master.key'), key, { mode: 0o600 });
  const secretFile = path.join(storage, `appsecret_${appId}.enc`);
  fs.writeFileSync(secretFile, encrypted, { mode: 0o600 });
  assert.equal(readCliAppSecret(appId, { HOME: home }), 'test-secret');
  assert.equal(readCliAppSecret('cli_other', { HOME: home }), undefined);
  assert.deepEqual(fs.readFileSync(secretFile), encrypted);
  fs.chmodSync(secretFile, 0o644);
  assert.equal(readCliAppSecret(appId, { HOME: home }), undefined);
});
