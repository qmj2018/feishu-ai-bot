import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Environment, CommandRunner, RuntimeConfig } from './types.js';
import { commandExists, findBot, readRuntimeConfig, run, normalizeHomeEnv } from './core.js';
import { saveJson } from './storage.js';
import { APP_ID } from './identity.js';
import { LEGACY_APP_ID } from './legacy.js';

export type FeishuMode = 'auto' | 'create' | 'existing';
export interface FeishuCredentials { appId: string; appSecret: string; domain: 'feishu' | 'lark' }
interface SetupOptions { slug: string; mode?: FeishuMode; profile?: string; env?: Environment; log?: (text: string) => void }
interface SetupDependencies {
  commandRunner?: CommandRunner; exists?: typeof commandExists;
  ask?: (text: string, secret?: boolean) => Promise<string>;
  loadRuntime?: () => RuntimeConfig | undefined;
  readSecret?: typeof readCliAppSecret;
  configure?: typeof configureFeishuApplication;
  validate?: typeof validateFeishuCredentials;
}

async function question(text: string, secret = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('首次配置需要在交互终端运行 ./deploy.sh，或设置 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_ALLOWED_USERS');
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  if (secret) process.stdout.write(text);
  const terminal = createInterface({ input: process.stdin, output: secret ? silent : process.stdout, terminal: true });
  const controller = new AbortController();
  terminal.once('SIGINT', () => controller.abort());
  try { return (await terminal.question(secret ? '' : text, { signal: controller.signal })).trim(); }
  finally { terminal.close(); if (secret) process.stdout.write('\n'); }
}

function privateFile(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error('凭证文件权限不安全');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// Interoperate with the official CLI's Linux credential format (AES-256-GCM:
// 12-byte nonce, ciphertext, 16-byte tag). Read only this app's App Secret;
// do not read user tokens, rewrite the keychain, or log decrypted values.
// Format: github.com/larksuite/cli/internal/keychain/keychain_other.go (MIT).
export function readCliAppSecret(appId: string, env: Environment): string | undefined {
  try {
    const configDir = env.LARKSUITE_CLI_CONFIG_DIR || path.join(env.HOME!, '.lark-cli');
    const config = JSON.parse(privateFile(path.join(configDir, 'config.json')).toString());
    const app = config.apps?.find((value: { appId?: string }) => value.appId === appId);
    const secret = app?.appSecret;
    if (typeof secret === 'string') return secret && !secret.includes('*') ? secret : undefined;
    if (secret?.source === 'file' && path.isAbsolute(secret.id)) return privateFile(secret.id).toString().trim();
    if (secret?.source !== 'keychain' || secret.id !== `appsecret:${appId}` || process.platform !== 'linux') return;
    const root = env.LARKSUITE_CLI_DATA_DIR ? path.join(env.LARKSUITE_CLI_DATA_DIR, 'lark-cli') : path.join(env.HOME!, '.local/share/lark-cli');
    const key = privateFile(path.join(root, 'master.key'));
    const encrypted = privateFile(path.join(root, secret.id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc'));
    if (key.length !== 32 || encrypted.length < 28) return;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString();
  } catch { return; }
}

async function feishuClient(credentials: FeishuCredentials) {
  const lark = await import('@larksuiteoapi/node-sdk');
  return new lark.Client({ appId: credentials.appId, appSecret: credentials.appSecret,
    domain: credentials.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error, logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
}
export async function validateFeishuCredentials(credentials: FeishuCredentials) {
  try {
    const client = await feishuClient(credentials);
    const result = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info', timeout: 15_000 });
    if (result.code || !result.bot?.open_id) throw new Error('unavailable');
  } catch { throw new Error('飞书机器人校验失败：检查凭证、机器人能力和应用发布状态。原有服务尚未停止。'); }
}

export async function configureFeishuApplication(credentials: FeishuCredentials,
  { api: providedApi, readOnlineVersion: providedRead, env = process.env, listenGroups = false }: {
    api?: Awaited<ReturnType<typeof feishuClient>>['application']['v7'];
    readOnlineVersion?: () => Promise<string | undefined>; env?: Environment; listenGroups?: boolean;
  } = {}) {
  if (!/^cli_[a-zA-Z0-9_-]+$/.test(credentials.appId)) throw new Error('App ID 无效');
  const client = !providedApi || !providedRead ? await feishuClient(credentials) : undefined;
  const api = providedApi || client!.application.v7;
  const appPath = { app_id: credentials.appId };
  const check = (result: { code?: number }) => {
    if (result.code) throw new Error(`飞书应用自动配置未完成 (${result.code})；需要应用管理员开通 application:application:patch、application:application:publish 权限后重试`);
  };
  const readOnline = providedRead || (async () => {
    const result = await client!.application.v6.application.get({ path: appPath, params: { lang: 'zh_cn' } });
    check(result); return result.data?.app?.online_version_id;
  });
  const pending = () => new Error('飞书应用已提交发布，尚未确认该版本上线。请等待管理员审核后重新部署；已有申请和凭证已保留，不会重复创建应用或重复提交审核。');
  const home = normalizeHomeEnv(env).HOME;
  const checkpointName = `${credentials.domain}-${credentials.appId}.json`;
  const checkpoint = path.join(home, '.local', 'share', APP_ID, 'feishu', checkpointName);
  const previousCheckpoint = fs.lstatSync(checkpoint, { throwIfNoEntry: false }) ? checkpoint
    : path.join(home, '.local', 'share', LEGACY_APP_ID, 'feishu', checkpointName);
  const revision = listenGroups ? 'bot-websocket-message-card-group-scopes-v2' : 'bot-websocket-message-card-scopes-v1';
  let saved: { revision?: string; versionId?: string } | undefined;
  try { saved = JSON.parse(privateFile(previousCheckpoint).toString()); } catch {}
  if (saved?.revision === revision && saved.versionId) {
    if (await readOnline() !== saved.versionId) throw pending();
    return;
  }
  check(await api.applicationAbility.patch({ path: appPath, data: { bot: { enable: true } } }));
  check(await api.applicationConfig.patch({ path: appPath, data: {
    scope: { add_scopes: [...[
      'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot', 'im:message.reactions:write_only',
      ...(listenGroups ? ['im:message.group_msg'] : []),
    ].map(scope_name => ({ scope_name, token_type: 'tenant' as const })),
    { scope_name: 'contact:user.base:readonly', token_type: 'user' }] },
    event: { subscription_type: 'websocket', add_events: ['im.message.receive_v1'] },
    callback: { callback_type: 'websocket', add_callbacks: ['card.action.trigger'] },
  } }));
  const published = await api.applicationPublish.create({ path: appPath, data: {
    mobile_default_ability: 'bot', pc_default_ability: 'bot', remark: 'Feishu AI Bot 初始化',
    changelog: '配置 Feishu AI Bot 机器人能力、消息权限、长连接消息事件和模型选择卡片回调。',
  } });
  check(published);
  if (!published.data?.version_id) throw new Error('飞书发布接口没有返回版本 ID，无法确认应用上线');
  saveJson(checkpoint, { revision, versionId: published.data.version_id });
  if (await readOnline() !== published.data.version_id) throw pending();
}

function allowedUsers(value?: string) {
  const users = [...new Set((value || '').split(',').map(x => x.trim()).filter(Boolean))];
  if (users.some(id => !/^ou_[a-zA-Z0-9_-]+$/.test(id))) throw new Error('飞书白名单必须使用 ou_ 开头的 open_id');
  return users;
}
function credentialsEnv(env: Environment, credentials: FeishuCredentials, users: string[]): Environment {
  return { ...env, FEISHU_APP_ID: credentials.appId, FEISHU_APP_SECRET: credentials.appSecret,
    FEISHU_DOMAIN: credentials.domain, FEISHU_ALLOWED_USERS: users.join(',') };
}

export async function prepareFeishu({ slug, mode = 'auto', profile, env: inputEnv = process.env, log = console.log }: SetupOptions,
  { commandRunner = run, exists = commandExists, ask = question, readSecret = readCliAppSecret,
    configure = configureFeishuApplication, validate = validateFeishuCredentials, loadRuntime }: SetupDependencies = {}): Promise<Environment> {
  if (!['auto', 'create', 'existing'].includes(mode)) throw new Error('--feishu-mode 必须为 auto、create 或 existing');
  let env: Environment = { ...normalizeHomeEnv(inputEnv), LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
  const runtime = loadRuntime ? loadRuntime() : (() => { const bot = findBot(slug, { env }); return bot ? readRuntimeConfig(bot, env) : undefined; })();
  const local = runtime?.feishu;
  // Existing ai-bot configuration is checked again by the real SDK on startup.
  // Re-deployment never needs the CLI, new app creation, or another user login.
  if (mode !== 'create' && !profile && !env.FEISHU_APP_ID && !env.FEISHU_APP_SECRET && local?.appId && local.appSecret) {
    const users = allowedUsers(env.FEISHU_ALLOWED_USERS || local.allowedUsers?.join(','));
    if (users.length) { log('OK  复用本地飞书机器人配置和白名单，启动时验证连接。'); return credentialsEnv(env, {
      appId: local.appId, appSecret: local.appSecret, domain: local.domain === 'lark' ? 'lark' : 'feishu',
    }, users); }
  }
  if (mode !== 'create' && env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && allowedUsers(env.FEISHU_ALLOWED_USERS).length) {
    const credentials: FeishuCredentials = { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, domain: env.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu' };
    await validate(credentials); return credentialsEnv(env, credentials, allowedUsers(env.FEISHU_ALLOWED_USERS));
  }
  if (mode === 'auto') {
    const answer = await ask('未找到可直接复用的机器人配置：1) 申请新机器人  2) 使用已有应用并配置为机器人  0) 取消 [2]：');
    if (answer === '0') throw new Error('已取消部署，未申请飞书应用');
    if (!['', '1', '2'].includes(answer)) throw new Error('请选择 1、2 或 0 后重新执行部署');
    mode = answer === '1' ? 'create' : 'existing';
  }
  let cli = 'lark-cli';
  const probe = exists(cli, env) ? commandRunner(cli, ['--version'], { env, allowFailure: true }) : undefined;
  if (probe?.status !== 0) {
    const prefix = path.join(env.HOME!, '.local', 'share', APP_ID, 'lark-cli');
    cli = path.join(prefix, 'node_modules/.bin/lark-cli');
    const previousCli = path.join(env.HOME!, '.local', 'share', LEGACY_APP_ID, 'lark-cli/node_modules/.bin/lark-cli');
    if ((!exists(cli, env) || commandRunner(cli, ['--version'], { env, allowFailure: true }).status !== 0)
      && exists(previousCli, env) && commandRunner(previousCli, ['--version'], { env, allowFailure: true }).status === 0) cli = previousCli;
    if (!exists(cli, env) || commandRunner(cli, ['--version'], { env, allowFailure: true }).status !== 0) {
      log('安装缺失的飞书官方 CLI。');
      commandRunner('npm', ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '@larksuite/cli@1.0.100'], { env, inherit: true });
    }
    if (commandRunner(cli, ['--version'], { env, allowFailure: true }).status !== 0) throw new Error('飞书 CLI 安装校验失败');
  } else log('OK  复用本机飞书 CLI。');
  let selected = profile;
  const invoke = (args: string[], { input, inherit = false, optional = false }: { input?: string; inherit?: boolean; optional?: boolean } = {}) => {
    const result = commandRunner(cli, selected ? ['--profile', selected, ...args] : args, { env, input, inherit, allowFailure: true });
    if (result.status !== 0 && !optional) throw new Error(`飞书配置步骤未完成：${args.slice(0, 2).join(' ')}。请完成浏览器确认后重试；现有机器人未停止。`);
    return result;
  };
  const parse = (text: string) => { try { const result = JSON.parse(text); return result.data || result; } catch { return {}; } };
  const appConfig = () => parse(invoke(['config', 'show'], { optional: true }).stdout);
  if (mode === 'create') {
    const name = selected || `ai-bot-${slug}`;
    selected = name;
    const registered = appConfig();
    // --new is used only after explicit selection/flag; a named profile avoids
    // replacing unrelated CLI apps. The official flow presents the browser URL.
    if (registered.appId) log('复用此前为当前机器人申请的应用，不重复创建。');
    else {
      const result = commandRunner(cli, ['config', 'init', '--new', '--name', name], { env, inherit: true, allowFailure: true });
      if (result.status !== 0) throw new Error('飞书新应用申请未完成，未启动机器人；请完成浏览器确认后重试');
    }
  }
  let app = appConfig();
  let appId = env.FEISHU_APP_ID || app.appId;
  let appSecret = env.FEISHU_APP_SECRET || (appId ? readSecret(appId, env) : undefined);
  if (!appId) appId = await ask('已有应用 App ID：');
  if (!/^cli_[a-zA-Z0-9_-]+$/.test(appId || '')) throw new Error('App ID 应以 cli_ 开头');
  if (!appSecret) appSecret = await ask('App Secret（输入不回显）：', true);
  if (!appSecret || /\*{3,}|[\r\n\0]/.test(appSecret)) throw new Error('App Secret 缺失或为掩码，拒绝使用');
  const credentials: FeishuCredentials = { appId, appSecret, domain: (env.FEISHU_DOMAIN || app.brand) === 'lark' ? 'lark' : 'feishu' };
  if (app.appId !== appId) {
    const name = selected || `ai-bot-${slug}`;
    const result = commandRunner(cli, ['config', 'init', '--name', name, '--app-id', appId, '--brand', credentials.domain, '--app-secret-stdin'], { env, input: appSecret + '\n', allowFailure: true });
    if (result.status !== 0) throw new Error('已有应用绑定失败，请检查 App ID 和 App Secret');
    selected = name; app = appConfig();
  }
  log('配置机器人能力、消息权限、长连接事件和卡片回调，并提交应用发布。');
  await configure(credentials, { env });
  log('飞书应用已确认上线。');
  await validate(credentials);
  let users = allowedUsers(env.FEISHU_ALLOWED_USERS);
  if (!users.length) {
    const userId = () => {
      const status = parse(invoke(['auth', 'status', '--json', '--verify'], { optional: true }).stdout);
      return status.appId === appId && status.identities?.user?.available ? status.identities.user.openId : undefined;
    };
    let owner = userId();
    if (!owner) { log('请完成已有飞书账号登录，用于确认机器人使用者并建立白名单。'); invoke(['auth', 'login', '--scope', 'contact:user.base:readonly'], { inherit: true }); owner = userId(); }
    users = allowedUsers(owner);
    if (!users.length) throw new Error('飞书登录未返回当前应用的用户 open_id，无法建立白名单');
  }
  return credentialsEnv(env, credentials, users);
}
